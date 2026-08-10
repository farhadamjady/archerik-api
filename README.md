# Cartograph Backend

**A service catalog for Spring Boot fleets, built from static analysis instead of a wiki nobody
updates — and honest about what it couldn't figure out.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![NestJS](https://img.shields.io/badge/NestJS-10-e0234e)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791)

A scanner walks your repositories and reports what it found: the REST endpoints each service
exposes, the services it calls, the Kafka topics it produces and consumes, and the field-level
schemas of all of those. It POSTs that here. This backend diffs each submission against that
service's stored baseline, hands CI a ready-to-post PR comment describing what changed, and projects
the whole fleet into a catalog your UI can read — plus an **Ask** endpoint that answers questions
about the catalog using an LLM that can only see what's actually in it.

---

## Table of contents

- [Why it exists](#why-it-exists)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API reference](#api-reference)
  - [Read API (`/api/v1`)](#read-api-apiv1)
  - [Ingest API (`/v1`)](#ingest-api-v1)
- [Ask and LLM provider keys](#ask-and-llm-provider-keys)
- [Authentication](#authentication)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Deployment notes](#deployment-notes)
- [Status and roadmap](#status-and-roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why it exists

Every organisation past about fifteen services has the same three problems: nobody knows who calls
this endpoint, nobody notices when a Kafka schema gains a field, and the architecture diagram was
last accurate in 2023.

Tools that solve this by asking teams to maintain a manifest fail for the obvious reason. Tools that
solve it with runtime tracing miss the code paths that didn't fire today. Cartograph reads the
source — and, crucially, **tells you where reading the source wasn't enough**.

That last part is the design centre of this project:

| | |
|---|---|
| **Confidence on everything** | Every edge and contract is `confirmed` (declared in code — `@FeignClient`, a literal `KafkaTemplate.send("topic")`), `likely` (inferred — a `WebClient` base URL resolved from config), or `uncertain` (guessed — a `RestTemplate` call to a runtime variable). |
| **Unresolved stays visible** | A call to a hostname that matches no scanned service doesn't vanish. It becomes a node of type `unknown`, carrying a note that explains *why* it couldn't be resolved. Deleting it would be a lie by omission. |
| **Nothing is invented** | Not by the extractor, and not by the LLM — Ask's citations are rendered from a server-side evidence ledger, so a citation the model made up resolves to nothing and is dropped. |
| **No judgments** | The catalog reports that a field changed type. It does not tell you that's a breaking change. Severity is a human call with context the tool doesn't have. |

If you only remember one thing about this codebase: **uncertainty is data, not an error state.**

## How it works

```
   ┌─────────────┐   POST /v1/ingest        ┌──────────────────────────────┐
   │  scanner    │   one JSON doc/service   │   Cartograph backend         │
   │  (in CI)    │ ───────────────────────▶ │                              │
   └─────────────┘                          │  1. entitlement + limits     │
          ▲                                 │  2. byte-compare baseline    │
          │  markdown PR comment            │  3. semantic diff            │
          └──────────────────────────────── │  4. resolve targets          │
                                            │  5. write baseline (main)    │
   ┌─────────────┐   GET /api/v1/graph      │  6. re-project catalog       │
   │  web UI     │ ◀─────────────────────── │                              │
   │  (a human)  │   POST /api/v1/ask       │                              │
   └─────────────┘                          └──────────────┬───────────────┘
                                                           │
                                                    ┌──────▼──────┐
                                                    │ PostgreSQL  │
                                                    └─────────────┘
```

**Two API surfaces, deliberately kept apart.** CI writes at `/v1` with a long-lived **API key**;
humans read at `/api/v1` with a short-lived **session token**. Neither credential works on the
other's routes. A leaked CI key cannot read a user's catalog, and a stolen session cannot forge scan
data.

**The scanner's output is the source of truth; everything else is derived.** Each submission is
stored as raw bytes, exactly as sent. The catalog you read is a materialised projection rebuilt from
those bytes on every ingest that changes something. This is why the "nothing changed" fast path can
be a literal byte comparison, and why the projection function is pure enough to unit-test without a
database.

**Pull requests can't move recorded truth.** A scan of a feature branch produces a diff and a PR
comment, but never overwrites the baseline. Only a default-branch scan does that.

> The scanner itself lives in a separate repository (a Go CLI). Nothing in this backend is
> Go-specific — the ingest contract is plain HTTP and JSON, so any program that can produce the body
> described in [`INGEST-CONTRACT.md`](./INGEST-CONTRACT.md) works.

## Quick start

**Requirements:** Node.js ≥ 20, Docker (for local Postgres), and `openssl` for key generation.

```bash
git clone https://github.com/farhadamjady/service-discovery-backend-chore.git
cd service-discovery-backend-chore
npm install

# 1. Config. Two encryption keys have no defaults on purpose — the app refuses to start without them.
cp .env.example .env
echo "SSO_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "LLM_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "LLM_VERIFY_KEYS=false" >> .env   # offline dev: don't call out to verify a saved provider key

# 2. Database.
docker compose up -d db                # Postgres 16 on :5432
npx prisma migrate dev                 # create the schema
npx prisma db seed                     # demo account, login, API key, and a small demo fleet

# 3. Run.
npm run start:dev                      # http://localhost:3000
```

The seed prints the credentials it created:

```
Demo login: demo@acme.com / demo1234
Extractor API key (Bearer): ekg_dev_local_demokey
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

No repo or branch parameter is needed. Reads are scoped to the account behind the session token;
`repo` and `service` are optional *filters*, not required keys.

### Submit a scan

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
  -H "Authorization: Bearer ekg_dev_local_demokey" \
  -H 'Content-Type: application/json' \
  -H 'X-EKG-Sha: a3f19c2' -H 'X-EKG-Default-Branch: main' \
  --data-binary @order-service.json | jq -r .markdown
```

You'll get back the PR comment CI would post, and `GET /api/v1/graph` will now include the service.

Use `--data-binary`, not `-d`: `-d` strips newlines, which changes the bytes and defeats the
unchanged-scan fast path.

### Optional: a database UI

```bash
docker compose --profile tools up -d adminer   # http://localhost:8080
```

Server `db`, user/password/database all `cartograph`.

## Configuration

All configuration is environment variables; [`.env.example`](./.env.example) documents each one
inline and is the file to copy.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string. Matches the Compose service out of the box. |
| `PORT` | `3000` | HTTP listen port. |
| `CORS_ORIGINS` | `*` | Comma-separated allow-list. **Set this to your real UI origin in production.** |
| `SESSION_TTL_HOURS` | `168` | Session lifetime (7 days). |
| `APP_URL` | `http://localhost:5173` | Where the SSO callback lands the browser — your frontend. |
| `BACKEND_PUBLIC_URL` | — | This backend's externally reachable base URL. Every tenant's IdP registers `${BACKEND_PUBLIC_URL}/api/v1/auth/sso/callback` as its redirect URI. |
| `SSO_ENCRYPTION_KEY` | — | **Required.** 32-byte base64 (`openssl rand -base64 32`). Encrypts each SSO connection's OIDC client secret at rest. |
| `SSO_STATE_TTL_MINUTES` | `10` | How long an in-flight SSO login stays valid. |
| `LLM_ENCRYPTION_KEY` | — | **Required.** 32-byte base64. Encrypts stored provider API keys. |
| `LLM_VERIFY_KEYS` | `true` | Verify a provider key against the provider before storing it. Set `false` offline, or every save fails. |
| `LLM_REQUEST_TIMEOUT_MS` | `60000` | Per-request provider timeout. Keep it under your proxy's. |

### On the two encryption keys

They have **no defaults and the app fails closed without them.** A shipped default would mean every
deployment that never set one shares a key that's published in this repository — which is
indistinguishable from storing the secrets in plaintext.

They are **two separate variables** rather than one, so a leak of one doesn't unlock both classes of
secret. Losing them is not recoverable: rotate by re-entering the affected SSO client secrets and
provider keys.

Note what's hashed versus what's encrypted, because it isn't arbitrary. Credentials presented **to**
this service — API keys, session tokens — are stored as SHA-256 hashes, since we only ever need to
compare them; a database dump can't be replayed. Credentials this service presents **onward** — OIDC
client secrets, LLM provider keys — must be recoverable, so they're AES-256-GCM encrypted instead.

## API reference

Two surfaces. Full wire shapes live in [`API-CONTRACT.md`](./API-CONTRACT.md) (read) and
[`INGEST-CONTRACT.md`](./INGEST-CONTRACT.md) (write).

**Every non-2xx response body is `{ "error": "<string>" }` and nothing else** — including validation
failures and rate-limit rejections, which are normalised into the same shape. A client can render
`error` verbatim on any failure without a fallback path.

### Read API (`/api/v1`)

Session token required (`Authorization: Bearer <token>`) except where marked public. Scoped to the
account the user belongs to — derived from the token, never from a query parameter.

| Method & path | Returns |
|---|---|
| `GET /health` | Liveness + DB status. **Public.** |
| `POST /auth/login` | `{ token, user }`; `401` on bad credentials. **Public.** |
| `GET /me` | Session restore → `{ name, handle, team }`. |
| `POST /auth/logout` | Revokes the token server-side. |
| `POST /auth/sso/start` | `{ sso: true, redirectUrl }` or `{ sso: false }`. **Public**, rate-limited. |
| `GET /auth/sso/callback` | IdP redirect target. **Public.** |
| `GET /graph` | The account's whole catalog: `{ org, repo, branch, scannedAt, teams[], nodes[], edges[] }`. |
| `GET /contracts` | `{ endpoints[], topics[] }` with field-level schemas. |
| `GET /commits` | Bare array of architecture-relevant commits. Currently `[]` — see [Status](#status-and-roadmap). |
| `POST /ask` | Grounded Q&A over the catalog. Rate-limited. |
| `GET /models` | The Ask model picker's options. |
| `GET /settings/llm-keys` | One status entry per provider — never the key itself. |
| `PUT /settings/llm-keys` | Store a provider key (verified first, then encrypted). |
| `DELETE /settings/llm-keys/:provider` | `204`, idempotent. |

Optional filters on `/graph`, `/contracts`, `/commits`: `repo`, `service`, `branch` (default
`main`), `at` (commit SHA); plus `protocol` on `/contracts` and `since`/`limit` on `/commits`.

A fresh account with no scans returns `200` with an empty payload, not `404` — render a "no scans
yet" state, not an error.

Two shape details worth knowing, because clients validate strictly: nodes deliberately **omit**
`deg`/`inDeg`/`outDeg` (compute them client-side), and `/commits` is a **bare array** with no
`{ commits: [...] }` envelope.

### Ingest API (`/v1`)

API key required. See [`INGEST-CONTRACT.md`](./INGEST-CONTRACT.md) for the full body shape, diff
format, and resolution rules.

| Method & path | Notes |
|---|---|
| `POST /v1/auth/validate` | Startup entitlement gate. Empty body → `{ plan, quota_remaining, expires_at }`. `401` bad key · `403` not entitled · `429` quota exceeded. Free — doesn't consume quota. |
| `POST /v1/ingest` | Submit one service's graph, get the diff plus a PR-comment markdown string. Re-validates the key. Commit metadata rides in `X-EKG-Sha` / `X-EKG-Branch` / `X-EKG-Pr` / `X-EKG-Default-Branch` headers so the body stays the pure graph. |

The behaviours that surprise people, up front:

- **The body is stored byte-for-byte** and never re-marshalled. Emit deterministically — stable key
  order, stable collection order — or every scan looks changed.
- **One baseline per `(account, repository, service_id, default_branch)`.** `repository` is in the
  key because `service_id` is usually a directory name and collides across repos.
- **Default-branch scans write the baseline; PR scans never do.**
- **Each accepted ingest decrements quota**, including an unchanged one — it still cost a scan.
- **The backend never talks to GitHub.** It returns the markdown; your CI posts it. That keeps
  repository write credentials out of this service entirely.

## Ask and LLM provider keys

`POST /api/v1/ask` answers natural-language questions about the catalog — *"what depends on
PaymentService?"*, *"which topics have no registered schema?"*

**Bring your own key.** Each account stores its own Anthropic or OpenAI key via Settings → LLM;
Ask spends that key. With no key configured for the chosen model's provider, `/ask` returns `409`
and the UI points the user at Settings. Keys are encrypted at rest, verified against the provider
before being stored (an auth-only call that spends no tokens, so a typo surfaces at save time rather
than as a mysterious failure later), and **never returned by any endpoint** — reads serve a
denormalised `last4`, so that path never decrypts anything.

**Answers can't cite something that isn't there.** This is enforced structurally, not by asking the
model nicely:

1. The model never receives a graph dump. It reaches the catalog only through read-only tools
   (`src/ask/catalog-tools.ts`).
2. Every relationship a tool returns is recorded in a per-request **evidence ledger**, with an id.
3. The model names the ids it used.
4. The backend renders the response's `cites` **from the recorded rows** (`src/ask/evidence.ts`).

An id the model invented resolves to nothing and is dropped. `text` comes from the model; `cites`
and `note` are computed by the backend — `note` from the confidence mix of the citations, so it
stays factual rather than becoming a judgment. A provider failure is always a 4xx/5xx carrying an
`error` string, never a plausible-looking fabricated answer.

Providers sit behind one interface (`src/llm/provider.types.ts`) modelling a single round trip; the
tool loop stays in `AskService`. **Adding a provider is one adapter plus a registry entry** in
`src/llm/model-registry.ts`, which is also the single source of truth for `GET /models`.

## Authentication

Every route requires `Authorization: Bearer <token>` except `GET /health`, `POST /auth/login`,
`POST /auth/sso/start`, and `GET /auth/sso/callback`. Any protected route returns `401` when the
token is missing, expired, or revoked.

**Sessions are opaque, DB-backed tokens — not JWTs.** They're stored as `sha256(token)`, so logout
revokes server-side (a stateless JWT can't be) and a database dump can't be replayed. Passwords are
bcrypt-hashed.

### SSO (real OIDC, multi-tenant)

Each account brings its own identity provider (`SsoConnection`, discovered via
`/.well-known/openid-configuration`), routed by email domain (`SsoDomain`). The flow is
`POST /auth/sso/start` → full-page redirect to the IdP → `GET /auth/sso/callback` completes an
Authorization Code + PKCE exchange, JIT-provisions or links the user under that connection's
account, and mints a session exactly as password login does.

`POST /auth/sso/start` returns the **same response shape** whether a domain has SSO configured, has
it disabled, or has never heard of it. That's deliberate: it prevents using the endpoint to
enumerate which organisations have accounts.

An email that already belongs to a *different* account is always rejected, never silently
reassigned — see `src/auth/sso/sso.service.ts` for the JIT/link/reject rules.

**Testing SSO needs no live IdP.** `test/sso-fixtures.ts` stands up a mock provider by overriding
`globalThis.fetch` for the three URLs `openid-client` calls, so real signature, issuer, audience and
nonce validation run against real crypto.

## Testing

```bash
npm run test:e2e     # the full suite
npm run typecheck    # tsc --noEmit
npm run lint         # eslint --fix
```

The suite boots the real application against a real database, so bring one up first:

```bash
docker compose up -d db && npx prisma migrate dev && npx prisma db seed
```

**No live credentials are required for anything.** Ask runs against a scripted stub provider; the
Anthropic and OpenAI adapters are pinned by pointing the real SDKs at a local server; SSO uses the
mock IdP described above. Set `LLM_VERIFY_KEYS=false` so key saves don't try to reach the internet.

Two notes that will otherwise cost you an afternoon:

- **`--experimental-vm-modules` is mandatory**, not a preference. `openid-client` is ESM-only and its
  dynamic import fails inside Jest's sandboxed context without it. It's already baked into the
  `test:e2e` script.
- Tests run with `maxWorkers: 1` because they share one database.

### Contract fidelity is tested, not assumed

`src/common/integrity.ts` encodes what a strict client enforces — enum validity, edge→node
referential integrity, "an `unknown` node must carry a note", "a producerless topic must be
`uncertain`". It runs at **seed time** and again against **live HTTP responses** in the e2e suite, so
a payload that would break a client can't ship.

| Suite | Covers |
|---|---|
| `contract.e2e-spec.ts` | Read API wire shapes + integrity rules against live responses |
| `ingest.e2e-spec.ts` | Both `/v1` gates, byte-stable baselines, PR vs. default-branch semantics |
| `auth.e2e-spec.ts` / `sso.e2e-spec.ts` | Session lifecycle; full OIDC round trip against a mock IdP |
| `ask-llm.e2e-spec.ts` / `catalog-tools.e2e-spec.ts` | The tool loop and the evidence ledger — the "never invents" guarantee |
| `llm-keys.e2e-spec.ts` / `llm-providers.e2e-spec.ts` | Key storage, verification, and each adapter's wire shape |
| `secret-box.e2e-spec.ts` / `error-body.e2e-spec.ts` | AES-256-GCM round trip; the `{ error }` normalisation |

## Project layout

```
prisma/
  schema.prisma           # the data model (see CLAUDE.md §4)
  migrations/             # ordered, committed alongside schema changes
  seed.ts                 # demo account, login, API key + a small demo fleet
src/
  main.ts                 # bootstrap: global prefix, raw body, validation, error filter, CORS
  common/                 # wire types, enums, query DTOs, integrity checks, error filter, crypto
  auth/                   # login / me / logout, global AuthGuard, @Public()
  auth/sso/               # OIDC: discovery + PKCE client, JIT/link/reject, secret encryption
  ingest/                 # the /v1 control plane
    ingest.service.ts     #   gates, baseline write, orchestration
    graphdiff.ts          #   pure semantic diff over two service bodies
    resolve.ts            #   raw target name → known service | external
    project.ts            #   pure: baselines → catalog (graph + contracts)
    markdown.ts           #   the PR comment
  graph/ contracts/ commits/   # the read endpoints
  ask/                    # the tool loop, catalog tools, evidence ledger, prompt
  llm/                    # provider interface, Anthropic + OpenAI adapters, model registry
  settings/               # LLM provider key storage
  health/  prisma/
test/                     # e2e suites + mock IdP / stub provider fixtures
```

Four files carry most of the interesting logic: `ingest.service.ts` (orchestration),
`graphdiff.ts` and `project.ts` (both pure functions — no DB, no I/O, and the reason the core is
testable without infrastructure), and `catalog-tools.ts` (how the LLM is kept honest).

## Deployment notes

```bash
npm ci
npm run build
npx prisma migrate deploy    # never `migrate dev` outside development
npm run start:prod
```

Before going live:

- **Set `CORS_ORIGINS`** to your actual UI origin. The `*` default is a development convenience.
- **Generate fresh encryption keys** and store them in your secret manager, not in a `.env` file on
  disk. Losing them means re-entering every stored SSO client secret and provider key.
- **Terminate TLS in front of this service.** It speaks plain HTTP; bearer credentials cross the
  wire on every request.
- **Set `BACKEND_PUBLIC_URL`** to the externally reachable URL — it's what every tenant's IdP
  registers as the redirect URI, so getting it wrong breaks SSO for everyone.
- **Don't run the seed.** It creates a known password and a known API key.
- The JSON body cap is 32 MB (service graphs get large); align any proxy limits in front of it.
- `GET /api/v1/health` is your liveness probe and reports database reachability.

## Status and roadmap

Working today: the full read API, the `/v1` ingest control plane with diffing and PR-comment
rendering, password + OIDC SSO authentication, per-account LLM key management, and grounded Ask.

Known gaps, stated plainly:

- **`GET /commits` returns `[]`.** The endpoint, storage, and diff engine all exist; the scanner
  doesn't yet send per-commit metadata, so nothing is projected. Not a bug — a missing upstream feed.
- **Ask has not been exercised against a live provider account.** The tool loop, evidence ledger,
  and both adapters are covered by tests against stubs and pinned wire shapes, but the first real
  Anthropic/OpenAI call is still pending.
- **`databases_used` and `config_dependencies`** are accepted and stored, but not yet projected into
  the catalog.
- **Quota is a placeholder integer.** There's no billing integration behind it.
- **No role model on `User`.** Every member of an account can write that account's provider keys.

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup, conventions, and
what a good pull request looks like. [`CLAUDE.md`](./CLAUDE.md) is the architectural orientation for
contributors and coding agents, including the **invariants that must not break** (§6). Read those
ten rules before changing anything in `src/ingest/` or `src/common/`.

Security issues: please don't open a public issue — see [`SECURITY.md`](./SECURITY.md).

## License

[MIT](./LICENSE) © Farhad Amjady
