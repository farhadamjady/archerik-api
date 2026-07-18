# Cartograph UI ↔ Backend API Contract

APIs the UI needs from the backend microservice. Shapes mirror what the UI already binds to
(`buildModel`, `buildContracts`, `buildCommits`, `answerQuestion` in `Architecture Graph.dc.html`) so
wiring is a drop-in replacement of the mock builders.

Conventions:

- Base path `/api/v1`, JSON everywhere.
- Enums are lowercase exact strings: `confidence: confirmed|likely|uncertain`,
  `protocol: rest|kafka`, node `type: service|external|unknown`.
- **Invariant (do not violate on the backend either):** unresolved/uncertain things are never
  dropped — an unresolvable call target still becomes a node with `type: "unknown"` and a
  human-readable `note` explaining *why* it couldn't be resolved.
- All responses that describe scan output should carry `repo`, `branch`, `scannedAt` (ISO-8601) so
  the UI can show freshness.
- **The UI validates payloads strictly and fails loudly.** An unknown enum value (confidence,
  protocol, node type) or an edge whose `from`/`to` doesn't match a node `id` makes the whole load
  fail into an error overlay — nothing is silently coerced or dropped. Send exactly the enums above.
- Auth: every request carries `Authorization: Bearer <token>` once logged in. Any endpoint may
  return `401` — the UI treats that globally as "session expired", clears the token, and shows the
  login screen.
- **Read model scope (account = the company):** the read endpoints (`/graph`, `/contracts`,
  `/commits`) are scoped to the **account** the logged-in user belongs to — derived from the session
  token, never a query param. After login the UI needs no repo to start: `GET /graph` with no params
  returns the account's **entire** architecture (the union of every service the extractor has
  ingested for that account, across all repos), projected into one current-head graph per
  `(account, branch)`. `repo` and `service` are **optional filters** that narrow that graph, not
  required keys. Each service node carries its `repo` so the UI can group/filter client-side too.
- **Executable reference:** `dev-server.mjs` in this repo implements this entire contract over the
  demo dataset (`node dev-server.mjs`, endpoints on `http://localhost:8787/api/v1`). When in doubt
  about a shape, diff against what it returns.

---

## P0 — required to replace the mock data

### 1. `GET /api/v1/graph` (optional `?repo=…&service=…&branch=main`)

The whole account graph in one payload (current scale ~92 nodes / ~189 edges — no pagination
needed; the UI lays out and filters client-side). **All query params are optional** — with none, you
get everything the account owns. `repo` subsets to one repository; `service` focuses one service and
its immediate neighbours; `branch` defaults to `main`. The envelope's `repo` echoes the applied
filter, or is `null` when the whole account is returned. Each `service` node includes a `repo` field
(null for `external`/`unknown` nodes).

A **fresh account with no scans yet** returns `200` with an **empty graph**
(`{ "repo": null, "branch": "main", "scannedAt": null, "teams": [], "nodes": [], "edges": [] }`) —
not a 404. Note `scannedAt` is `null` in that case. `/contracts` and `/commits` likewise return
`200` with empty payloads (`{ "endpoints": [], "topics": [] }` and `[]`). Render a "no scans yet"
empty state rather than an error.

```jsonc
{
  "repo": "acme/shop-platform",
  "branch": "main",
  "scannedAt": "2026-07-13T14:02:11Z",
  "teams": [
    // tier (0-3) drives the Layered layout: 0=edge/BFF, 1=checkout, 2=core, 3=data/support.
    // hue is optional; if omitted the UI assigns display hues itself.
    { "id": "payments", "name": "Payments", "tier": 2, "hue": 150 }
  ],
  "nodes": [
    // service nodes carry `repo` (and `language` when known); external/unknown carry repo: null
    { "id": "PaymentService", "name": "PaymentService", "team": "payments", "type": "service", "note": null, "repo": "acme/shop-platform", "language": "Java" },
    { "id": "StripeAPI", "name": "StripeAPI", "team": "external", "type": "external", "note": null, "repo": null },
    {
      "id": "legacy-oms (unresolved)", "name": "legacy-oms (unresolved)", "team": "unknown", "type": "unknown",
      "note": "RestTemplate call to a hostname with no matching Spring Boot service in scan scope.", "repo": null
    }
  ],
  "edges": [
    {
      "id": "e42",
      "from": "CheckoutOrchestrator",
      "to": "PaymentService",
      "protocol": "rest",                  // rest | kafka
      "method": "FeignClient",             // FeignClient | WebClient | RestTemplate | route | @KafkaListener
      "confidence": "confirmed",           // confirmed | likely | uncertain
      "label": "POST /payments"            // endpoint for rest, topic name for kafka
    }
  ]
}
```

Notes:

- `deg/inDeg/outDeg` are computed client-side — don't send them.
- Kafka edges are producer → consumer, one edge per consumer, `label` = topic name.
- `confidence` semantics: `confirmed` = declared in code (`@FeignClient`, `KafkaTemplate` +
  registered schema); `likely` = inferred (config-resolved URL, `WebClient`); `uncertain` = guess
  (runtime variable host, no producer found).

### 2. `GET /api/v1/contracts` (optional `?repo=&service=&branch=&protocol=`)

Field-level schemas can't be derived by the UI — the backend owns these. Account-scoped like
`/graph`; with no params returns every contract the account owns. `repo`/`service` narrow to that
repo's / service's contracts; `protocol` (`rest`|`kafka`) filters by kind.

```jsonc
{
  "endpoints": [
    {
      "id": "ep12",
      "kind": "rest",
      "service": "PaymentService",
      "verb": "POST",
      "path": "/payments",
      "source": "in-code DTO (Feign)",     // free text: "OpenAPI spec", "in-code (shape unresolved)", ...
      "confidence": "confirmed",           // promote to confirmed if ANY caller edge is confirmed
      "method": "FeignClient",
      "unresolved": false,                 // true → UI shows the amber best-effort warning
      "callers": ["CheckoutOrchestrator"], // derived from callers' code — UI labels them "derived"
      "request": [                         // [] for GET
        { "name": "orderId", "type": "string", "nullable": false, "note": null },
        { "name": "couponCode", "type": "string", "nullable": true, "note": "added in c98d0aa" }
      ],
      "response": [ /* same field shape */ ]
    }
  ],
  "topics": [
    {
      "id": "tp3",
      "kind": "kafka",
      "topic": "OrderCreated",
      "producer": "OrderService",          // null when no producer found in scan scope
      "source": "Schema Registry (Avro)",  // "no registered schema" when producer is null
      "confidence": "confirmed",           // uncertain when producer is null
      "consumers": ["InventoryService", "NotificationService"],
      "message": [ /* same field shape as request/response */ ]
    }
  ]
}
```

Field `note` is optional provenance text (e.g. `"added in c98d0aa"`) — the UI renders it verbatim.

### 3. `GET /api/v1/commits` (optional `?branch=&limit=20`)

Architecture-relevant commits with their graph diffs. Account-scoped like `/graph`. **Currently
returns `[]`** — the extractor doesn't send commit metadata yet, so no diffs are projected.

```jsonc
[
  {
    "sha": "a3f19c2",
    "author": { "name": "Priya Nair", "handle": "priyan" },  // initials/hue optional; UI can derive
    "message": "checkout: apply basket-level promotions",
    "when": "2026-07-13T12:00:00Z",       // ISO timestamp; UI renders relative time
    "pr": "#1847",
    "branch": "feat/basket-promos",
    "changes": [
      {
        "op": "add",                       // add | remove | change | confidence
        "kind": "dependency",              // dependency | endpoint | topic | schema | confidence
        "from": "CheckoutOrchestrator",
        "to": "PromotionService",          // null for endpoint/topic/schema changes
        "protocol": "rest",
        "confidence": "likely",
        "contract": "POST /promotions/apply", // links the change to a contract (chip in UI)
        "detail": "New WebClient call — target resolved from a base-URL property, so recorded as likely."
      }
    ]
  }
]
```

`detail` must stay **factual** — the tool makes no breaking-change/severity judgments; that copy
ends up verbatim in the UI and in the generated PR comment.

---

## P1 — fully wired in the UI (dev-server.mjs stands in until the real backend exists)

### 4. `POST /api/v1/ask`

Grounded Q&A. The backend must compute answers from the graph (never invent edges) and return the
evidence. A failed/unreachable ask renders as an explicit "no answer" error bubble in the UI —
never a silent drop, never an ungrounded guess. A cite with an unrecognized `confidence` value is
displayed as *uncertain*, never stronger.

Request: `{ "question": "what depends on PaymentService?", "model": "claude" }`

```jsonc
{
  "text": "12 dependencies point at PaymentService — 9 confirmed, 2 likely, 1 uncertain. These are derived from callers' code, not declared by PaymentService.",
  "cites": [                               // evidence edges shown in the Evidence panel
    { "name": "CheckoutOrchestrator", "confidence": "confirmed", "dir": "FeignClient" }
  ],
  "note": "3 of these rest on likely/uncertain edges — treat the list as indicative, not exhaustive.", // or null
  "model": "claude-sonnet-4-5"             // echoed into the "grounded in graph · <model>" header
}
```

### 5. `GET /api/v1/models`

`[ { "id": "claude", "label": "Claude Sonnet 4.5" }, ... ]` — feeds the Ask model selector.
Non-fatal for the UI: if this fails, it falls back to a built-in list. The `id` chosen by the user
is what arrives in `POST /ask` as `model`.

### 6. Auth (bearer token — this is what the UI implements)

- `POST /api/v1/auth/login` — request `{ "email": "...", "password": "..." }`.
  - `200` → `{ "token": "<opaque or JWT>", "user": { "name": "...", "handle": "...", "team": "..." } }`
  - `401` → shown as "Invalid credentials." Any other non-200 → generic login error with status.
  - The UI stores the token in `sessionStorage` under `cartograph.token` and sends
    `Authorization: Bearer <token>` on every subsequent request.
- `GET /api/v1/me` — `200` → `{ "name": "...", "handle": "...", "team": "..." }`; `401` if the
  token is missing/expired. Called on app boot when a stored token exists (session restore) —
  feeds the sidebar user chip.
- `POST /api/v1/auth/logout` — invalidate the token server-side; response body ignored
  (best-effort fire-and-forget from the UI).
- `GET /api/v1/auth/sso` — full-page browser redirect target (not fetch). After the IdP dance,
  the backend must land the browser back on the app with a valid token the UI can pick up —
  simplest compatible option: redirect to `<app-url>` after setting `cartograph.token` via a
  page that writes `sessionStorage` (see the stub in `dev-server.mjs`), or agree on a
  `#token=<...>` fragment and we'll add the few lines of UI to read it.

Token format is the backend's choice (opaque vs JWT) — the UI never introspects it.

---

## P2 — blocked on product requirements (Settings page is a stub)

Provisional, don't build until the Settings scope is decided:

- `GET/PUT /api/v1/settings/scan-scope` — which repos/paths are scanned
- `GET/POST/DELETE /api/v1/settings/repositories` — repository connections
- `GET/PUT /api/v1/settings/ownership` — team ↔ service mapping
- `GET/PUT /api/v1/settings/pr-comments` — cartograph-bot PR-comment behaviour
- `POST /api/v1/scan` — trigger a rescan (returns job id); `GET /api/v1/scan/{id}` for status

---

## Not needed from the backend

- Graph layout, pan/zoom, filtering, degree counts — all client-side.
- PR-comment markdown rendering — generated client-side (`prComment`); the backend only needs the
  commits/changes data above. (Actually *posting* the comment to GitHub is a backend concern but
  not a UI-facing API.)
