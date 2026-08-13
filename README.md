<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/archerik-banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/archerik-banner-light.svg">
  <img alt="Archerik" src="assets/archerik-banner-light.svg" width="400">
</picture>

**A service catalog for fleets of microservices — built from static analysis,
and honest about what it couldn't figure out.**

[![CI](https://github.com/farhadamjady/archerik-api/actions/workflows/ci.yml/badge.svg)](https://github.com/farhadamjady/archerik-api/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-20%2B-00B3CB?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-008598)](LICENSE)
[![Tests](https://img.shields.io/badge/e2e-117%20passing-005865)](#-testing)

</div>

---

## The Archerik platform

Archerik is three components. This repository is the second one; it ingests what the
extractor produces and serves the fleet-wide graph the UI reads.

| Component | Repository | Role | Depends on |
|---|---|---|---|
| **Extractor** | [`archerik-extractor`](https://github.com/farhadamjady/archerik-extractor) | Scans one service repository and emits its architecture as JSON. Runs locally or in CI. | — |
| **API** | [`archerik-api`](https://github.com/farhadamjady/archerik-api) *(this repo)* | Ingests graphs from the extractor, stores them, derives inbound edges across services, and diffs each commit against the last. | Extractor output |
| **UI** | [`archerik-ui`](https://github.com/farhadamjady/archerik-ui) | Explores the fleet graph — services, dependencies, topics, and schemas — and visualizes what changed. | API |

The extractor never talks to the UI directly. It produces JSON; the API is the
only thing that consumes it, and the UI reads everything through the API.

---

## 🚀 Quick start

**You'll need:** Node.js ≥ 20 · Docker · `openssl`

```bash
git clone https://github.com/farhadamjady/archerik-api.git
cd archerik-api
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
> Anthropic and OpenAI adapters are pinned by pointing the real SDKs at a local server, and SSO runs
> against a mock IdP built in `test/sso-fixtures.ts`. Set `LLM_VERIFY_KEYS=false` so key saves don't
> try to reach the internet.

Two notes that will otherwise cost you an afternoon:

- ⚠️ **`--experimental-vm-modules` is mandatory**, not a preference. `openid-client` is ESM-only and
  its dynamic import fails inside Jest's sandbox without it. Already baked into the `test:e2e` script.
- 🔂 Tests run with `maxWorkers: 1` because they share one database.

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
[private vulnerability reporting](https://github.com/farhadamjady/archerik-api/security/advisories/new)
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
