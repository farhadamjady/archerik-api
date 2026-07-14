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

Every route requires `Authorization: Bearer <token>` except `POST /auth/login`, `GET /auth/sso`,
and `GET /health` (marked `@Public()`). Any protected route returns `401` when the token is
missing/expired/revoked — which the UI treats globally as "session expired".

| Method & path | Notes |
|---|---|
| `POST /auth/login` | `{ email, password }` → `{ token, user: { name, handle, team } }`; `401` on bad creds |
| `GET /me` | session restore → `{ name, handle, team }`; `401` if token invalid |
| `POST /auth/logout` | revokes the token server-side; best-effort, body ignored |
| `GET /auth/sso` | browser redirect target — returns an HTML page that stores the token and redirects to `APP_URL` |

Tokens are **opaque, DB-backed sessions** (not JWT), stored as a SHA-256 hash; logout revokes them
server-side. Passwords are bcrypt-hashed. Demo login (from the seed): **`demo@acme.com` / `demo1234`**.

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@acme.com","password":"demo1234"}' | jq -r .token)
```

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
npx jest --config ./test/jest-e2e.json   # boots the app against the seeded DB
```

Requires Postgres up and the seed loaded.

## Layout

```
prisma/
  schema.prisma      # graphs / contracts / commits / scans (CLAUDE.md §4)
  demo-data.ts       # the seeded demo dataset
  seed.ts            # validates then persists
src/
  common/            # enums, wire types, query DTOs, graph lookup, integrity checks
  auth/              # login/me/logout/sso, global AuthGuard, @Public() decorator
  ingest/            # extractor /v1 control plane: API-key guard, ingest + graphdiff + markdown
  graph/ contracts/ commits/   # the three P0 modules
  health/  prisma/
```

## Not yet built (later milestones)
- P1 (remaining): `POST /ask` (grounded Q&A), `GET /models`
- P2: real extractor pipeline (git clone → Spring scan → graph/diff), `POST /scan`
