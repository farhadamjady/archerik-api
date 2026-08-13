# Archerik Backend — contributor & agent context

Orientation for anyone (human or coding agent) changing this repository. It explains what the
service is, how a request flows through it, and the invariants that must survive every change.

For the wire shapes themselves, the code is the specification — clients validate strictly, so a
comment can drift but the types cannot:

- **Read API (`/api/v1`)** — `src/common/types.ts` for the shapes, `src/common/enums.ts` for the
  permitted values, `test/contract.e2e-spec.ts` for what live responses must satisfy.
- **Ingest API (`/v1`)** — `src/ingest/model.ts` for the body and diff vocabulary,
  `test/ingest.e2e-spec.ts` for the gates and baseline semantics.

---

## 1. What Archerik is

Archerik is a **service catalog** for fleets of Spring Boot microservices, built from static
analysis rather than from a wiki nobody updates.

A scanner walks a repository and reports what it found: the REST endpoints a service exposes, the
services it calls, the Kafka topics it produces and consumes, and the field-level schemas of all of
those. It POSTs that to this backend, one JSON document per service. The backend diffs each
submission against that service's stored baseline, returns a PR-comment-ready summary of what
changed, and re-projects the whole account's fleet into a catalog the UI reads.

On top of the catalog sits **Ask** — natural-language questions answered by an LLM that can only see
the catalog through read-only tools, using the account's own provider key.

### The core principle: honesty about detection

Static analysis has limits, and the interesting question is never "did it find everything" but "does
it tell you what it couldn't find". Archerik's answer:

- every edge and contract carries a **confidence** — `confirmed` (declared in code, e.g.
  `@FeignClient`), `likely` (inferred, e.g. a `WebClient` base URL resolved from config), or
  `uncertain` (a `RestTemplate` call to a runtime variable)
- an unresolvable call target becomes a **visible `unknown` node with a note explaining why**, never
  a dropped edge
- nothing is invented — including by the LLM, which is structurally prevented from citing evidence
  that doesn't exist (§3.3)
- no severity or breaking-change judgments anywhere; the catalog states facts, humans judge them

## 2. System shape

Three repositories, of which this is one:

| Repo | Role |
|---|---|
| `service-discovery` | the scanner — a Go CLI that runs in CI and POSTs one document per service |
| **`service-discovery-backend-chore`** | **this repo** — the control plane: ingest, diff, catalog, Ask |
| `service-discovery-backend-ui` | the web UI that reads the catalog |

Only this backend needs to exist for the API to be useful; the ingest contract is plain HTTP + JSON,
so any scanner that can produce the body typed in `src/ingest/model.ts` works.

**Stack:** NestJS 10 (TypeScript) · PostgreSQL via Prisma · Docker Compose for local Postgres.

## 3. The two APIs

The service exposes two surfaces with **different base paths, different credentials, and different
audiences**. They deliberately do not cross: a session token is rejected at `/v1/*`, and an API key
is rejected at `/api/v1/*`.

```
      CI  ──API key──▶  /v1/*        write   ingest, diff, PR comment
    human ──session──▶  /api/v1/*    read    catalog, contracts, Ask, settings
```

### 3.1 Write side (`/v1`) — `src/ingest/`

`POST /v1/auth/validate` is a free startup gate; `POST /v1/ingest` accepts one service's graph.

The flow inside `ingest.service.ts`: entitlement + service-limit check → byte-compare against the
stored baseline (unchanged ⇒ early return) → `graphdiff.ts` computes the semantic diff →
`resolve.ts` maps each raw target name to a known service or `external` → `markdown.ts` renders the
PR comment → and, **only on a default-branch scan**, the baseline is written and
`account-projection.service.ts` rebuilds the read model.

Two things here are load-bearing:

- **The submitted body is stored as raw bytes and never re-marshalled.** The "unchanged" fast path
  is a literal byte comparison, so re-serialising would reorder keys and break it.
- **A PR scan diffs but never writes the baseline.** A pull request cannot move recorded truth.

### 3.2 Read side (`/api/v1`) — `src/graph/`, `src/contracts/`, `src/commits/`

Scoped to the **account** (the company), derived from the session token — never from a query param.
`GET /graph` with no parameters returns everything the account owns; `repo` and `service` are
optional filters, not required keys. A fresh account with no scans returns `200` with an empty
graph, not a `404`.

The read model is materialised: one `Graph` row per `(account, branch)`, overwritten in place on
every ingest that changes a baseline. Reads are a single row fetch plus filtering, not a join over
baselines.

`GET /commits` currently returns `[]` by design — the scanner doesn't send commit metadata yet, so
no per-commit diffs are projected.

### 3.3 Ask (`POST /api/v1/ask`) — `src/ask/`, `src/llm/`

Bring-your-own-key: the account stores its own Anthropic or OpenAI key (encrypted at rest), and Ask
spends it. No key for the chosen model's provider ⇒ `409`.

Grounding is **structural, not prompted**. The model never receives a graph dump; it reaches the
catalog only through read-only tools in `catalog-tools.ts`. Every relationship a tool returns is
recorded in a per-request evidence ledger with an id. The model names the ids it used, and the
backend renders the response's `cites` from the *recorded rows* — so an id the model invented
resolves to nothing and is dropped. `text` comes from the model; `cites` and `note` are computed by
the backend. A provider failure is always a 4xx/5xx with an `error` string, never a fabricated
answer.

Providers sit behind one interface (`llm/provider.types.ts`) modelling a single round trip. Adding
one is an adapter plus an entry in `llm/model-registry.ts`, which is also the source of truth for
`GET /models`.

### 3.4 Auth — `src/auth/`

Sessions are **opaque, DB-backed tokens**, not JWTs, stored as `sha256(token)` — so logout can
revoke server-side and a database dump can't be replayed. Passwords are bcrypt-hashed.

SSO is real multi-tenant OIDC: each account brings its own IdP, routed by email domain, Authorization
Code + PKCE, with JIT provisioning. An email already belonging to a *different* account is always
rejected, never silently reassigned.

## 4. Data model

Prisma schema in `prisma/schema.prisma`. The shape follows one idea: **store the extractor's truth
verbatim, and materialise everything else.**

| Table | Role |
|---|---|
| `service_baselines` | the source of truth — the scanner's byte-stable JSON per `(account, repository, service_id, default_branch)` |
| `graphs` | materialised read model, one row per `(account, branch)`, overwritten in place |
| `contracts` | endpoints/topics belonging to a graph row |
| `commits` | per-commit change records (unpopulated until the scanner sends commit metadata) |
| `scans` | one row per ingest call — the account's audit/metering log, including rejections |
| `accounts`, `api_keys` | tenants and their scanner credentials (keys stored hashed) |
| `users`, `sessions` | login and opaque session tokens (both hashed) |
| `sso_connections`, `sso_domains`, `sso_auth_requests` | per-tenant OIDC config and in-flight logins |
| `llm_provider_keys` | per-account provider keys, encrypted at rest, with `last4` denormalised |

Three storage decisions worth knowing before you change them:

- **Hashed vs. encrypted is not a style choice.** Credentials presented *to* us (API keys, session
  tokens) are hashed — we only ever compare them. Credentials we present *onward* (OIDC client
  secrets, LLM provider keys) are encrypted with AES-256-GCM, because they must be recoverable.
  `SSO_ENCRYPTION_KEY` and `LLM_ENCRYPTION_KEY` are deliberately separate variables so one leaked
  key doesn't unlock both classes.
- **`last4` is stored in the clear on purpose.** The endpoint the UI polls needs only "configured +
  last four characters", so that read path never loads the encryption key or holds a plaintext key
  in memory.
- **`repository` is part of the baseline key.** `service_id` is a directory name and collides across
  repos; without `repository` in the key, two `order-service`s clobber each other.

## 5. Ingest → catalog projection

`src/ingest/project.ts` is a **pure, deterministic function** — no DB, no I/O — from a list of parsed
service bodies to `{ graph, contracts }`. That purity is why it can run both in the seed script and
in production ingest and produce identical output, and why it's testable without a database.

It builds nodes for scanned services (id = `<system>/<serviceId>`, globally unique), resolves each
outbound dependency to a scanned service / `external` host / `unknown` bucket, deduplicates
endpoints and topics into contracts, and assigns confidence.

`account-projection.service.ts` wraps it with persistence: it takes a `Prisma.TransactionClient` so
the reprojection commits atomically with the ingest that triggered it, and takes a transaction-scoped
advisory lock keyed on `(account, branch)` so two concurrent ingests touching `main` can't race on
the delete-then-create.

## 6. Invariants — do not break

These are enforced in code (`src/common/integrity.ts`, run at seed time *and* against live HTTP
responses in the e2e suite) because the UI validates strictly and fails the whole load on a
violation. Breaking one is a user-visible outage, not a lint warning.

1. **Every edge and contract carries a confidence.** Never infer without marking the level.
2. **Unresolved targets stay visible.** A call that can't be resolved becomes an `unknown` node
   **with a note explaining why** — never a dropped edge. `validateGraph` rejects a note-less
   `unknown` node.
3. **A Kafka topic with no producer in scan scope is `uncertain`.** A consumer's own
   `@KafkaListener` confidence must not promote the topic.
4. **Edge endpoints must reference real nodes.** Every `edge.from` / `edge.to` must match a node id,
   and every node's `team` must exist in `teams[]`.
5. **Enums are exact lowercase strings.** `confidence: confirmed|likely|uncertain`,
   `protocol: rest|kafka|grpc|websocket|unknown`, node `type: service|external|unknown`. `method` is
   the deliberate exception — a free display string, passed through verbatim, never validated.
6. **Nothing is invented.** For extraction that means recording uncertainty instead of guessing; for
   Ask it means citations are rendered from the evidence ledger, so a made-up id resolves to nothing.
7. **No breaking-change or severity judgments.** All API text is factual and neutral. This applies
   especially to the PR-comment markdown, which lands verbatim in front of reviewers.
8. **Derived vs. declared.** REST callers and Kafka consumers are *derived* from the callers' code,
   not declared by the service. Use that wording in API text.
9. **Every non-2xx body is `{ "error": "<string>" }`** and nothing else — including validation and
   rate-limit rejections, normalised by `src/common/error-body.filter.ts`.
10. **Secrets fail closed.** No encryption key ⇒ the app refuses to start rather than falling back to
    a default. Never add a default value for `SSO_ENCRYPTION_KEY` or `LLM_ENCRYPTION_KEY`.

## 7. Working in this repo

```bash
npm run start:dev     # watch mode
npm run typecheck     # tsc --noEmit
npm run lint          # eslint --fix
npm run test:e2e      # needs Postgres up + seed loaded
```

Notes that will save you time:

- **The e2e suite needs a real database.** `docker compose up -d db && npx prisma migrate dev &&
  npx prisma db seed` first. Tests run with `maxWorkers: 1` because they share it.
- **`--experimental-vm-modules` is required**, not optional — `openid-client` is ESM-only and its
  dynamic import fails inside Jest's sandbox without it. It's already in the `test:e2e` script.
- **No live credentials are needed for any test.** SSO runs against a mock IdP built by overriding
  `globalThis.fetch` (real crypto, real signature/nonce validation); Ask runs against a scripted stub
  provider; the provider adapters are pinned by pointing the real SDKs at a local server.
- **Set `LLM_VERIFY_KEYS=false` for offline work**, or every key save fails trying to reach the
  provider.
- **Changing `prisma/schema.prisma` means a migration** (`npx prisma migrate dev --name <what>`),
  committed alongside the schema change.
