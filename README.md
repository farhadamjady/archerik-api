# Cartograph Backend

Engineering knowledge-graph backend. See [`CLAUDE.md`](./CLAUDE.md) for the service overview and
[`API-CONTRACT.md`](./API-CONTRACT.md) for the UI-facing contract (the authoritative wire shapes).

**Milestone 1 (this repo):** the P0 read API served over a seeded demo dataset — enough for the UI
to drop its mock builders. The static-analysis extractor is a later milestone.

## Stack
NestJS · PostgreSQL (Prisma) · Docker Compose (local Postgres).

## Quick start

```bash
cp .env.example .env
docker compose up -d db          # Postgres on :5432
npm install
npx prisma migrate dev           # create schema
npx prisma db seed               # load the demo dataset (runs integrity checks first)
npm run start:dev                # http://localhost:3000/api/v1
```

Optional DB UI: `docker compose --profile tools up -d adminer` → http://localhost:8080.

## P0 endpoints (all under `/api/v1`)

| Method & path | Returns |
|---|---|
| `GET /graph?repo=&branch=&at=` | `{ repo, branch, scannedAt, teams[], nodes[], edges[] }` |
| `GET /contracts?repo=&branch=&at=&protocol=` | `{ endpoints[], topics[] }` |
| `GET /commits?repo=&branch=&limit=&since=` | **bare array** of commits (newest first) |
| `GET /health` | liveness + DB status |

Demo data is seeded for `repo=acme/shop-platform&branch=main`. These endpoints require a bearer
token (see Auth below):

```bash
curl 'http://localhost:3000/api/v1/graph?repo=acme/shop-platform&branch=main' \
  -H "Authorization: Bearer $TOKEN"
```

## Auth (P1)

Every route requires `Authorization: Bearer <token>` except `POST /auth/login`,
`POST /auth/sso/start`, `GET /auth/sso/callback`, and `GET /health` (marked `@Public()`). Any
protected route returns `401` when the token is missing/expired/revoked — which the UI treats
globally as "session expired".

| Method & path | Notes |
|---|---|
| `POST /auth/login` | `{ email, password }` → `{ token, user: { name, handle, team } }`; `401` on bad creds |
| `GET /me` | session restore → `{ name, handle, team }`; `401` if token invalid |
| `POST /auth/logout` | revokes the token server-side; best-effort, body ignored |
| `POST /auth/sso/start` | `{ email }` → `{ sso: true, redirectUrl }` or `{ sso: false }` (same shape either way — no domain enumeration); rate-limited |
| `GET /auth/sso/callback` | IdP redirect target — on success, an HTML page that stores the token and redirects to `APP_URL`; on failure, redirects to `APP_URL?sso_error=1` |

Tokens are **opaque, DB-backed sessions** (not JWT), stored as a SHA-256 hash; logout revokes them
server-side. Passwords are bcrypt-hashed. Demo login (from the seed): **`demo@acme.com` / `demo1234`**.

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@acme.com","password":"demo1234"}' | jq -r .token)
```

### SSO (real OIDC, multi-tenant)

Each account brings its own IdP (`SsoConnection`, discovered via OIDC's
`/.well-known/openid-configuration`), routed by email domain (`SsoDomain`). Login is
`POST /auth/sso/start` → full-page redirect to the IdP → `GET /auth/sso/callback` completes the
Authorization Code + PKCE exchange, JIT-provisions or links the `User` under the connection's
account, and mints a session the same way password login does. See
`src/auth/sso/sso.service.ts` for the JIT/link/reject rules (an email that already belongs to a
*different* account is always rejected — never silently reassigned).

Env vars: `BACKEND_PUBLIC_URL` (this backend's externally reachable URL — every tenant's IdP
registers `${BACKEND_PUBLIC_URL}/api/v1/auth/sso/callback` as the redirect URI),
`SSO_ENCRYPTION_KEY` (32-byte base64, `openssl rand -base64 32` — encrypts each connection's OIDC
client secret at rest; no default, fails closed if unset), `SSO_STATE_TTL_MINUTES`.

No live IdP needed for testing — `test/sso-fixtures.ts` stands up a mock IdP by overriding
`globalThis.fetch` for the three URLs `openid-client` calls (discovery/jwks/token), so real
signature/iss/aud/nonce validation runs against real crypto. Run via `npm run test:e2e`, which
passes Node's `--experimental-vm-modules` flag — required for `openid-client`'s dynamic ESM import
to work inside Jest's sandboxed test context (see the comment in `src/auth/sso/oidc-client.ts`).

## Ask (`POST /api/v1/ask`) and LLM provider keys

Ask answers questions about the catalog with an LLM, using **the account's own provider key**
(bring-your-own-key). Keys are managed in Settings → LLM (`GET/PUT/DELETE
/api/v1/settings/llm-keys`), stored encrypted at rest, and never returned by any endpoint — reads
serve a denormalised `last4` so that path never decrypts. Supported providers: `anthropic`,
`openai`. With no key configured for the chosen model's provider, `/ask` returns `409`.

**Answers can't cite something that isn't there.** The model reaches the graph only through
read-only catalog tools (`src/ask/catalog-tools.ts`) — never a raw dump. Every relationship a tool
returns is recorded in a per-request evidence ledger with an id; the model names the ids it used;
the backend renders `cites` from the recorded rows (`src/ask/evidence.ts`). An invented id resolves
to nothing and is dropped, so CLAUDE.md §6's "never invents" holds structurally rather than by the
model's cooperation. `text` comes from the model; `cites` and `note` are computed by the backend.
A provider failure is always a `4xx`/`5xx` with an `error` string, never a fabricated answer.

Providers live behind one interface (`src/llm/provider.types.ts`) modelling a single round trip;
the tool loop stays in `AskService`. Adding a provider is one adapter plus a registry entry in
`src/llm/model-registry.ts`, which is also the single source of truth for `GET /models`.

Env vars: `LLM_ENCRYPTION_KEY` (32-byte base64, `openssl rand -base64 32` — separate from
`SSO_ENCRYPTION_KEY` so one leaked key doesn't unlock both; no default, fails closed if unset),
`LLM_VERIFY_KEYS` (default on — validates a key against the provider before storing it; set
`false` for offline dev/CI, where there's no egress), `LLM_REQUEST_TIMEOUT_MS` (default 60000).

No provider account needed for testing: `test/ask-llm.e2e-spec.ts` scripts a stub provider through
the whole loop, and `test/llm-providers.e2e-spec.ts` pins each adapter's wire shape by pointing the
real SDKs at a local server.

## Extractor control plane (`/v1`)

The `service-discovery` Go CLI submits scan results here. These routes are the **ingest side** — a
separate contract ([`../service-discovery/docs/BACKEND_CONTRACT.md`](../service-discovery/docs/BACKEND_CONTRACT.md))
with a **different auth model and base path** from the UI API: they sit at `/v1` (not `/api/v1`) and
authenticate with a long-lived **API key** (`Authorization: Bearer <key>`), not a session token. The
two credential types don't cross: a session token is rejected at `/v1/*` and an API key at `/api/v1/*`.

| Method & path | Notes |
|---|---|
| `POST /v1/auth/validate` | Startup entitlement gate. Empty body → `{ plan, quota_remaining, expires_at }`. `401` bad key · `403` not entitled · `429` quota exceeded — the CLI maps these to exit codes. |
| `POST /v1/ingest` | Submit a service graph + get the diff. Re-validates the key (`401`). Commit metadata rides in `X-EKG-Sha/Branch/PR/Default-Branch` headers; the body stays the pure graph. |

**Ingest semantics** (per the contract):
- The request body is stored **byte-for-byte** (raw `bytea`). The "unchanged" fast path is a raw byte
  compare — we never re-marshal, which would reorder keys and break it.
- One baseline per `(account, service_id, default_branch)`. A **default-branch** scan diffs *and*
  updates the baseline; a **PR** scan (any other branch) diffs but **never** writes it.
- Identity keys match the extractor exactly (`method+" "+path`, `target_name+"|"+detection`,
  `topic+"|"+direction`) so diffs don't desync.
- `target_resolutions` maps each dependency to a known `service_id` or `"external"`, resolved from the
  fleet registry (every service that has scanned its default branch is "known").
- Each successful ingest **decrements quota** (`validate` is a free pre-check; quota is a placeholder
  int for now).

```bash
KEY=ekg_dev_local_demokey   # seeded for local dev
curl -X POST http://localhost:3000/v1/ingest \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'X-EKG-Sha: abc123' -H 'X-EKG-Default-Branch: main' \
  --data-binary @service.json
```

## Contract fidelity

`API-CONTRACT.md` wins wherever it disagrees with `CLAUDE.md`, because the UI validates strictly and
fails loudly. Notably: base path is `/api/v1`; nodes omit `deg/inDeg/outDeg` (UI computes them);
`/commits` is a bare array (no `{ commits: [...] }` wrapper); every node carries a `team`.

`src/common/integrity.ts` encodes the UI's validation rules (enum checks + edge→node referential
integrity). It runs at **seed time** and again against **live HTTP responses** in the e2e test, so a
payload that would trip the UI can't ship.

## Tests

```bash
npm run test:e2e   # boots the app against the seeded DB
```

Requires Postgres up and the seed loaded. Runs Jest with Node's `--experimental-vm-modules` flag —
needed for the SSO tests' dynamic import of `openid-client` (ESM-only) to work inside Jest.

## Layout

```
prisma/
  schema.prisma      # graphs / contracts / commits / scans (CLAUDE.md §4)
  demo-data.ts       # the seeded demo dataset
  seed.ts            # validates then persists
src/
  common/            # enums, wire types, query DTOs, graph lookup, integrity checks
  auth/              # login/me/logout, global AuthGuard, @Public() decorator
  auth/sso/          # real OIDC SSO: discovery/PKCE client, JIT/link/reject, secret encryption
  ingest/            # extractor /v1 control plane: API-key guard, ingest + graphdiff + markdown
  graph/ contracts/ commits/   # the three P0 modules
  health/  prisma/
```

## Not yet built (later milestones)
- P1 (remaining): `POST /ask` (grounded Q&A), `GET /models`
- P2: real extractor pipeline (git clone → Spring scan → graph/diff), `POST /scan`
