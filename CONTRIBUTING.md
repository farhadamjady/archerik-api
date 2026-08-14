# Contributing to Archerik API

Thanks for considering a contribution. This document is the working guide for
the codebase — read §2 and §3 before your first change; they are what keep the
catalog trustworthy and the clients working.

## Getting set up

You need **Node.js ≥ 20** and **Docker** (for Postgres).

```sh
git clone https://github.com/farhadamjady/archerik-api
cd archerik-api
npm install

cp .env.example .env
echo "SSO_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "LLM_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "LLM_VERIFY_KEYS=false" >> .env    # offline dev: don't call out to verify a saved key

docker compose up -d db
npx prisma migrate dev
npx prisma db seed
npm run start:dev
```

The gate every change must pass, and what CI runs:

```sh
npm run lint:check && npm run typecheck && npm run build && npm run test:e2e
```

Two things that will otherwise cost you an afternoon:

- **The e2e suite needs a real database.** It boots the real application against
  Postgres. Bring the container up and seed it first. Tests run with
  `maxWorkers: 1` because they share one database.
- **`--experimental-vm-modules` is mandatory**, not a preference. `openid-client`
  is ESM-only and its dynamic import fails inside Jest's sandbox without it. It
  is already baked into the `test:e2e` script.

No live credentials are needed for any test. SSO runs against a mock IdP built by
overriding `globalThis.fetch` (real crypto, real signature and nonce validation),
Ask runs against a scripted stub provider, and the provider adapters are pinned by
pointing the real SDKs at a local server.

## 1. Architecture in ten lines

- **Two API surfaces, deliberately kept apart.** CI writes at `/v1` with an API
  key; humans read at `/api/v1` with a session token. Neither credential works on
  the other's routes.
- **The extractor's submission is the source of truth.** It is stored as raw
  bytes, exactly as sent, and never re-marshalled.
- **Everything else is derived.** The catalog is a materialised projection
  rebuilt from those bytes on every ingest that changes something.
- **`project.ts` and `graphdiff.ts` are pure functions** — data in, data out, no
  database, no I/O. That is why the projection is testable without infrastructure
  and why the seed and production ingest produce identical output.
- **The read model is one row per `(account, branch)`**, overwritten in place.
  Reads are a single row fetch plus filtering, not a join over baselines.
- **Ask is grounded structurally, not by prompting.** The model never receives a
  graph dump; it reaches the catalog only through the read-only tools in
  `catalog-tools.ts`, and citations are rendered from a server-side evidence
  ledger.

`CLAUDE.md` is the long-form version: request flow, storage rationale, and the
ten invariants.

## 2. The invariants

These are enforced in code (`src/common/integrity.ts`), at seed time *and*
against live HTTP responses in the e2e suite, because the UI validates strictly
and fails the whole load on a violation. Breaking one is a user-visible outage,
not a lint warning. The full list is `CLAUDE.md` §6; the ones people hit are:

1. **Every edge and contract carries a confidence.** Never infer without marking
   the level: `confirmed` (declared in code), `likely` (inferred from config),
   `uncertain` (not statically resolvable).
2. **Unresolved targets stay visible.** A call that cannot be resolved becomes an
   `unknown` node **with a note explaining why** — never a dropped edge.
3. **Nothing is invented.** For extraction that means recording uncertainty
   instead of guessing; for Ask it means citations come from the evidence ledger,
   so a made-up id resolves to nothing and is dropped.
4. **No severity or breaking-change judgments anywhere.** The catalog states
   facts; humans judge them. This applies especially to the PR-comment markdown,
   which lands verbatim in front of reviewers.
5. **Every non-2xx body is `{ "error": "<string>" }`** and nothing else,
   including validation and rate-limit rejections.
6. **Secrets fail closed.** No encryption key means the process refuses to start.
   Never add a default for `SSO_ENCRYPTION_KEY` or `LLM_ENCRYPTION_KEY`.

## 3. Changing a wire shape is changing a contract

Three repositories share these shapes, and the other two validate strictly:

| If you change… | You may break… |
|---|---|
| `src/common/types.ts`, `src/common/enums.ts` | `archerik-ui` |
| `src/ingest/model.ts`, the `/v1` request/response | `archerik-extractor` |
| the sessionStorage key in `src/auth/sso/sso-html.ts` | `archerik-ui`'s SSO login |
| the `X-Archerik-*` / `X-EKG-*` ingest headers | every CI pipeline in the field |

So:

- Say so **explicitly in the PR description** when a wire shape changes.
- Prefer additive changes. The ingest headers accept both the canonical
  `X-Archerik-*` names and the legacy `X-EKG-*` names precisely because the
  extractor ships on its own schedule; removing the legacy spelling would break
  every pipeline running an older binary.
- Pin the new shape in `test/contract.e2e-spec.ts` or `test/ingest.e2e-spec.ts`.
  Those suites assert against live HTTP responses, not fixtures.

## 4. Database changes

A change to `prisma/schema.prisma` needs a migration in the same PR:

```sh
npx prisma migrate dev --name what_changed
```

Commit the generated `prisma/migrations/` directory alongside the schema change.
CI runs `prisma migrate deploy`, which will fail on a schema edit with no
migration.

## 5. House style

- **Comments explain _why_, not _what_.** If a decision would look arbitrary to
  someone reading it cold, write down the constraint that forced it.
- **Keep the pure things pure.** `graphdiff.ts` and `project.ts` take data and
  return data. Needing the database inside one means the call belongs a layer up.
- **Stay factual in anything a user reads.** No severity ratings or
  "breaking change" labels in API text or the PR-comment markdown.
- Prettier and ESLint are the formatter of record; `npm run lint` fixes both.

## 6. Pull requests

- One concern per PR; no unrelated refactors alongside a fix.
- The full gate green, with tests for the behavior you changed.
- If the change affects a wire shape, say so explicitly — see §3.

## 7. Scope

Deliberately **out of scope**: making severity or breaking-change judgments,
giving the LLM unrestricted access to the database rather than retrieval through
tools, and storing scanned source code. Deferred for now: per-commit history
(the endpoint and storage exist; the extractor does not yet send commit
metadata), projecting `databases_used` and `config_dependencies` into the
catalog, a role model on `User`, and billing behind `quota_remaining`.

A PR that makes the catalog look more complete by guessing will be declined,
even if it raises the numbers. An honest `uncertain` beats a confident wrong
edge.
