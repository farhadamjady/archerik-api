# Ingest Contract (`/v1`) — extractor → backend

The wire contract between a **scanner** (any program that statically analyses a repository) and this
backend. It is deliberately small: two endpoints, one JSON body shape, one credential type.

This is the **write** side of the system. The **read** side that the UI consumes is a different base
path, a different credential, and a different document — see [`API-CONTRACT.md`](./API-CONTRACT.md).
The two never cross: a session token is rejected at `/v1/*`, and an API key is rejected at
`/api/v1/*`.

The reference producer is the `service-discovery` Go CLI, but nothing here is Go-specific. Any client
that can POST this body is a valid scanner.

---

## 1. Overview and auth model

| | Read API | Ingest API |
|---|---|---|
| Base path | `/api/v1` | `/v1` |
| Credential | opaque session token (login/SSO) | long-lived **API key** |
| Header | `Authorization: Bearer <token>` | `Authorization: Bearer <key>` |
| Audience | the UI, a human | CI, a machine |
| Scope | the account the user belongs to | the account the key belongs to |

API keys are stored as `sha256(key)` (`ApiKey.keyHash`), so a database dump cannot be replayed
against the API. A key resolves to exactly one **account** — the tenant that owns every baseline,
graph and scan record the key writes.

Both endpoints are gated by the same key and the same guard (`src/ingest/api-key.guard.ts`). The gate
is applied **twice on purpose**: once at CLI startup (`/v1/auth/validate`, cheap, fail fast) and again
at submit time (`/v1/ingest`), so a key revoked mid-run cannot land data.

Every non-2xx body is `{ "error": "<string>" }`, the same normalisation the read API uses
(`src/common/error-body.filter.ts`).

---

## 2. `POST /v1/auth/validate`

The startup entitlement gate. Empty body; the key is the whole request.

**200** — the account is entitled to scan:

```json
{ "plan": "mvp", "quota_remaining": 999412, "expires_at": "2027-08-06T12:00:00.000Z" }
```

| Status | Meaning | Typical CLI behaviour |
|---|---|---|
| `200` | Entitled. Proceed with the scan. | continue |
| `401` | Key missing, unknown, or revoked. | exit, tell the user to check `EKG_API_KEY` |
| `403` | Entitlement expired (`Account.expiresAt` in the past). | exit, tell the user to renew |
| `429` | Quota exhausted (`Account.quotaRemaining <= 0`). | exit, tell the user to top up |

This call is **free** — it does not decrement quota. It exists so a CI job fails in two seconds with
a clear message instead of after a five-minute scan.

---

## 3. `POST /v1/ingest`

Submit one service's graph; get back the diff against that service's stored baseline.

**One request = one service.** A repository containing five Spring Boot modules makes five calls.

### Headers

The body stays the **pure graph** so it can be byte-compared (§3.1). Everything situational rides in
headers:

| Header | Required | Meaning |
|---|---|---|
| `Authorization: Bearer <key>` | yes | the API key |
| `Content-Type: application/json` | yes | |
| `X-EKG-Sha` | no | commit SHA being scanned |
| `X-EKG-Branch` | no | branch being scanned. Absent ⇒ treated as the default branch |
| `X-EKG-Default-Branch` | no | the repo's default branch. Defaults to `main` |
| `X-EKG-Pr` | no | PR number/URL, for provenance |

### Default-branch scans vs. PR scans

This is the single most important behaviour to get right:

- **Default-branch scan** (`X-EKG-Branch` absent, or equal to `X-EKG-Default-Branch`) — diffs against
  the stored baseline, **writes the new baseline**, and re-projects the account's read model.
- **PR scan** (any other branch) — diffs against the baseline and returns the markdown, but
  **never writes the baseline**. A pull request cannot move the fleet's recorded truth.

### Response — 200

```jsonc
{
  "service_id": "order-service",
  "unchanged": false,       // true ⇒ byte-identical to the baseline; `diff` omitted, `markdown` ""
  "first_scan": true,       // no baseline existed; the diff is "everything added"
  "baseline_updated": true, // false on a PR scan
  "diff": { /* §5 */ },
  "markdown": "### 🏗 Architecture impact: **order-service** (first scan)\n…"  // §7
}
```

### Status codes

| Status | When |
|---|---|
| `200` | Accepted (including the `unchanged` fast path) |
| `400` | Empty body, malformed JSON, or a body with no `service_id` |
| `401` | Key missing, unknown, or revoked (re-checked here, not trusted from `/validate`) |
| `403` | Entitlement expired, **or** the account's service limit would be exceeded (§3.2) |
| `429` | Quota exhausted |

Each accepted ingest decrements `quota_remaining` by 1 — including an `unchanged` submission, which
still cost a scan.

### 3.1 The body is stored byte-for-byte

The request body is persisted as raw `bytea` (`ServiceBaseline.body`), never re-marshalled. The
"nothing changed" fast path is a literal `Buffer.equals(stored, incoming)`.

This puts one requirement on the producer: **emit deterministically.** Stable key order, stable
collection order. If your JSON serialiser reorders keys between runs, every scan looks changed, the
diff is noise, and the fast path never fires. Do not change your marshalling or sort order without
treating it as a breaking change.

### 3.2 Baseline identity and the service limit

One baseline per **`(account, repository, service_id, default_branch)`**.

`repository` is part of the key on purpose: `service_id` is usually a directory name and is *not*
globally unique — plenty of organisations have an `order-service` in three repositories. Without
`repository` in the key they would clobber one another. When a scanner reports no `repository`, the
column stores `""` rather than `NULL`, because Postgres treats `NULL`s as distinct and repo-less
rescans would silently pile up duplicate baselines.

An account may hold at most `Account.maxServices` distinct `(repository, service_id)` pairs. A
**new** service that would push it over the limit is rejected with `403`, and the rejection is still
written to the `scans` table — refused attempts stay auditable. Re-scanning a service the account
already knows is always allowed, whatever the count.

---

## 4. The Service body

One JSON object per service. Typed in `src/ingest/model.ts`; extra fields you send are preserved in
the stored bytes but not interpreted.

```jsonc
{
  "service_id": "order-service",              // required, non-empty. Usually the module dir name.
  "service_name": "OrderService",             // optional display name
  "repository": "github.com/acme/orders",     // <host>/<org>/<service> or <org>/<service>
  "language": "Java",                         // optional, canonical casing: Java | Kotlin | Go | …

  "endpoints": [
    {
      "method": "POST",                       // HTTP verb
      "path": "/orders",
      "protocol": "rest",                     // rest | kafka | grpc | websocket | unknown
      "detection": "controller",              // free string — how it was found
      "confidence": "confirmed",              // confirmed | likely | uncertain — REQUIRED
      "request":  { /* §4a */ },
      "response": { /* §4a */ }
    }
  ],

  "outbound_dependencies": [
    {
      "target_name": "payment-service",       // RAW, as written in the code. Never a guessed id.
      "url": "http://payment-service:8080/payments",
      "protocol": "rest",
      "detection": "feign",
      "confidence": "confirmed",
      "resolved": true,                       // did the scanner resolve the target itself?
      "conditional": false,                   // behind a profile/flag
      "candidate_group": ""                   // set when several targets are alternatives
    }
  ],

  "kafka_producers": [
    { "topic": "OrderCreated", "protocol": "kafka", "detection": "kafkatemplate",
      "confidence": "confirmed", "resolved": true, "schema": { /* §4a */ } }
  ],
  "kafka_consumers": [
    { "topic": "PaymentAuthorized", "protocol": "kafka", "detection": "kafkalistener",
      "confidence": "confirmed", "resolved": true, "schema": { /* §4a */ } }
  ],

  "databases_used": [],                       // reserved; accepted and stored, not yet projected
  "config_dependencies": []                   // reserved; accepted and stored, not yet projected
}
```

### Required vocabulary

- **`confidence` is required on every endpoint, dependency and kafka edge**, and must be exactly
  `confirmed`, `likely` or `uncertain`. This is the honesty invariant — see CLAUDE.md §6.
- **`protocol`** must be one of `rest | kafka | grpc | websocket | unknown`. `unknown` is a
  legitimate answer, not a failure: it means the transport was genuinely undetermined. All five
  survive end-to-end to the UI.
- **`detection`** is a **free display string**. The backend maps values it recognises to canonical
  casing (`feign`→`FeignClient`, `webclient`→`WebClient`, `resttemplate`→`RestTemplate`,
  `router`→`route`, `httpexchange`→`HttpExchange`, `cloudstream`→`CloudStream`, kafka
  listener/template likewise) and passes anything else through verbatim. Add new values freely;
  nothing rejects them.
- **`target_name` stays raw.** Emit the name as it appears in the source — a Feign logical name, a
  URL authority, whatever the code says. Never substitute a `service_id` you guessed. Mapping names
  to services is the backend's job (§6), because only the backend knows the whole fleet.

### `repository` drives three things

From `<system>/<serviceId>` the backend derives the catalog's node id (`<system>/<serviceId>` —
globally unique, so the same `order-service` in two systems stays two nodes), the **org** shown in
the UI sidebar (`github.com/acme` → `acme`), and the **repo slug** used as the service's primary
label (`orders`). Keep it one repository per service; the org/slug derivation assumes that.

### 4a. Schema nodes

Request bodies, response bodies and Kafka message schemas are all the **same recursive shape**. A
root node has no `name`; a field node does.

```jsonc
{
  "type": "object",                  // JSON primitive (string|integer|number|boolean|object|array|
                                     // map|void) OR a DTO type NAME
  "name": "customer",                // wire name, post-@JsonProperty rename. Absent on a root.
  "nullable": true,                  // may the VALUE be null. Omitted when false.
  "required": "required",            // tri-state: required | optional | unknown. Always emitted.
  "items": "LineItem",               // arrays only — element type name
  "key_type": "string",              // maps only
  "value_type": "Money",             // maps only — values are named, never expanded
  "enum": ["PENDING", "PAID"],       // DECLARATION order — never re-sorted
  "constraints": { "maxLength": "10" },  // open string→string map (Bean Validation etc.)
  "confidence": "likely",            // PER-NODE detection certainty
  "truncated": true,                 // walk stopped here (depth limit or cycle); no `nested`
  "nested": [ /* child fields, or hoisted element fields for array-of-object */ ]
}
```

Two rules matter:

- **`nullable` and `required` are orthogonal.** A field can be required-and-nullable (must be
  present, may be `null`). Collapsing them loses real information.
- **Emit only non-empty keys, and never synthesize structure.** If the walk hit a depth limit, say
  `truncated: true` and stop. A missing or uncertain node is a true statement about the source code,
  not a gap to fill in with a plausible guess. The backend stores what arrives verbatim.

---

## 5. The diff

Computed by `src/ingest/graphdiff.ts` as a pure function of `(baseline, head)` and returned in the
response. Four categories, each with `added` / `removed` / `changed`:

```jsonc
{
  "service_id": "order-service",
  "endpoints":             { "added": [ … ], "removed": [ … ], "changed": [ … ] },
  "outbound_dependencies": { … },
  "kafka_producers":       { … },
  "kafka_consumers":       { … },
  "summary": { "added": 3, "removed": 0, "changed": 1 },
  "target_resolutions": { "payment-service|feign": "payment-service" }   // §6
}
```

### Identity keys

Matching an old item to a new one uses these keys, which **must** match the producer's exactly or the
diff desynchronises and every scan reports churn:

| Category | Key |
|---|---|
| endpoint | `method + " " + path` |
| outbound dependency | `target_name + "\|" + detection` |
| kafka producer/consumer | `topic + "\|" + direction` |

A consequence worth stating: because `detection` is part of a dependency's key, the same target found
by two different mechanisms is two entries, and a matched pair can never differ on `detection`.

### `changed` entries

A `changed` entry is the **head** object plus `changed: string[]` naming the fields that differ, plus
`schema_diff` when a request/response/message schema moved:

```jsonc
{
  "method": "POST", "path": "/orders", "confidence": "confirmed", "…": "…",
  "changed": ["response"],
  "schema_diff": [
    { "op": "add",    "path": "couponCode", "type": "string" },
    { "op": "change", "path": "amount", "from": "integer", "to": "number" },
    { "op": "change", "path": "status", "attrs": ["enum"] }
  ]
}
```

`path` is the **wire-name path** from the edge root — `customer.address`, `lines[].sku`, and `""` for
the root node itself. The rules:

- path present on one side only → `add` / `remove`, carrying the node's `type`
- same path, different **type facet** (`type`/`items`/`key_type`/`value_type`) → `change` with
  `from` → `to`
- same path, same type, differing **attribute** (`nullable`, `required`, `enum`, `constraints`,
  `confidence`, `truncated`) → `change` with `attrs` naming what differs

The recursion stops at the truncation boundary — the backend does not walk past a node the scanner
marked `truncated`.

---

## 6. Target resolution

The scanner emits a raw `target_name` and never guesses a `service_id`. The backend owns that mapping
because it is a function of the **fleet registry**: every service that has scanned its default branch
is "known".

`target_resolutions` maps each dependency's identity key to a `service_id` or the literal
`"external"`. Matching (`src/ingest/resolve.ts`) is case-insensitive — service names are DNS-style,
so this is always safe — and tries, in order:

1. the raw `target_name`, when it isn't URL-shaped
2. the URL hostname (port dropped, lowercased — `http://AUTH-SERVICE:8088` and `http://auth-service`
   collapse onto one label)
3. the hostname's **first DNS label** — `payment-service.prod.svc` → `payment-service`

No match → `"external"`.

**Resolution is scoped to the emitting service's own system** (the parent of its `repository`). A
name never resolves to an identically-named service in an unrelated system; it falls back to
`external` instead. Two `order-service`s in two orgs stay two things.

Resolution keys **only** on `target_name`, never on `url`. For a bare-path call the scanner emits
`target_name: ""` and a `url` holding just a path — deriving a host from that would mint junk
`/orders`-shaped nodes. An empty `target_name` buckets to a single `unknown-target` node.

Unresolved does not mean dropped. An unresolvable target becomes a visible `unknown` node carrying a
note that says why (CLAUDE.md §6).

---

## 7. The PR-comment markdown

`IngestResponse.markdown` is a ready-to-post GitHub comment, rendered by `src/ingest/markdown.ts`.
**The backend never talks to GitHub** — it returns the string, and CI posts it. That keeps the
backend free of repository write credentials.

It is `""` when nothing changed, so CI can skip posting with a falsiness check.

```markdown
### 🏗 Architecture impact: **order-service**

**3 added · 0 removed · 1 changed**

#### Endpoints
- ➕ POST /orders · rest · controller · confirmed

#### Outbound dependencies
- ➕ payment-service → `http://payment-service:8080/payments` · rest · feign · confirmed · payment-service
- 🔄 legacy-oms · rest · resttemplate · uncertain · external · changed: url

<sub>service-discovery · confidence: confirmed = found literally · likely = resolved through config · uncertain = not statically resolvable (still real)</sub>
```

Each dependency line ends with its resolution from §6 — the `service_id` it matched, or `external`.
The footer explains the confidence vocabulary in place, so a reviewer who has never seen this tool
can read the comment without leaving the PR.

The copy is **factual only**. No severity, no "breaking change", no advice. It states what changed
and how it was detected; judgment belongs to the reviewer.

---

## 8. Worked example

```bash
KEY=ekg_dev_local_demokey     # seeded by `npm run prisma:seed` for local dev

# 1. Startup gate — free, fails fast.
curl -s -X POST http://localhost:3000/v1/auth/validate \
  -H "Authorization: Bearer $KEY"
# {"plan":"mvp","quota_remaining":999999,"expires_at":"2027-08-06T…"}

# 2. Default-branch scan — diffs AND writes the baseline.
curl -s -X POST http://localhost:3000/v1/ingest \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'X-EKG-Sha: a3f19c2' \
  -H 'X-EKG-Default-Branch: main' \
  --data-binary @order-service.json

# 3. PR scan — same diff, baseline untouched.
curl -s -X POST http://localhost:3000/v1/ingest \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'X-EKG-Sha: b4c28d1' \
  -H 'X-EKG-Branch: feat/promos' \
  -H 'X-EKG-Default-Branch: main' \
  -H 'X-EKG-Pr: 1847' \
  --data-binary @order-service.json | jq -r .markdown
```

`--data-binary` rather than `-d` is deliberate: `-d` strips newlines, which changes the bytes and
defeats the unchanged fast path (§3.1).

Round-trip coverage for all of the above lives in `test/ingest.e2e-spec.ts`.
