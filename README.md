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

Demo data is seeded for `repo=acme/shop-platform&branch=main`. Example:

```bash
curl 'http://localhost:3000/api/v1/graph?repo=acme/shop-platform&branch=main'
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
  graph/ contracts/ commits/   # the three P0 modules
  health/  prisma/
```

## Not yet built (later milestones)
- P1: auth (`/auth/*`, `/me`), `POST /ask`, `GET /models`
- P2: real extractor pipeline (git clone → Spring scan → graph/diff), `POST /scan`
