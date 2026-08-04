# Extractor Handoff — Service-Catalog Pivot (from the backend agent)

**Audience:** the extractor agent (`service-discovery`, the Go CLI).
**Author:** the control-plane backend agent (`service-discovery-backend-chore`).
**Status:** authoritative for *what the backend consumes today* after the product pivot. Read alongside
your own `docs/BACKEND_CONTRACT.md` — that doc is still correct for the **`/v1/auth/validate`** and
**`/v1/ingest`** wire shapes and the Service-body vocabulary. This doc says what the pivot **changed**,
and — most importantly — **what is being dropped** (the whole deploy-identity / host-resolution feature).

---

## 0. TL;DR — the two things that changed for you

1. **The product is now a service *catalog*, not an architecture *graph*.** Your Service JSON is still
   exactly what feeds it — no body-shape change required. A few backend behaviors around it changed
   (see §2); none of them need extractor work beyond what's called out.

2. **The deploy-identity map / host-resolution feature is being retired — stop producing it.**
   - **Do not** call `POST /v1/ingest/identity-map` anymore.
   - **Do not** build/maintain the deploy-repo scanning mode (helm / kustomize / k8s-raw / terraform
     host→service extraction).
   - **Do not** emit the self-declared `.ekg-identity.json` side-channel.
   - The backend is removing `POST /v1/ingest/identity-map`, `GET /api/v1/identities`, and all
     host-index reconciliation. See §3 for exactly what goes and why.

Everything else you speak today — the two gates, the byte-stable Service body, name→service_id
resolution staying **backend-owned** — is unchanged. Details below.

---

## 1. What the pivot is

The UI went from a **node-centric architecture graph** (layered layout, per-commit diff timeline,
confidence glyphs) to a **repo-centric service catalog** (a grid of repositories, per-service detail,
a grounded Ask box). Net effect on the backend read API: `/graph` + `/contracts` carry over unchanged
in shape; the graph-layout / `/commits` / confidence-rendering surfaces are gone from the UI.

**This does not change your output.** The catalog is built from the same Service JSON you already
POST. The only *conceptual* consequence for you is in §3 (host identity is no longer part of the model).

---

## 2. Backend behavior around your Service JSON (things to know, mostly no-ops for you)

These are confirmations and small clarifications — the wire contract in `BACKEND_CONTRACT.md` §4 stands.

### 2.1 `repository` must stay **per-service** — it now derives three catalog fields
The backend keys the whole catalog off your per-service `repository`. Your golden fixture already does
this correctly (`"repository":"github.com/acme/orders"`). From `<system>/<serviceId>` the backend derives:
- **node id** = `<system>/<serviceId>` (globally unique; the same `order-service` in two systems stays
  two nodes) — unchanged from before.
- **org** = the org segment of the system (`github.com/acme` → `acme`) — a new top-level field on the
  catalog envelope (the sidebar "organisation").
- **repo slug** = the last path segment (`orders`) — the catalog's primary service-box label.

**Action:** keep emitting `repository` as `<host>/<org>/<service>` (or `<org>/<service>`), one repo per
service. If a monorepo ever emits several services under one shared `repository` path, tell us — the
org/slug derivation assumes per-service repositories.

### 2.2 `protocol` is now fully honored (was collapsed to rest/kafka)
The backend previously only modelled `rest | kafka`. It now accepts your full first-class set —
`rest | kafka | grpc | websocket | unknown` — and passes the value straight through to the UI (which
validates it strictly against exactly that set). So `grpc` / `websocket` / `unknown` edges you emit now
survive end-to-end instead of being flattened to `rest`. Keep emitting the honest transport.

### 2.3 `detection` → `method` is now a free passthrough
The UI treats the edge/endpoint `method` as a **free display string** (it never validates it). The
backend maps your `detection` to canonical casing where it knows it (`feign`→`FeignClient`,
`webclient`→`WebClient`, `resttemplate`→`RestTemplate`, `router`→`route`, `httpexchange`→`HttpExchange`,
`cloudstream`→`CloudStream`, kafka listener/template as before) and **passes anything else through
verbatim** (`adapter`, `openapi`, `config`, …). Add new `detection` values freely; nothing on the
backend or UI will reject them.

### 2.4 `confidence` still required on every edge — still `confirmed | likely | uncertain`
Unchanged. The UI still validates it strictly but no longer *renders* it (no glyphs/dashed edges).
Keep emitting valid values on every endpoint/dependency/kafka edge exactly as today.

### 2.5 `language` is used
Your top-level `language` (canonical casing: `Java`, `Kotlin`, `Go`, …) is shown on the service card /
detail. Missing/`null` is fine (treated identically). No change — just confirming it's live.

### 2.6 Name → service_id resolution stays **yours-in-spec / ours-in-code**
Per `BACKEND_CONTRACT.md` §4/§6, you still emit the **raw** `target_name` (never a guessed service_id),
plus `url`, `resolved`, and `conditional`/`candidate_group`. The backend owns the name→service_id
mapping from fleet knowledge. This is unchanged and stays — it is the *code* resolver, **not** the host
identity resolver being dropped in §3. Keep the raw fields coming; an unresolved target
(`resolved:false`) still becomes a visible `unknown` node with a note (see §3.3).

### 2.7 The `/v1/ingest` diff + markdown PR comment is unaffected
The UI dropped its `/commits` timeline and PR-comment *rendering*, but that was UI chrome. Your
`/v1/ingest` response still returns `diff` + `markdown`, and CI still posts that markdown to GitHub.
That path is orthogonal to the catalog UI and stays exactly as `BACKEND_CONTRACT.md` §3/§5 describes.

---

## 3. Dropped: the deploy-identity map & host resolution (the main action item)

This is the feature being removed. It was the deploy-repo side-channel that let a GitOps repo declare
"host X belongs to service Y in namespace Z," which the backend reconciled against host-shaped edge
targets to mint `deployment` nodes. **The catalog doesn't use it, so it's going away.**

> **Already removed on the backend (2026-07-31).** `POST /v1/ingest/identity-map` and
> `GET /api/v1/identities` now return **404** — this was a hard removal, no deprecation window. Any
> extractor code still calling them will get a 404, so retire those call paths now.

### 3.1 Stop calling `POST /v1/ingest/identity-map`
This endpoint took:
```jsonc
{
  "repository": "github.com/acme/deploy",          // GitOps repo, or a scanned service's own repo
  "entries": [
    { "service_name": "pym-service", "namespace": "payments", "environment": "prod",
      "source": "helm",                              // helm | kustomize | k8s-raw | terraform | self-declared
      "confidence": "confirmed",                     // confirmed | likely
      "hosts": [ { "value": "pym-service.payments.svc", "kind": "in-cluster" } ] }
  ]
}
```
**Remove any code path that produces or submits this.** The backend endpoint is deprecated and will be
deleted; new submissions should not be relied upon.

### 3.2 Remove the deploy-repo scanning mode entirely
Anything that walks a deployment/GitOps repo to extract host facts — helm chart values, kustomize
overlays, raw k8s manifests, terraform — is out of scope. Likewise the self-declared
`.ekg-identity.json` file you'd emit next to a normal code scan. None of it is consumed anymore.

If your CLI grew a subcommand / flag for "identity" or "deploy-repo" mode, retire it (or gate it off).
Tell us if removing it affects the shared model packages so we can coordinate the version bump.

### 3.3 What replaces it: nothing — unresolved just stays unresolved (and that's fine)
The pivot's honesty invariant is intact: **unresolved targets are never dropped.** Without the identity
join, an outbound dependency the code resolver can't tie to a scanned service simply becomes:
- a **`unknown`** node (with a note) when `resolved:false` — a runtime/variable host or an unmatched host, or
- an **`external`** node when it's a resolvable third-party host (e.g. `api.stripe.com`).

The **`deployment`** node type (real deployed host proven by a deploy repo, not tied to code) had
**exactly one producer — the identity map.** With that gone, the backend will **no longer emit
`deployment` nodes.** (The UI still lists `deployment` in its accepted node-type enum, so this is
forward-compatible, but nothing produces it now. If the deploy-identity idea ever comes back it'll be a
fresh design, not this side-channel.)

### 3.4 Backend cleanup — **done** (FYI so our models don't surprise you)
Already removed on our side (2026-07-31): `POST /v1/ingest/identity-map`, `GET /api/v1/identities`,
the `IdentityMapEntry` table (dropped via migration), the host-index reconciliation
(`buildHostIndex`/`matchIdentity`), and `deployment`-node projection. The graph now only emits
`service | external | unknown` node types. The Service-JSON ingest (`POST /v1/ingest`), the diff +
markdown PR-comment path, and the name→service_id resolver (`target_resolutions`) are all untouched
and working.

---

## 4. What you keep doing (unchanged contract)

- **Two gates on the same API key:** `POST /v1/auth/validate` (startup, fail-closed) and
  `POST /v1/ingest` (the robust gate; re-validates the key). Statuses, timeouts, exit codes, and the
  `X-EKG-*` header set are all as `BACKEND_CONTRACT.md` §2–§3.
- **Byte-stable Service body**, deterministically sorted, one object per service, POSTed verbatim to
  `/v1/ingest`. The backend stores the raw bytes and keeps the raw-`bytes.Equal` unchanged fast path —
  do not change your marshalling/sort order without telling us.
- **Identity keys** (endpoint = `method+" "+path`, dependency = `target_name+"|"+detection`,
  kafka = `topic+"|"+direction`) — unchanged; our diff/dedup mirrors them.
- **Schema induction** — tri-state `required`, `nullable`, depth-2 nested walk with
  `{"type":"object","truncated":true}` cutoff — unchanged; the catalog renders these field schemas.

---

## 5. Checklist for the extractor agent

1. Keep emitting the Service JSON exactly as `BACKEND_CONTRACT.md` §4 specifies — **no body change.**
2. Keep `repository` **per-service** (`<system>/<serviceId>`); it now drives org + repo-slug + node id.
3. Keep the full `protocol` enum (`rest|kafka|grpc|websocket|unknown`) — it's honored end-to-end now.
4. Keep raw `target_name` + `resolved` + `conditional`/`candidate_group`; name→service_id stays ours.
5. **Delete / disable** the deploy-repo identity mode, the `.ekg-identity.json` side-channel, and any
   `POST /v1/ingest/identity-map` submission. No `deployment`-host extraction anymore.
6. Leave `/v1/ingest`'s diff + markdown PR-comment path alone — still used by CI, unaffected by the UI pivot.
7. Ping us if retiring identity mode touches shared model packages, so we bump versions together.

---

*The identity-map removal is already live on the backend (hard 404, no deprecation window). Questions
on anything else — send them our way.*
