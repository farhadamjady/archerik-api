# Read API Contract (`/api/v1`) — backend → UI

The wire contract for the **read** side of the service: everything a client needs to render the
catalog, ask questions about it, and manage account settings. This is the authoritative document for
these shapes — where it disagrees with any other file, it wins, because clients validate against it
and fail loudly.

The **write** side that scanners submit to is a different base path, a different credential, and a
different document — see [`INGEST-CONTRACT.md`](./INGEST-CONTRACT.md).

Sections are numbered and referenced from code comments; keep the numbering stable.

Conventions:

- Base path `/api/v1`, JSON everywhere.
- Enums are lowercase exact strings: `confidence: confirmed|likely|uncertain`,
  `protocol: rest|kafka|grpc|websocket|unknown`, node `type: service|external|unknown`. Edge/endpoint
  `method` is the deliberate exception — a **free display string**, never validated.
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
- **Every non-2xx body is `{ "error": "<string>" }` — always, with no other keys.** That includes
  errors no one wrote by hand: request-validation failures and rate-limit rejections are normalised
  into the same shape (`src/common/error-body.filter.ts`), so the UI can render `error` verbatim on
  any failure without a fallback. Unexpected server errors return a generic string; details stay in
  the server log.
- **Read model scope (account = the company):** the read endpoints (`/graph`, `/contracts`,
  `/commits`) are scoped to the **account** the logged-in user belongs to — derived from the session
  token, never a query param. After login the UI needs no repo to start: `GET /graph` with no params
  returns the account's **entire** architecture (the union of every service the extractor has
  ingested for that account, across all repos), projected into one current-head graph per
  `(account, branch)`. `repo` and `service` are **optional filters** that narrow that graph, not
  required keys. Each service node carries its `repo` so the UI can group/filter client-side too.
- **Executable reference:** run the backend against the seed (`npx prisma db seed && npm run
  start:dev`) and diff against what it actually returns. `test/contract.e2e-spec.ts` asserts these
  shapes against live HTTP responses, so the suite is the machine-checked version of this document.

---

## P0 — the catalog

### 1. `GET /api/v1/graph` (optional `?repo=…&service=…&branch=main`)

The whole account graph in one payload (current scale ~92 nodes / ~189 edges — no pagination
needed; the UI lays out and filters client-side). **All query params are optional** — with none, you
get everything the account owns. `repo` focuses one repository; `service` focuses one service;
`branch` defaults to `main`. The envelope's `repo` echoes the applied filter, or is `null` when the
whole account is returned. Each `service` node includes a `repo` field (null for `external`/`unknown`
nodes).

**A filter focuses, it does not truncate.** Either filter returns the selected services **plus their
immediate (1-hop) neighbours** and the edges between them, so a repo is shown in context rather than
in isolation. That also keeps the payload internally valid: an edge from a focused service to one in
another repo needs both endpoints present, or the response would violate the edge→node rule above.
So a `?repo=` response can legitimately contain service nodes whose `repo` is something else — they
are the things the focused repo talks to.

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

## P1 — implemented

### 4. `POST /api/v1/ask`

Grounded Q&A. The backend must compute answers from the graph (never invent edges) and return the
evidence. A failed/unreachable ask renders as an explicit "no answer" error bubble in the UI —
never a silent drop, never an ungrounded guess. A cite with an unrecognized `confidence` value is
displayed as *uncertain*, never stronger.

Request: `{ "question": "what depends on PaymentService?", "model": "claude" }` — the LLM key is
**never** in this request; the backend uses the account's stored provider key (§7).

```jsonc
{
  "text": "12 dependencies point at PaymentService — 9 confirmed, 2 likely, 1 uncertain. These are derived from callers' code, not declared by PaymentService.",
  "cites": [                               // evidence edges shown in the Evidence panel
    { "name": "CheckoutOrchestrator", "confidence": "confirmed", "dir": "FeignClient" }
  ],
  "note": "3 of these rest on likely/uncertain edges — treat the list as indicative, not exhaustive.", // or null
  "model": "claude-opus-5"                 // echoed into the "grounded in graph · <model>" header
}
```

**Errors** — all carry `{ "error": "..." }`, shown verbatim in the "no answer" bubble:

| Status | When |
|---|---|
| `409` | No key configured for the chosen model's provider — e.g. `no API key configured for anthropic`. The UI points the user at Settings → LLM. |
| `429` | The provider rate-limited the request, **or** this backend did (20 requests/minute per client). |
| `502` | The provider rejected the stored key, or declined to answer. |
| `503` | The provider is unavailable. |
| `504` | The provider timed out. |

**How grounding is enforced.** The model reaches the graph only through read-only catalog tools;
it is never handed a raw dump. Every relationship a tool returns is recorded in a per-request
evidence ledger with an id, the model names the ids it used, and the backend renders `cites` from
the recorded rows — so a citation the model invented resolves to nothing and is dropped. `text`
comes from the model; `cites` and `note` are computed by the backend (`note` from the confidence
mix of the cites, so it stays factual rather than a judgment). A provider failure is never turned
into an answer.

### 5. `GET /api/v1/models`

Feeds the Ask model selector. Non-fatal for the UI: if this fails, it falls back to a built-in
list. The `id` chosen by the user is what arrives in `POST /ask` as `model`.

```jsonc
[
  { "id": "claude", "label": "Claude Opus 5", "vendor": "Anthropic API", "provider": "anthropic" },
  { "id": "gpt",    "label": "GPT-4o",        "vendor": "OpenAI API",    "provider": "openai" }
]
```

`provider` (enum: `anthropic | openai`, matching §7) lets the UI cross-reference
`GET /settings/llm-keys` and flag models whose provider has no key ("needs key"); the picker still
shows them. A model without a `provider` would be treated as always-available — so every model the
backend serves carries one, since none can answer without a key.

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
- **SSO (real OIDC)**: SSO is multi-tenant — each account brings its own IdP, routed by email
  domain — so it is a two-step flow rather than a single link:
  1. `POST /api/v1/auth/sso/start` — request `{ "email": "..." }`.
     `200` → `{ "sso": true, "redirectUrl": "..." }` if the email's domain has SSO configured — the
     UI does a full-page navigation (`location.href = redirectUrl`) to start the IdP dance.
     `200` → `{ "sso": false }` if the domain has no SSO connection (or it's disabled) — same shape
     either way, so the UI can't distinguish "no SSO" from "disabled" (deliberate, matches the
     login form's existing "generic invalid credentials" stance — no account enumeration).
     Falls back to the password form in the `{ "sso": false }` case.
  2. `GET /api/v1/auth/sso/callback` — the IdP redirects the browser here directly; the UI never
     calls this. On success it's still a full-page navigation that lands the browser back on the
     app with `cartograph.token` written to `sessionStorage`, same as before. On failure it
     redirects to `<app-url>?sso_error=1` instead of a token — the UI should check for that query
     param on boot and show a generic "sign-in failed" message.

Token format is the backend's choice (opaque vs JWT) — the UI never introspects it.

### 7. LLM provider keys (Settings → LLM)

Bring-your-own-key for the Ask tab. Keys are **server-stored, encrypted at rest, and
account-scoped** — every member of an account shares one set, and the raw key is **never returned
by any endpoint**. `provider` is a lowercase enum: `anthropic | openai`; anything else is rejected
and never stored. Writes are not gated to admins (there is no role model on `User`).

**`GET /api/v1/settings/llm-keys`** — one entry per provider, configured or not:

```jsonc
[
  { "provider": "anthropic", "configured": true,  "last4": "a1b2", "updatedAt": "2026-08-06T14:02:11Z" },
  { "provider": "openai",    "configured": false }
]
```

`last4` / `updatedAt` appear **only** when `configured: true`. This endpoint never decrypts
anything — `last4` is stored alongside the ciphertext for exactly this reason.

**`PUT /api/v1/settings/llm-keys`** — request `{ "provider": "anthropic", "apiKey": "sk-ant-…" }`.

- `200` → the same status-entry shape as above, reflecting the new key (never echoes it).
- `400 { "error": "…" }` → empty/malformed key, **or** the provider rejected it. The key is
  verified against the provider before storing (an auth-only call that spends no tokens), so a typo
  is reported here rather than surfacing later as a failed Ask.
- `422 { "error": "unknown provider" }` → not in the enum.
- `503 { "error": "…" }` → the provider couldn't be reached to verify. Fails closed: the key is
  **not** stored.

**`DELETE /api/v1/settings/llm-keys/{provider}`** — `204`, idempotent (deleting an unconfigured or
unknown provider is still `204`).

Every non-2xx body carries an `error` string, which the UI renders verbatim on the provider card.

---

## P2 — not implemented

Sketched, not built. Shapes here are provisional and may change; don't depend on them:

- `GET/PUT /api/v1/settings/scan-scope` — which repos/paths are scanned
- `GET/POST/DELETE /api/v1/settings/repositories` — repository connections
- `GET/PUT /api/v1/settings/ownership` — team ↔ service mapping
- `GET/PUT /api/v1/settings/pr-comments` — cartograph-bot PR-comment behaviour
- `POST /api/v1/scan` — trigger a rescan (returns job id); `GET /api/v1/scan/{id}` for status

(`GET/PUT/DELETE /api/v1/settings/llm-keys` is no longer provisional — see §7.)

---

## Not needed from the backend

- Graph layout, pan/zoom, filtering, degree counts — all client-side.
- PR-comment markdown rendering — generated client-side (`prComment`); the backend only needs the
  commits/changes data above. (Actually *posting* the comment to GitHub is a backend concern but
  not a UI-facing API.)
