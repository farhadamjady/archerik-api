<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/archerik-lockup-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./assets/archerik-lockup-light.svg">
  <img src="./assets/archerik-lockup-light.svg" alt="Archerik" width="248">
</picture>

### A service catalog for Spring Boot fleets — built from static analysis, and honest about what it couldn't figure out

[![License: MIT](https://img.shields.io/badge/License-MIT-00B3CB?style=flat-square&labelColor=005865)](./LICENSE)
[![Tests](https://img.shields.io/badge/e2e-117%20passing-00B3CB?style=flat-square&labelColor=005865)](#-testing)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![NestJS](https://img.shields.io/badge/NestJS-10-e0234e?style=flat-square&logo=nestjs&logoColor=white)](https://nestjs.com)
[![Prisma](https://img.shields.io/badge/Prisma-5-2D3748?style=flat-square&logo=prisma&logoColor=white)](https://prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?style=flat-square&logo=postgresql&logoColor=white)](https://postgresql.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)

**[Quick start](#-quick-start)** · **[How it works](#-how-it-works)** · **[API](#-api-reference)** · **[Ask](#-ask--bring-your-own-key)** · **[Contributing](#-contributing)**

</div>

---

A scanner walks your repositories and reports what it found: the REST endpoints each service
exposes, the services it calls, the Kafka topics it produces and consumes, and the field-level
schemas of all of those. It POSTs that here.

This backend diffs each submission against that service's stored baseline, hands CI a ready-to-post
PR comment describing what changed, and projects the whole fleet into a catalog your UI can read —
plus an **Ask** endpoint that answers questions about the catalog using an LLM that can only see
what's actually in it. 🔍

```
🏗  scan  →  📊 diff  →  💬 PR comment  →  🗂  catalog  →  🤖 ask
```

---

## 💡 Why it exists

Every organisation past about fifteen services has the same three problems:

> 🤷 Nobody knows who calls this endpoint.
> 😱 Nobody noticed when that Kafka schema gained a field.
> 🕸️ The architecture diagram was last accurate in 2023.

Tools that solve this by asking teams to maintain a manifest fail for the obvious reason. Tools that
solve it with runtime tracing miss the code paths that didn't fire today. Archerik reads the
source — and, crucially, **tells you where reading the source wasn't enough.**

That last part is the design centre of this project:

| Principle | What it means |
|---|---|
| **Confidence on everything** | Every edge is `confirmed` (declared in code — `@FeignClient`, a literal `KafkaTemplate.send("topic")`), `likely` (inferred — a `WebClient` base URL from config), or `uncertain` (guessed — a `RestTemplate` call to a runtime variable). |
| **Unresolved stays visible** | A call to a hostname matching no scanned service doesn't vanish. It becomes an `unknown` node carrying a note explaining *why* it couldn't be resolved. Deleting it would be a lie by omission. |
| **Nothing is invented** | Not by the extractor, and not by the LLM — Ask's citations are rendered from a server-side evidence ledger, so a made-up citation resolves to nothing and is dropped. |
| **No judgments** | The catalog reports that a field changed type. It does not tell you that's a breaking change. Severity is a human call with context the tool doesn't have. |

> [!IMPORTANT]
> If you only remember one thing about this codebase: **uncertainty is data, not an error state.**

### The confidence ladder

```
 confirmed  ████████████  declared in code       @FeignClient, KafkaTemplate.send("orders")
 likely     ████████░░░░  inferred from config   WebClient base URL resolved from properties
 uncertain  ████░░░░░░░░  genuinely a guess      RestTemplate to a runtime variable host
```

Every one of the three is a legitimate, shippable answer. The failure mode this project refuses is
quietly promoting the third into the first so the output looks tidier.

---

## ⚙️ How it works

A scan arrives at `POST /v1/ingest`, one service per request. The backend checks the account's
entitlement and service limit, byte-compares the body against that service's stored baseline (a
match ends the request there), computes a semantic diff, resolves each dependency's raw target name
to a known service or `external`, and renders the PR-comment markdown. On a **default-branch** scan
only, it then writes the new baseline and re-projects the account's whole fleet into the catalog
that `GET /api/v1/graph` serves.

### 🔐 Two API surfaces, deliberately kept apart

CI writes at `/v1` with a long-lived **API key**. Humans read at `/api/v1` with a short-lived
**session token**. Neither credential works on the other's routes.

| | Ingest API | Read API |
|---|---|---|
| **Path** | `/v1` | `/api/v1` |
| **Credential** | API key (long-lived) | session token (7 days) |
| **Audience** | CI, a machine | a human in a browser |
| **Direction** | write | read |

A leaked CI key cannot read a user's catalog. A stolen session cannot forge scan data. 🛡️

### 📦 The scanner's output is truth; everything else is derived

Each submission is stored as **raw bytes, exactly as sent**. The catalog you read is a materialised
projection rebuilt from those bytes on every ingest that changes something.

That's why the "nothing changed" fast path can be a literal byte comparison ⚡, and why the
projection function is pure enough to unit-test without a database. 🧪

### 🚦 Pull requests can't move recorded truth

A scan of a feature branch produces a diff and a PR comment — but **never** overwrites the baseline.
Only a default-branch scan does that.

> [!NOTE]
> The scanner itself lives in a separate repository (a Go CLI). Nothing here is Go-specific — the
> ingest contract is plain HTTP and JSON, so **any** program that can produce the body typed in
> `src/ingest/model.ts` works — there's a complete worked example under [Quick start](#-quick-start). 🐍 🦀 ☕ 🐹

---

## 🚀 Quick start

**You'll need:** Node.js ≥ 20 · Docker · `openssl`

```bash
git clone https://github.com/farhadamjady/service-discovery-backend-chore.git
cd service-discovery-backend-chore
npm install
```

**1️⃣ Config** — the two encryption keys have no defaults on purpose. The app refuses to start
without them.

```bash
cp .env.example .env
echo "SSO_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "LLM_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "LLM_VERIFY_KEYS=false" >> .env   # offline dev: don't call out to verify a saved key
```

**2️⃣ Database**

```bash
docker compose up -d db      # 🐘 Postgres 16 on :5432
npx prisma migrate dev       # create the schema
npx prisma db seed           # demo account, login, API key + a small demo fleet
```

**3️⃣ Run** 🎉

```bash
npm run start:dev            # http://localhost:3000
```

The seed prints what it created:

```
Demo login: demo@acme.com / demo1234
Extractor API key (Bearer): ekg_dev_local_demokey
```

### 🧪 Kick the tyres

```bash
# ❤️ Health — the one route needing no credential at all.
curl -s localhost:3000/api/v1/health
# {"status":"ok","db":"up"}

# 🎫 Log in and read the whole account's catalog.
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@acme.com","password":"demo1234"}' | jq -r .token)

curl -s localhost:3000/api/v1/graph -H "Authorization: Bearer $TOKEN" | jq '.nodes | length'
curl -s localhost:3000/api/v1/contracts -H "Authorization: Bearer $TOKEN" | jq '.endpoints[0]'
```

> [!TIP]
> No repo or branch parameter needed. Reads are scoped to the account behind your session token —
> `repo` and `service` are optional **filters**, not required keys.

<details>
<summary><b>📤 Submit a scan and watch the catalog grow</b></summary>

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

> ⚠️ Use `--data-binary`, not `-d`. `-d` strips newlines, which changes the bytes and defeats the
> unchanged-scan fast path.

</details>

<details>
<summary><b>🔎 Optional: a database UI</b></summary>

```bash
docker compose --profile tools up -d adminer   # http://localhost:8080
```

Server `db`, user / password / database all `cartograph` — the local Compose credentials still carry
the project's former name, and renaming them would orphan every existing dev volume.

</details>

---

## 🎛️ Configuration

All configuration is environment variables. [`.env.example`](./.env.example) documents each one
inline and is the file to copy.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | 🐘 Postgres connection string. Matches Compose out of the box. |
| `PORT` | `3000` | HTTP listen port. |
| `CORS_ORIGINS` | `*` | Comma-separated allow-list. **Set this to your real UI origin in production.** |
| `SESSION_TTL_HOURS` | `168` | Session lifetime (7 days). |
| `APP_URL` | `http://localhost:5173` | Where the SSO callback lands the browser — your frontend. |
| `BACKEND_PUBLIC_URL` | — | This backend's externally reachable URL. Every tenant's IdP registers `${BACKEND_PUBLIC_URL}/api/v1/auth/sso/callback` as its redirect URI. |
| `SSO_ENCRYPTION_KEY` | — | **Required.** 32-byte base64. Encrypts each SSO connection's OIDC client secret. |
| `SSO_STATE_TTL_MINUTES` | `10` | How long an in-flight SSO login stays valid. |
| `LLM_ENCRYPTION_KEY` | — | **Required.** 32-byte base64. Encrypts stored provider API keys. |
| `LLM_VERIFY_KEYS` | `true` | Verify a provider key before storing it. Set `false` offline, or every save fails. |
| `LLM_REQUEST_TIMEOUT_MS` | `60000` | Per-request provider timeout. Keep it under your proxy's. |

### 🔐 On the two encryption keys

> [!WARNING]
> They have **no defaults and the app fails closed without them.** A shipped default would mean every
> deployment that never set one shares a key published in this repository — which is
> indistinguishable from storing the secrets in plaintext.

They're **two separate variables** rather than one, so a leak of one doesn't unlock both classes of
secret. Losing them isn't recoverable: rotate by re-entering the affected SSO client secrets and
provider keys.

**Hashed vs. encrypted isn't arbitrary** 👇

| | Examples | Storage | Why |
|---|---|---|---|
| Presented **to** us | API keys, session tokens, passwords | 🔒 SHA-256 (bcrypt for passwords) | We only ever compare them. A DB dump can't be replayed. |
| Presented **onward** | OIDC client secrets, LLM provider keys | AES-256-GCM | They must be recoverable to be sent upstream. |

---

## 📡 API reference

Two surfaces. The exact wire shapes are defined by the code that serves them —
`src/common/types.ts` and `src/common/enums.ts` for the read side, `src/ingest/model.ts` for the
ingest side — and pinned against live responses in `test/contract.e2e-spec.ts` and
`test/ingest.e2e-spec.ts`.

> [!IMPORTANT]
> **Every non-2xx body is `{ "error": "<string>" }` and nothing else** — including validation
> failures and rate-limit rejections, which are normalised into the same shape. Clients can render
> `error` verbatim on any failure without a fallback path. ✨

### 👤 Read API (`/api/v1`)

Session token required (`Authorization: Bearer <token>`) except where marked **public**. Scoped to
the account the user belongs to — derived from the token, never from a query parameter.

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
| `GET /commits` | Bare array of architecture-relevant commits. Currently `[]` — see [Status](#-status--roadmap). |
| `POST /ask` | Grounded Q&A over the catalog. Rate-limited. |
| `GET /models` | The Ask model picker's options. |
| `GET /settings/llm-keys` | One status entry per provider — never the key itself. |
| `PUT /settings/llm-keys` | Store a provider key (verified first, then encrypted). |
| `DELETE /settings/llm-keys/:provider` | `204`, idempotent. |

**Optional filters** on `/graph`, `/contracts`, `/commits`: `repo`, `service`, `branch` (default
`main`), `at` (commit SHA) — plus `protocol` on `/contracts` and `since`/`limit` on `/commits`.

A fresh account with no scans returns `200` with an empty payload, **not** `404` — render a "no scans
yet" state, not an error. 🫙

<details>
<summary><b>Two shape details that trip people up</b></summary>

- Nodes deliberately **omit** `deg` / `inDeg` / `outDeg` — compute them client-side.
- `/commits` is a **bare array**, with no `{ commits: [...] }` envelope.

Clients validate strictly, so both matter.

</details>

### 🤖 Ingest API (`/v1`)

API key required. The body shape, diff format and resolution rules are typed in
`src/ingest/model.ts`; `test/ingest.e2e-spec.ts` exercises the whole round trip.

| Method & path | Notes |
|---|---|
| `POST /v1/auth/validate` | Startup gate. Empty body → `{ plan, quota_remaining, expires_at }`. `401` bad key · `403` not entitled · `429` quota exceeded. **Free** — doesn't consume quota. |
| `POST /v1/ingest` | Submit one service's graph, get the diff + PR-comment markdown. Re-validates the key. Commit metadata rides in `X-EKG-*` headers so the body stays the pure graph. |

The behaviours that surprise people, up front:

- 🧬 **The body is stored byte-for-byte** and never re-marshalled. Emit deterministically — stable key
  order, stable collection order — or every scan looks changed.
- 🗝️ **One baseline per `(account, repository, service_id, default_branch)`.** `repository` is in the
  key because `service_id` is usually a directory name and collides across repos.
- 🌿 **Default-branch scans write the baseline; PR scans never do.**
- 💳 **Each accepted ingest decrements quota** — including an unchanged one. It still cost a scan.
- 🙅 **The backend never talks to GitHub.** It returns the markdown; your CI posts it. That keeps
  repository write credentials out of this service entirely.

---

## 🤖 Ask — bring your own key

`POST /api/v1/ask` answers natural-language questions about the catalog:

> 💬 *"What depends on PaymentService?"*
> 💬 *"Which topics have no registered schema?"*
> 💬 *"What would break if I renamed this endpoint?"*

**Each account stores its own Anthropic or OpenAI key** via Settings → LLM; Ask spends that key. With
no key configured for the chosen model's provider, `/ask` returns `409` and the UI points the user at
Settings.

Keys are encrypted at rest 🔐, verified against the provider before storing (an auth-only call that
spends no tokens, so a typo surfaces at save time rather than as a mysterious failure later), and
**never returned by any endpoint** — reads serve a denormalised `last4`, so that path never decrypts.

### 🔒 Answers can't cite something that isn't there

```mermaid
flowchart LR
    Q[Question] --> M[Model]
    M -->|calls| T[Catalog tools, read-only]
    T -->|returns rows| M
    T -->|records every row| L[Evidence ledger, server-side]
    M -->|names ids it used| V{Resolve against ledger}
    L --> V
    V -->|found| C[cites]
    V -->|invented| X[dropped]
```

1. The model **never** receives a graph dump. It reaches the catalog only through read-only tools.
2. Every relationship a tool returns is recorded in a per-request **evidence ledger**, with an id.
3. The model names the ids it used.
4. The backend renders `cites` **from the recorded rows** — not from model output.

An id the model invented resolves to nothing and is dropped. 🎯 `text` comes from the model; `cites`
and `note` are computed by the backend — `note` from the confidence mix of the citations, so it stays
factual rather than becoming a judgment. A provider failure is always a 4xx/5xx carrying an `error`
string, **never** a plausible-looking fabricated answer.

> [!TIP]
> **Adding a provider is one adapter plus a registry entry** in `src/llm/model-registry.ts`, which is
> also the single source of truth for `GET /models`. Providers sit behind one interface
> (`src/llm/provider.types.ts`) modelling a single round trip.

---

## 🔑 Authentication

Every route requires `Authorization: Bearer <token>` except `GET /health`, `POST /auth/login`,
`POST /auth/sso/start`, and `GET /auth/sso/callback`. Any protected route returns `401` when the
token is missing, expired, or revoked.

**Sessions are opaque, DB-backed tokens — not JWTs.** 🎫 They're stored as `sha256(token)`, so logout
revokes server-side (a stateless JWT can't be) and a database dump can't be replayed. Passwords are
bcrypt-hashed.

### 🏢 SSO — real OIDC, multi-tenant

Each account brings its own identity provider, routed by email domain:

1. `POST /auth/sso/start` with an email → the domain is routed to its account's connection, and the
   response carries a `redirectUrl`.
2. Full-page redirect to the tenant's IdP (Authorization Code + PKCE).
3. `GET /auth/sso/callback` exchanges the code, verifies signature / issuer / audience / nonce, then
   JIT-provisions or links the user.
4. A session token is minted — exactly as password login does.

> [!NOTE]
> `POST /auth/sso/start` returns the **same response shape** whether a domain has SSO configured, has
> it disabled, or has never heard of it. That's deliberate — it prevents using the endpoint to
> enumerate which organisations have accounts. 🕵️

An email that already belongs to a *different* account is always rejected, never silently reassigned
— see `src/auth/sso/sso.service.ts` for the JIT/link/reject rules.

**Testing SSO needs no live IdP.** 🎭 `test/sso-fixtures.ts` stands up a mock provider by overriding
`globalThis.fetch` for the three URLs `openid-client` calls, so real signature, issuer, audience and
nonce validation run against real crypto.

---

## 🧪 Testing

```bash
npm run test:e2e     # 🚦 the full suite — 117 tests
npm run typecheck    # 📐 tsc --noEmit
npm run lint         # 🧹 eslint --fix
```

The suite boots the real application against a real database, so bring one up first:

```bash
docker compose up -d db && npx prisma migrate dev && npx prisma db seed
```

> [!TIP]
> **No live credentials are required for anything.** 🎭 Ask runs against a scripted stub provider, the
> Anthropic and OpenAI adapters are pinned by pointing the real SDKs at a local server, and SSO uses
> the mock IdP above. Set `LLM_VERIFY_KEYS=false` so key saves don't try to reach the internet.

Two notes that will otherwise cost you an afternoon:

- ⚠️ **`--experimental-vm-modules` is mandatory**, not a preference. `openid-client` is ESM-only and
  its dynamic import fails inside Jest's sandbox without it. Already baked into the `test:e2e` script.
- 🔂 Tests run with `maxWorkers: 1` because they share one database.

### ✅ Contract fidelity is tested, not assumed

`src/common/integrity.ts` encodes what a strict client enforces — enum validity, edge→node
referential integrity, *"an `unknown` node must carry a note"*, *"a producerless topic must be
`uncertain`"*. It runs at **seed time** and again against **live HTTP responses** in the e2e suite, so
a payload that would break a client can't ship. 🚧

| Suite | Covers |
|---|---|
| `contract.e2e-spec.ts` | Read API wire shapes + integrity rules against live responses |
| `ingest.e2e-spec.ts` | Both `/v1` gates, byte-stable baselines, PR vs. default-branch semantics |
| `auth` / `sso.e2e-spec.ts` | Session lifecycle; full OIDC round trip against a mock IdP |
| `ask-llm` / `catalog-tools.e2e-spec.ts` | The tool loop and evidence ledger — the "never invents" guarantee |
| `llm-keys` / `llm-providers.e2e-spec.ts` | Key storage, verification, and each adapter's wire shape |
| `secret-box` / `error-body.e2e-spec.ts` | AES-256-GCM round trip; the `{ error }` normalisation |

---

## 🗂️ Project layout

```
README.md                    # this file
CLAUDE.md                    # architecture, storage rationale, the invariants (§6)
.github/workflows/ci.yml     # lint, typecheck, build, migrate, seed, e2e
docker-compose.yml           # local Postgres (+ optional Adminer)

assets/                      # the brand mark and lockups — see below
prisma/
  schema.prisma              # the data model (see CLAUDE.md §4)
  migrations/                # ordered, committed alongside schema changes
  seed.ts                    # demo account, login, API key + a small demo fleet

src/
  main.ts                    # bootstrap: prefix, raw body, validation, error filter, CORS
  common/                    # wire types, enums, query DTOs, integrity checks, crypto
  auth/                      # login / me / logout, global AuthGuard, @Public()
    sso/                     # OIDC: discovery + PKCE client, JIT/link/reject, encryption
  ingest/                    # the /v1 control plane
    ingest.service.ts        #   gates, baseline write, orchestration
    model.ts                 #   the ingest body + diff vocabulary
    graphdiff.ts             #   pure — semantic diff over two service bodies
    resolve.ts               #   raw target name -> known service | external
    project.ts               #   pure — baselines -> catalog (graph + contracts)
    markdown.ts              #   the PR comment
  graph/ contracts/ commits/ # the read endpoints
  ask/                       # the tool loop, catalog tools, evidence ledger, prompt
  llm/                       # provider interface, Anthropic + OpenAI adapters, registry
  settings/                  # LLM provider key storage
  health/ prisma/

test/                        # e2e suites + mock IdP / stub provider fixtures
```

There is no `docs/` directory on purpose. The wire shapes are defined by the types that serve them
(`src/common/types.ts`, `src/common/enums.ts`, `src/ingest/model.ts`) and pinned against live HTTP
responses by the e2e suites, so there is no prose copy to drift out of date.

<details>
<summary><b>🎨 The mark, and the four values it's drawn from</b></summary>

The spider is the nock: its rear legs splay like fletching against the bowstring, and the shaft runs
out of the frame to the right. Everything is circles and arcs on one radius family, so it redraws
cleanly at any size and survives being cut to a single colour.

The whole thing is one hue ramp — **oklch hue 210** — at four lightness steps:

| Role | oklch | Dark ground | Light ground |
|---|---|---|---|
| body (holds the centre) | `L 0.84` / `L 0.42` | `#80DBEB` | `#005A6B` |
| legs | `L 0.70` / `L 0.58` | `#00B3CB` | `#008DA4` |
| bow | `L 0.56` / `L 0.52` | `#008598` | `#00798C` |
| string | `L 0.42` / `L 0.72` | `#005865` | `#77AFB9` |

`#00B3CB` is the base — it's the badge colour above and the one to reach for when a single accent is
all you get.

```
assets/archerik-mark.svg           64-grid mark, dark ground / full ramp
assets/archerik-mark-light.svg     the same geometry, ramp inverted for white
assets/archerik-lockup-dark.svg    stacked mark + wordmark  ─┬─ the README header,
assets/archerik-lockup-light.svg   the light-ground pair     ─┘  switched by <picture>
```

Authored in hex rather than `oklch()` so the files render identically in GitHub's image sandbox and
in raster converters, with the oklch source values kept in a comment at the top of each file. Every
stroked path declares its own `fill="none"` — the bow arc fills solid black if it's left to inherit,
which is the failure mode you hit the first time you paste the paths into a component.

</details>

> [!TIP]
> **Four files carry most of the interesting logic:** `ingest.service.ts` (orchestration),
> `graphdiff.ts` and `project.ts` (both ✨ pure functions — no DB, no I/O, and the reason the core is
> testable without infrastructure), and `catalog-tools.ts` (how the LLM is kept honest).

---

## 🚢 Deployment notes

```bash
npm ci
npm run build
npx prisma migrate deploy    # ⚠️ never `migrate dev` outside development
npm run start:prod
```

**Before going live** — the checklist:

- [ ] 🌐 **Set `CORS_ORIGINS`** to your actual UI origin. The `*` default is a dev convenience.
- [ ] 🔑 **Generate fresh encryption keys** into your secret manager, not a `.env` on disk. Losing
      them means re-entering every stored SSO client secret and provider key.
- [ ] 🔒 **Terminate TLS in front of this service.** It speaks plain HTTP; bearer credentials cross
      the wire on every request.
- [ ] 🔗 **Set `BACKEND_PUBLIC_URL`** to the externally reachable URL — it's what every tenant's IdP
      registers as the redirect URI, so getting it wrong breaks SSO for everyone.
- [ ] 🚫 **Don't run the seed.** It creates a known password and a known API key.
- [ ] 📏 The JSON body cap is 32 MB (service graphs get large); align any proxy limits in front of it.
- [ ] ❤️ `GET /api/v1/health` is your liveness probe and reports database reachability.

---

## 📊 Status & roadmap

**Working today** ✅ — the full read API, the `/v1` ingest control plane with diffing and PR-comment
rendering, password + OIDC SSO authentication, per-account LLM key management, and grounded Ask.

**Known gaps**, stated plainly 🚧:

| Gap | Detail |
|---|---|
| `GET /commits` returns `[]` | Endpoint, storage and diff engine all exist; the scanner doesn't yet send per-commit metadata. Not a bug — a missing upstream feed. |
| Ask is untested against a live provider | Tool loop, evidence ledger and both adapters are covered against stubs and pinned wire shapes, but the first real Anthropic/OpenAI call is still pending. |
| `databases_used` / `config_dependencies` | Accepted and stored, but not yet projected into the catalog. |
| Quota is a placeholder integer | No billing integration behind it. |
| No role model on `User` | Every member of an account can write that account's provider keys. |

---

## 🤝 Contributing

Contributions welcome. [`CLAUDE.md`](./CLAUDE.md) is the architectural orientation — how a request
flows through the service, why the storage decisions are what they are, and the **ten invariants
that must not break** (§6). Please read those before changing anything in `src/ingest/` or
`src/common/`. 📖

A few house rules:

- Run `npm run typecheck`, `npm run lint` and `npm run test:e2e` before pushing.
- **A wire-shape change is a contract change.** Clients validate strictly and fail loudly, so say so
  explicitly in the PR description.
- **Comments explain _why_, not _what_.** If a decision would look arbitrary to someone reading it
  cold, write down the constraint that forced it.
- **Keep the pure things pure.** `graphdiff.ts` and `project.ts` take data and return data. Needing
  the database inside one means the call belongs a layer up.
- **Stay factual.** No severity ratings or "breaking change" labels in API text or the PR-comment
  markdown. The tool reports; humans judge.
- Schema changes need a migration (`npx prisma migrate dev --name what_changed`) in the same PR.

🔐 **Security issues:** please report them privately via GitHub's
[private vulnerability reporting](https://github.com/farhadamjady/service-discovery-backend-chore/security/advisories/new)
rather than a public issue.

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
