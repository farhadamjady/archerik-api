import { LlmProviderId } from './providers';

/**
 * One selectable Ask model, as the UI sees it (BACKEND-LLM-KEYS.md §5).
 *
 * `provider` is what lets the UI gate the picker: it cross-references this against
 * GET /settings/llm-keys and flags models whose provider has no key ("needs key"). A model with no
 * `provider` is treated as always-available — which is why every model we serve must have one, since
 * we can no longer answer without a key.
 */
export interface ModelDto {
  id: string;
  label: string;
  vendor: string;
  provider: LlmProviderId;
}

/** Registry entry — ModelDto plus the fields that stay server-side. */
interface ModelEntry extends ModelDto {
  /**
   * The provider's own model identifier, sent on the wire to Anthropic/OpenAI. Deliberately NOT in
   * ModelDto: the UI picks by `id`, and leaking the exact model string would let a client pin a
   * model we haven't validated against the grounding prompt.
   */
  wireModel: string;
  /**
   * Model to retry on if the provider's safety classifiers decline the request. Always named
   * explicitly rather than delegated to a provider-chosen default, so the substitute is a
   * deliberate, reviewable choice. Omitted where the provider has no such mechanism.
   */
  fallbackModel?: string;
}

/**
 * The models Ask can actually answer with.
 *
 * Every entry must map to a provider we have a client for, because the answer is now a real
 * provider call rather than the deterministic resolver this replaced. That's why the old
 * `llama` entry ("self-hosted · in-cluster") is gone: it had no provider, the spec treats a
 * provider-less model as always-available, and there is no self-hosted inference endpoint in this
 * stack — so offering it would gate nothing in the UI and fail at answer time.
 */
const MODELS: readonly ModelEntry[] = [
  {
    id: 'claude',
    label: 'Claude Opus 5',
    vendor: 'Anthropic API',
    provider: 'anthropic',
    wireModel: 'claude-opus-5',
    fallbackModel: 'claude-opus-4-8',
  },
  {
    id: 'gpt',
    label: 'GPT-4o',
    vendor: 'OpenAI API',
    provider: 'openai',
    wireModel: 'gpt-4o',
  },
] as const;

/** Selected when the request omits `model`, or names one we don't serve. */
export const DEFAULT_MODEL_ID = 'claude';

/** The public list for GET /models — `wireModel` stripped. */
export function listModels(): ModelDto[] {
  return MODELS.map(({ id, label, vendor, provider }) => ({ id, label, vendor, provider }));
}

/**
 * Resolves a user-selected model id to its registry entry, falling back to the default for an
 * unknown or omitted id. Never throws: a stale id from a cached UI bundle should still get an
 * answer, not a 400.
 */
export function resolveModel(id?: string): ModelEntry {
  const match = MODELS.find((m) => m.id === (id ?? '').toLowerCase());
  return match ?? MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!;
}
