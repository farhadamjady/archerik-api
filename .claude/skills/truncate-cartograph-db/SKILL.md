---
name: truncate-cartograph-db
description: Truncate the Cartograph backend DB for a fresh scan/test — deletes all scan data (graphs, contracts, commits, service baselines, scans) while preserving account config (accounts, users, API keys, sessions, LLM provider keys) so the extractor key, demo login and Ask provider keys keep working. Use when the user asks to "truncate the db", "reset for a new scan", or "get ready for another test".
---

# Truncate Cartograph DB

Resets the backend's **scan data** to the empty state so a new extractor scan starts clean,
**without** touching account config — the extractor API key (`ekg_dev_local_demokey`), the demo
login (`demo@acme.com` / `demo1234`) and the account's Anthropic/OpenAI keys keep working.

## What it deletes vs. keeps

**Deleted (scan data):** `Contract`, `Commit`, `Graph`, `ServiceBaseline`, `Scan`
**Kept (account config):** `Account`, `User`, `ApiKey`, `Session`, `LlmProviderKey`

`LlmProviderKey` is account config in the same category as the extractor key, not scan output —
a reset must not force re-entering provider keys in Settings → LLM. (Under `--scope=all` it goes
too, via the `Account` cascade.)

Deletion runs in FK-safe order (Contract/Commit before Graph). It's destructive and
irreversible, so the script requires an explicit `--yes`.

## Usage

Run from the repo root (needs the project's generated `@prisma/client` and the DB env):

```bash
node .claude/skills/truncate-cartograph-db/truncate.mjs --yes
```

To also wipe auth (accounts/users/api keys/sessions) — e.g. a full reset before re-seeding —
add `--scope=all`. After that you must re-run `prisma db seed` to restore the demo key/login.

```bash
node .claude/skills/truncate-cartograph-db/truncate.mjs --yes --scope=all
```

It prints `deleted` and `kept` row counts. Example:

```
deleted (scan data): {"contracts":5,"commits":0,"graphs":1,"baselines":3,"scans":13}
kept: {"accounts":1,"users":2,"apiKeys":1,"sessions":0,"llmKeys":1}
```

## After running

- The read model is empty until the next ingest reprojects it — `GET /api/v1/graph` returns
  `nodes:[]`, `scannedAt:null` (once you have a session; unauthenticated it returns `401`).
- No rebuild/restart is needed just for a truncate — the running server holds no cached graph;
  the account-scoped Graph row is rebuilt on the next ingest via `reprojectAccount`.
- If you changed source or the Prisma schema, that's a separate concern — rebuild + restart the
  detached `dist/main` first (see the dev-backend-restart note).
