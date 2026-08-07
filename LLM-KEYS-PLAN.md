# LLM provider keys + Ask wiring — implementation plan

Working checklist for the feature specified in the UI repo's `BACKEND-LLM-KEYS.md`.
**Delete this file in step 7.** It exists so the work survives a lost session: if you are
picking this up cold, the ticked boxes are done and committed, the rest are not.

## Decisions already made (do not re-litigate)

- **Ask becomes a real LLM call.** The current deterministic regex resolver in `AskService`
  is replaced. Its edge/topic lookups survive as the *implementation* of the catalog tools;
  the regex intent-matching in `answer()` is what the model replaces.
- **The model never authors a citation.** Tools return rows; the backend records every row in
  an evidence ledger with a stable id; the model names ids; the backend intersects and renders
  `cites` itself. A hallucinated id is dropped on intersection. This is the CLAUDE.md §6
  "never invents" invariant enforced structurally, not by prompting.
- **Response field ownership:** `text` ← model. `cites` ← backend (ledger).
  `note` ← backend (computed from the confidence mix of the selected cites — it is a factual
  statement about evidence quality, and CLAUDE.md forbids the backend making judgments).
  `model` ← backend (registry label).
- **v1 tools read graph + contracts only.** No `get_recent_changes` / commit-diff tool.
- **`llama` is dropped** from `GET /models` — a model with no `provider` means "always available"
  per the spec, and there is no self-hosted inference endpoint to call.
- **Anthropic fallbacks: explicit model, never `"default"` mode.**
  `fallbacks: [{ model: 'claude-opus-4-8' }]` + beta `server-side-fallback-2026-06-01`.
- **No admin (403) gating.** There is no `role` column on `User`; the spec leaves this to us.
- **`max_tokens: 8000`, not 2000.** Thinking is on by default on `claude-opus-5` and `max_tokens`
  caps thinking **plus** response text together. Pair with `output_config: { effort: 'low' }`.
- **No LLM client cache.** Decrypt per request, let the client go out of scope. A cache keyed by
  account would hold plaintext customer keys in a long-lived map to save microseconds.

## Steps

Each step ends green (build + tests pass) and gets its own commit. Never start a step before the
previous one is committed.

- [x] **1 — crypto + schema.** `src/common/secret-box.ts` (generalised from `sso-crypto.ts`,
      format version byte unchanged); `sso-crypto.ts` delegates; `LlmProviderKey` model +
      migration; `LLM_ENCRYPTION_KEY` in `.env.example`.
      *Green:* migration applies, SSO e2e still passes, golden-vector test proves old ciphertext
      still decrypts.
- [x] **2 — settings endpoints.** `src/settings/` module: `GET`/`PUT`/`DELETE /settings/llm-keys`,
      plus `src/llm/providers.ts` (the shared provider vocabulary steps 3-6 build on).
      No key verification yet (that lands in step 4).
      *Green:* `test/llm-keys.e2e-spec.ts`, 12 tests.
      Note: semantic validation (422/400) is in the service, not the DTO, so every rejection
      carries the `{ error }` body the UI renders verbatim — class-validator's default shape has
      no `error` string. Only structurally malformed bodies (non-string fields) fall through to
      Nest's default shape.
- [x] **3 — model registry.** `src/llm/model-registry.ts`; `provider` on `GET /models`; drop `llama`.
      `AskService` now takes its model string from the registry too, so /models and /ask share one
      vocabulary. Wire model ids: `claude` → `claude-opus-5`, `gpt` → `gpt-4o`. `wireModel` is
      registry-internal and must never appear in the `GET /models` payload.
      *Green:* contract e2e asserts provider on every model, no `llama`, no `wireModel` leak, and
      `model: 'claude-opus-5'` on the ask test that doesn't depend on seeded data.
- [x] **4 — providers.** `provider.types.ts`, `anthropic.provider.ts`, `openai.provider.ts`,
      `llm-errors.ts`, `llm-client.factory.ts`, `llm.module.ts`. `verifyKey()` wired into `PUT`.
      Deps: `@anthropic-ai/sdk@0.115`, `openai@7.4`. Env: `LLM_VERIFY_KEYS`,
      `LLM_REQUEST_TIMEOUT_MS`.
      *Green:* 17 key tests + 12 provider wire-shape tests.
      **Not yet verified against a live provider** — no credentials on this machine. The request
      shapes are pinned by `test/llm-providers.e2e-spec.ts` (both SDKs pointed at a local server via
      their base-URL env var), but the first real call happens in step 6. If it 400s, look there
      first.
      Verification fails closed: a key that can't be checked isn't stored, so the error surfaces in
      Settings rather than later at Ask time. `LLM_VERIFY_KEYS=false` for offline dev/CI.
- [x] **5 — catalog tools + evidence ledger.** `src/ask/catalog-tools.ts` + `src/ask/evidence.ts`.
      Pure functions, no network, no SDK. *Green:* 22 tests.
      Tools: `list_services`, `get_service_dependencies`, `list_topics`, `get_topic`,
      `get_endpoints`. Only *relationships* are citable — a bare service/topic listing records no
      evidence, so `cites` means "the facts this claim rests on", not "everything the model looked
      at". Tools never throw: bad names/args come back as an `error` field the model retries from.
- [ ] **6 — Ask rewrite.** The tool loop in `ask.service.ts`; throttler on the controller.
      *May split if it runs long — update this file first.*
      *Green:* `test/ask-llm.e2e-spec.ts` against a stub provider.
- [ ] **7 — docs.** `API-CONTRACT.md`, add `llm_provider_keys` to the `truncate-cartograph-db`
      skill's preserve list (it is account config, like the extractor key — a reset must not
      force re-entering provider keys), delete this file.

## Error mapping (step 6)

| Condition | Status | `error` string (UI shows verbatim) |
|---|---|---|
| No key for the model's provider | `409` | `no API key configured for anthropic` (spec-exact wording) |
| Provider rejects the key (401/403) | `502` | `the stored anthropic key was rejected — update it in Settings → LLM` |
| Provider rate limit (429) | `429` | `anthropic rate-limited this request — try again shortly` |
| Provider 5xx / overloaded | `503` | `anthropic is unavailable right now` |
| Timeout | `504` | `the request to anthropic timed out` |
| Refusal / empty content | `502` | `no grounded answer could be produced for that question` |

Check `stop_reason === 'refusal'` **before** reading `content` — indexing `content[0]`
unconditionally crashes on a refusal.

## v1 catalog tools (step 5)

`list_services({ query? })` · `get_service_dependencies({ service, direction })` ·
`list_topics({ query? })` · `get_topic({ topic })` · `get_endpoint({ service?, verb?, path? })`

Every returned row is appended to the ledger as `{ id: 'ev<n>', cite: { name, dir, confidence } }`.
`dir` uses the existing `citeDir` helper (Kafka → `via <topic>`, REST → the method string).
Cites cap at 8, matching the current behaviour.
