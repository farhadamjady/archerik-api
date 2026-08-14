<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/archerik-banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/archerik-banner-light.svg">
  <img alt="Archerik" src="assets/archerik-banner-light.svg" width="400">
</picture>

**The control plane for Archerik — ingests architecture scans, diffs them against
what it already knows, and serves the fleet-wide catalog to the UI and the LLM.**

[![CI](https://github.com/farhadamjady/archerik-api/actions/workflows/ci.yml/badge.svg)](https://github.com/farhadamjady/archerik-api/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-20%2B-00B3CB?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-008598)](LICENSE)
[![Tests](https://img.shields.io/badge/e2e-118%20passing-005865)](#testing)

</div>

---

## What Archerik is

Every engineering org past a few dozen services has the same problem: nobody can
say with confidence what talks to what. The wiki diagram was accurate the week it
was drawn. The only artifact that tells the truth is the source code.

Archerik reads the source code and builds the catalog from it — the REST
endpoints each service exposes, the services it calls, the Kafka topics it
produces and consumes, and the field-level schemas of all of those. Wire it into
CI and the catalog maintains itself, commit by commit, with nobody assigned to
keep it up to date.

The part that makes it usable is that **it tells you where reading the source
wasn't enough**:

| Principle | What it means |
|---|---|
| **Confidence on everything** | Every edge is `confirmed` (declared in code — `@FeignClient`, a literal `KafkaTemplate.send("orders")`), `likely` (inferred — a `WebClient` base URL resolved from config), or `uncertain` (a `RestTemplate` call to a runtime variable). |
| **Unresolved stays visible** | A call to a host matching no scanned service doesn't vanish. It becomes an `unknown` node carrying a note explaining *why* it couldn't be resolved. Deleting it would be a lie by omission. |
| **Nothing is invented** | Not by the extractor, and not by the LLM — Ask's citations are rendered from a server-side evidence ledger, so a made-up citation resolves to nothing and is dropped. |
| **No judgments** | The catalog reports that a field changed type. It does not tell you that's a breaking change. Severity is a human call with context the tool doesn't have. |

## What this repository does

This is the **API** — the only component that stores anything. It:

1. **Accepts scans.** One HTTP POST per service, authenticated with an account's
   API key.
2. **Diffs each submission** against that service's stored baseline and returns a
   PR-comment-ready summary of what changed.
3. **Projects the whole account's fleet** into a catalog: services, the
   relationships between them, and their contracts.
4. **Serves that catalog** to the UI over a session-authenticated read API.
5. **Answers questions about it** through an LLM that can only see the catalog
   via read-only tools.

It makes no judgments, never talks to GitHub, and never stores source code.

## How the three components interact

```
        Repository                    one service's source tree
            │
            ▼
        Extractor      archerik-extractor · Go CLI, runs in CI
            │          static analysis → one JSON document per service
            │  POST /v1/ingest  (API key)
            ▼
           API         archerik-api · this repo
            │          diff vs. baseline → PR comment
            │          project fleet → catalog
            ▼
   Architecture Knowledge          PostgreSQL: baselines + materialised catalog
            │
     ┌──────┴───────┐
     ▼              ▼
    UI             LLM             archerik-ui reads GET /api/v1/*
                                   Ask reads the same catalog through tools
```

| Component | Repository | Role | Depends on |
|---|---|---|---|
| **Extractor** | [`archerik-extractor`](https://github.com/farhadamjady/archerik-extractor) | Scans one service repository and emits its architecture as JSON. Runs locally or in CI. | — |
| **API** | [`archerik-api`](https://github.com/farhadamjady/archerik-api) *(this repo)* | Ingests those graphs, stores them, derives inbound edges across services, diffs each commit against the last, serves the catalog. | Extractor output |
| **UI** | [`archerik-ui`](https://github.com/farhadamjady/archerik-ui) | Explores the fleet graph — services, dependencies, topics, schemas — and visualizes what changed. | API |

The extractor never talks to the UI. It produces JSON; this API is the only thing
that consumes it, and the UI reads everything through this API.

Only this backend needs to exist for the API to be useful. The ingest contract is
plain HTTP and JSON, so **any** program that can produce the body typed in
[`src/ingest/model.ts`](./src/ingest/model.ts) works — there's a worked example
under [Quick start](#quick-start).

## What Archerik stores

PostgreSQL, via Prisma. The shape follows one idea: **store the extractor's truth
verbatim, and materialise everything else.**

### The conceptual model

| Concept | Where it lives |
|---|---|
| **Services** | Nodes in the projected graph, id `<system>/<serviceId>`, each carrying its repository, language and team |
| **Service relationships** | Edges between nodes — a REST call or a Kafka flow — each with a protocol and a confidence |
| **APIs (REST endpoints)** | Contract rows of kind `rest`: method, path, the service that exposes it, and the callers derived from other services' code |
| **Request/response contracts** | Field-level schemas hanging off each endpoint — name, type, required, nested objects, arrays, enums |
| **Kafka producers** | The service that publishes a topic, when one is in scan scope |
| **Kafka consumers** | Derived from `@KafkaListener` and equivalents in the consuming services |
| **Event schemas** | The message schema on each topic contract, same field-level shape as request/response |

Two rules that keep this honest: a Kafka topic with **no producer in scan scope
is `uncertain`** regardless of how confidently its consumers were detected, and
inbound REST callers and Kafka consumers are **derived** from the callers' code,
never declared by the service being called.

### The tables

| Table | Role |
|---|---|
| `service_baselines` | The source of truth — the extractor's byte-stable JSON per `(account, repository, service_id, default_branch)` |
| `graphs` | Materialised read model, one row per `(account, branch)`, overwritten in place |
| `contracts` | Endpoints and topics belonging to a graph row |
| `commits` | Per-commit change records (unpopulated — see [Limitations](#current-limitations)) |
| `scans` | One row per ingest call — the account's audit and metering log, including rejections |
| `accounts`, `api_keys` | Tenants and their extractor credentials (keys stored hashed) |
| `users`, `sessions` | Login and opaque session tokens (both hashed) |
| `sso_connections`, `sso_domains`, `sso_auth_requests` | Per-tenant OIDC config and in-flight logins |
| `llm_provider_keys` | Per-account provider keys, encrypted at rest, with `last4` denormalised |

Three storage decisions worth knowing before you change them:

- **The submitted body is stored as raw bytes and never re-marshalled.** The
  "nothing changed" fast path is a literal byte comparison, so re-serialising
  would reorder keys and defeat it.
- **Hashed vs. encrypted is not a style choice.** Credentials presented *to* us
  (API keys, session tokens, passwords) are hashed — we only ever compare them.
  Credentials we present *onward* (OIDC client secrets, LLM provider keys) are
  encrypted with AES-256-GCM, because they must be recoverable.
- **`repository` is part of the baseline key.** `service_id` is a directory name
  and collides across repos; without `repository` in the key, two
  `order-service`s would clobber each other.

## Quick start

**You'll need:** Node.js ≥ 20 · Docker · `openssl`

```bash
git clone https://github.com/farhadamjady/archerik-api
cd archerik-api
npm install
```

**1. Configure** — the two encryption keys have no defaults on purpose. The
process refuses to start without them.

```bash
cp .env.example .env
echo "SSO_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "LLM_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "LLM_VERIFY_KEYS=false" >> .env   # offline dev: don't call out to verify a saved key
```

**2. Database**

```bash
docker compose up -d db      # Postgres 16 on :5432
npx prisma migrate dev       # create the schema
npx prisma db seed           # demo account, login, API key + a small demo fleet
```

**3. Run**

```bash
npm run start:dev            # http://localhost:3000
```

The seed prints what it created:

```
Demo login: demo@acme.com / demo1234
Extractor API key (Bearer): ark_dev_local_demokey
```

### Kick the tyres

```bash
# Health — the one route needing no credential at all.
curl -s localhost:3000/api/v1/health
# {"status":"ok","db":"up"}

# Log in and read the whole account's catalog.
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@acme.com","password":"demo1234"}' | jq -r .token)

curl -s localhost:3000/api/v1/graph -H "Authorization: Bearer $TOKEN" | jq '.nodes | length'
curl -s localhost:3000/api/v1/contracts -H "Authorization: Bearer $TOKEN" | jq '.endpoints[0]'
```

No repo or branch parameter is needed. Reads are scoped to the account behind
your session token — `repo` and `service` are optional **filters**, not required
keys.

<details>
<summary><b>Submit a scan by hand and watch the catalog grow</b></summary>

```bash
cat > order-service.json <<'JSON'
{
  "service_id": "order-service",
  "service_name": "OrderService",
  "repository": "github.com/acme/orders",
  "language": "Java",
  "endpoints": [
    { "method": "POST", "path": "/orders", "protocol": "rest",
      "detection": "controller", "confidence": "confirmed" }
  ],
  "outbound_dependencies": [
    { "target_name": "payment-service", "url": "http://payment-service:8080/payments",
      "protocol": "rest", "detection": "feign", "confidence": "confirmed", "resolved": true }
  ],
  "kafka_producers": [
    { "topic": "OrderCreated", "protocol": "kafka",
      "detection": "kafkatemplate", "confidence": "confirmed" }
  ],
  "kafka_consumers": [], "databases_used": [], "config_dependencies": []
}
JSON

curl -s -X POST localhost:3000/v1/ingest \
  -H "Authorization: Bearer ark_dev_local_demokey" \
  -H 'Content-Type: application/json' \
  -H 'X-Archerik-Sha: a3f19c2' -H 'X-Archerik-Default-Branch: main' \
  --data-binary @order-service.json | jq -r .markdown
```

You'll get back the PR comment CI would post:

```markdown
### 🏗 Architecture impact: **order-service** (first scan)

**3 added · 0 removed · 0 changed**

#### Endpoints
- ➕ POST /orders · rest · controller · confirmed

#### Outbound dependencies
- ➕ payment-service → `http://payment-service:8080/payments` · rest · feign · confirmed · payment-service
```

…and `GET /api/v1/graph` will now include the service.

> Use `--data-binary`, not `-d`. `-d` strips newlines, which changes the bytes
> and defeats the unchanged-scan fast path.

</details>

<details>
<summary><b>Optional: a database UI</b></summary>

```bash
docker compose --profile tools up -d adminer   # http://localhost:8080
```

Server `db`, with user / password / database all `archerik`.

</details>

## Database requirements

**PostgreSQL 16** is what CI and the Compose file use. Postgres 14+ should work;
nothing depends on a 16-only feature.

- **JSONB** carries the graph, contracts and baselines, so the stored rows map
  1:1 onto the API wire shapes with no translation layer.
- **Transaction-scoped advisory locks** serialise re-projection. Two concurrent
  ingests touching the same `(account, branch)` can't race on the
  delete-then-create.
- **`bytea`** holds AES-256-GCM ciphertext for OIDC client secrets and LLM
  provider keys.

No extensions are required. The MVP uses PostgreSQL deliberately — the graph is
small, per-account, and re-projected wholesale, so a graph database would add
operational weight without buying anything yet.

Schema changes need a migration committed alongside them:

```bash
npx prisma migrate dev --name what_changed   # development
npx prisma migrate deploy                    # production — never `migrate dev`
```

## Configuration

All configuration is environment variables. [`.env.example`](./.env.example)
documents each one inline and is the file to copy. A `.env` file in the project
root is picked up automatically at startup; in production, prefer real
environment variables from your secret manager.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string. Matches Compose out of the box. |
| `PORT` | `3000` | HTTP listen port. |
| `CORS_ORIGINS` | `*` | Comma-separated allow-list. **Set this to your real UI origin in production.** |
| `SESSION_TTL_HOURS` | `168` | Session lifetime (7 days). |
| `APP_URL` | `http://localhost:5173` | Where the SSO callback lands the browser — your frontend. |
| `BACKEND_PUBLIC_URL` | `http://localhost:3000` | This service's externally reachable URL. Every tenant's IdP registers `${BACKEND_PUBLIC_URL}/api/v1/auth/sso/callback` as its redirect URI. |
| `SSO_ENCRYPTION_KEY` | — | **Required.** 32-byte base64. Encrypts each SSO connection's OIDC client secret. |
| `SSO_STATE_TTL_MINUTES` | `10` | How long an in-flight SSO login stays valid. |
| `LLM_ENCRYPTION_KEY` | — | **Required.** 32-byte base64. Encrypts stored provider API keys. |
| `LLM_VERIFY_KEYS` | `true` | Verify a provider key against the provider before storing it. Set `false` offline, or every save fails. |
| `LLM_REQUEST_TIMEOUT_MS` | `60000` | Per-request provider timeout. Keep it under your proxy's. |

**On the two encryption keys.** They have no defaults and **the process fails to
start without them**. A shipped default would mean every deployment that never
set one shares a key published in this repository. They are two separate
variables so a leak of one doesn't unlock both classes of secret. Losing them
isn't recoverable: rotate by re-entering the affected SSO client secrets and
provider keys. See [SECURITY.md](./SECURITY.md) before deploying.

## How the extractor talks to the API

The write surface is `/v1`, authenticated with a long-lived **API key** as
`Authorization: Bearer <key>`. Keys are stored as `sha256(key)`.

| Method & path | Notes |
|---|---|
| `POST /v1/auth/validate` | Startup gate. Empty body → `{ plan, quota_remaining, expires_at }`. `401` bad key · `403` not entitled · `429` quota exceeded. **Free** — doesn't consume quota. |
| `POST /v1/ingest` | Submit one service's graph; get back the diff and the PR-comment markdown. Re-validates the key. |

The request body is exactly one service's graph, typed in
[`src/ingest/model.ts`](./src/ingest/model.ts). Commit metadata rides in headers
so the body stays the pure, byte-stable graph:

| Header | Meaning |
|---|---|
| `X-Archerik-Sha` | Commit SHA the scan describes |
| `X-Archerik-Branch` | Branch being scanned |
| `X-Archerik-Default-Branch` | The repository's default branch |
| `X-Archerik-PR` | Pull-request number, when scanning a PR |

The legacy `X-EKG-*` spelling of all four is still accepted, because the
extractor ships on its own schedule and older CI pipelines still send it. Both
resolve to the same field; the canonical name wins if both are present.

The response is `{ service_id, unchanged, first_scan, baseline_updated, diff?, markdown }`.

What happens inside, in order: entitlement and service-limit check → byte-compare
against the stored baseline (identical ⇒ early return, no diff, empty markdown) →
semantic diff → resolve each raw target name to a known service, an `external`
host, or an `unknown` bucket → render the PR comment → and, **only on a
default-branch scan**, write the baseline and re-project the account's fleet.

Two behaviours that surprise people:

- **A PR scan diffs but never writes the baseline.** A pull request cannot move
  recorded truth. Only a default-branch scan does that.
- **Every accepted ingest decrements quota**, including an unchanged one. It
  still cost a scan.
- **The API never talks to GitHub.** It returns the markdown; your CI posts it.
  That keeps repository write credentials out of this service entirely.

## How the UI talks to the API

The read surface is `/api/v1`, authenticated with a short-lived **session token**
as `Authorization: Bearer <token>`. Sessions are opaque, DB-backed tokens — not
JWTs — stored as `sha256(token)`, so logout revokes server-side and a database
dump can't be replayed.

Everything is scoped to the **account** the user belongs to, derived from the
token and never from a query parameter.

| Method & path | Returns |
|---|---|
| `GET /health` | Liveness + DB status. **Public.** |
| `POST /auth/login` | `{ token, user }`; `401` on bad credentials. **Public.** |
| `GET /me` | Session restore → `{ name, handle, team }`. |
| `POST /auth/logout` | Revokes the token server-side. |
| `POST /auth/sso/start` | `{ sso: true, redirectUrl }` or `{ sso: false }`. **Public**, rate-limited. |
| `GET /auth/sso/callback` | IdP redirect target. **Public.** |
| `GET /graph` | The whole catalog: `{ org, repo, branch, scannedAt, teams[], nodes[], edges[] }`. |
| `GET /contracts` | `{ endpoints[], topics[] }` with field-level schemas. |
| `GET /commits` | Bare array of architecture-relevant commits. |
| `POST /ask` | Grounded Q&A over the catalog. Rate-limited. |
| `GET /models` | The Ask model picker's options. |
| `GET /settings/llm-keys` | One status entry per provider — never the key itself. |
| `PUT /settings/llm-keys` | Store a provider key (verified first, then encrypted). |
| `DELETE /settings/llm-keys/:provider` | `204`, idempotent. |

**Optional filters** on `/graph`, `/contracts`, `/commits`: `repo`, `service`,
`branch` (default `main`), `at` (commit SHA) — plus `protocol` on `/contracts`
and `since`/`limit` on `/commits`.

Three details that trip up client authors:

- **Every non-2xx body is `{ "error": "<string>" }`** and nothing else,
  including validation failures and rate-limit rejections. Clients can render
  `error` verbatim on any failure with no fallback path.
- **A fresh account with no scans returns `200` with an empty payload**, not
  `404`. Render a "no scans yet" state, not an error.
- **Nodes omit `deg`/`inDeg`/`outDeg`** — compute them client-side — and
  `/commits` is a bare array with no `{ commits: [...] }` envelope.

**SSO hand-off.** `GET /auth/sso/callback` is a full-page browser navigation, not
a fetch. On success it returns a tiny page that writes the session token to
`sessionStorage['archerik.token']` and redirects to `APP_URL`. That key is a
contract with `archerik-ui`, which reads the same one; changing it on one side
alone breaks SSO login silently.

The exact wire shapes are defined by the code that serves them —
[`src/common/types.ts`](./src/common/types.ts) and
[`src/common/enums.ts`](./src/common/enums.ts) — and pinned against live
responses in `test/contract.e2e-spec.ts`.

## Ask — the LLM layer

`POST /api/v1/ask` answers natural-language questions about the catalog:
*"What depends on PaymentService?"*, *"Which topics have no registered schema?"*

**The architecture data is the source of truth; the LLM is a reasoning and
interface layer over it.** That's enforced structurally, not by prompting:

```
Question ──▶ Model ──calls──▶ Catalog tools (read-only)
                 ◀──rows───── │
                              └──records every row──▶ Evidence ledger (server-side)
Model names the ids it used ──▶ resolved against the ledger ──▶ cites
                                invented id ──▶ dropped
```

1. The model **never receives a graph dump.** It reaches the catalog only through
   the read-only, paginated tools in
   [`src/ask/catalog-tools.ts`](./src/ask/catalog-tools.ts) — retrieval, not
   unrestricted database access.
2. Every relationship a tool returns is recorded in a per-request **evidence
   ledger**, with an id.
3. The model names the ids it used.
4. The backend renders `cites` **from the recorded rows**, not from model output.

So `text` comes from the model, while `cites` and `note` are computed by the
backend. An id the model invented resolves to nothing and is dropped. A provider
failure is always a 4xx/5xx carrying an `error` string, never a plausible-looking
fabricated answer.

**Bring your own key.** Each account stores its own Anthropic or OpenAI key via
Settings → LLM, and Ask spends that key. With no key configured for the chosen
model's provider, `/ask` returns `409`. Keys are encrypted at rest, verified
against the provider before storing, and never returned by any endpoint — reads
serve a denormalised `last4`.

Providers sit behind one interface
([`src/llm/provider.types.ts`](./src/llm/provider.types.ts)) modelling a single
round trip. Adding one is an adapter plus an entry in
[`src/llm/model-registry.ts`](./src/llm/model-registry.ts), which is also the
source of truth for `GET /models`. Nothing outside `src/llm/` knows which vendor
answered.

## Testing

```bash
npm run test:e2e     # the full suite — 118 tests
npm run typecheck    # tsc --noEmit
npm run lint         # eslint --fix
npm run build        # nest build
```

The suite boots the real application against a real database, so bring one up
first:

```bash
docker compose up -d db && npx prisma migrate dev && npx prisma db seed
```

**No live credentials are required for anything.** Ask runs against a scripted
stub provider, the Anthropic and OpenAI adapters are pinned by pointing the real
SDKs at a local server, and SSO runs against a mock IdP built in
`test/sso-fixtures.ts` by overriding `globalThis.fetch` — real signature, issuer,
audience and nonce validation against real crypto. Set `LLM_VERIFY_KEYS=false` so
key saves don't try to reach the internet.

| Suite | Covers |
|---|---|
| `contract.e2e-spec.ts` | Read API wire shapes + integrity rules against live responses |
| `ingest.e2e-spec.ts` | Both `/v1` gates, byte-stable baselines, PR vs. default-branch semantics |
| `auth` / `sso.e2e-spec.ts` | Session lifecycle; full OIDC round trip against a mock IdP |
| `ask-llm` / `catalog-tools.e2e-spec.ts` | The tool loop and evidence ledger — the "never invents" guarantee |
| `llm-keys` / `llm-providers.e2e-spec.ts` | Key storage, verification, and each adapter's wire shape |
| `secret-box` / `error-body.e2e-spec.ts` | AES-256-GCM round trip; the `{ error }` normalisation |

`src/common/integrity.ts` encodes what a strict client enforces — enum validity,
edge→node referential integrity, *"an `unknown` node must carry a note"*, *"a
producerless topic must be `uncertain`"*. It runs at **seed time** and again
against **live HTTP responses**, so a payload that would break a client can't
ship.

Two notes that will otherwise cost you an afternoon:

- **`--experimental-vm-modules` is mandatory**, not a preference. `openid-client`
  is ESM-only and its dynamic import fails inside Jest's sandbox without it.
  Already baked into the `test:e2e` script.
- Tests run with `maxWorkers: 1` because they share one database.

## Current limitations

Stated plainly, because an honest MVP is the point:

| Limitation | Detail |
|---|---|
| `GET /commits` returns `[]` | The endpoint, storage and diff engine all exist; the extractor doesn't yet send per-commit metadata. Not a bug — a missing upstream feed. |
| Ask is unverified against a live provider | The tool loop, evidence ledger and both adapters are covered against stubs and pinned wire shapes, but the first real Anthropic/OpenAI call is still pending. |
| `databases_used` / `config_dependencies` | Accepted and stored, but not yet projected into the catalog. |
| Quota is a placeholder integer | `quota_remaining` decrements, but there is no billing integration behind it. |
| No role model on `User` | Every member of an account can write that account's provider keys. |
| No history | `graphs` holds one row per `(account, branch)`, overwritten in place. There is no "what did this look like last month". |
| Dependency advisories | `npm audit` findings need a NestJS 10 → 11 major upgrade; most are dev-only tooling. See [SECURITY.md](./SECURITY.md). |

## Deployment

```bash
npm ci
npm run build
npx prisma migrate deploy    # never `migrate dev` outside development
npm run start:prod
```

Before going live:

- [ ] **Set `CORS_ORIGINS`** to your actual UI origin. The `*` default is a dev
      convenience.
- [ ] **Generate fresh encryption keys** into your secret manager, not a `.env`
      on disk.
- [ ] **Terminate TLS in front of this service.** It speaks plain HTTP; bearer
      credentials cross the wire on every request.
- [ ] **Set `BACKEND_PUBLIC_URL`** to the externally reachable URL — it's what
      every tenant's IdP registers as the redirect URI, so getting it wrong
      breaks SSO for everyone.
- [ ] **Change the database credentials.** Compose ships `archerik:archerik` for
      local use.
- [ ] **Don't run the seed.** It creates a known password and a known API key.
- [ ] The JSON body cap is 32 MB (service graphs get large); align any proxy
      limits in front of it.
- [ ] `GET /api/v1/health` is your liveness probe and reports database
      reachability.

## Contributing

[`CONTRIBUTING.md`](./CONTRIBUTING.md) covers setup, the invariants, and what
counts as a contract change. [`CLAUDE.md`](./CLAUDE.md) is the long-form
architectural orientation: how a request flows through the service, why the
storage decisions are what they are, and the ten invariants that must not break.

Security issues: please report them privately — see
[SECURITY.md](./SECURITY.md).

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/archerik-mark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./assets/archerik-mark-light.svg">
  <img src="./assets/archerik-mark-light.svg" alt="" width="34">
</picture>

**Built with the conviction that a tool which admits what it doesn't know<br/>is worth more than one that guesses confidently.**

[MIT](./LICENSE) © Farhad Amjady

</div>
