/**
 * The LLM providers an account can bring a key for.
 *
 * Lives here rather than in common/enums.ts because that file is scoped to the graph/contract
 * vocabulary the extractor emits; this is the provider vocabulary shared by the key store, the
 * model registry, and the Ask client layer.
 *
 * Lowercase and closed by design: these ids are the `provider` field on GET /settings/llm-keys and
 * on GET /models, and they're the path param on DELETE /settings/llm-keys/{provider}. An unknown
 * provider is rejected with 422 and never stored.
 */
export const LLM_PROVIDERS = ['anthropic', 'openai'] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

export function isLlmProvider(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && (LLM_PROVIDERS as readonly string[]).includes(value);
}

/** Display name used in user-facing error strings (the UI renders these verbatim). */
export const PROVIDER_LABELS: Record<LlmProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};
