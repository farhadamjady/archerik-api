import { LlmProviderId } from './providers';

/**
 * Provider-neutral vocabulary for the Ask tool loop.
 *
 * The loop, the catalog tools, and the evidence ledger live in src/ask/ and know nothing about
 * Anthropic or OpenAI. Everything vendor-specific — request shape, tool-call encoding, error
 * classes — is confined to the two implementations of {@link LlmProvider}. Adding a third provider
 * is one new file plus a registry entry.
 *
 * A provider here models exactly ONE round trip. The multi-turn tool loop is the caller's job:
 * providers stay stateless so the evidence ledger, the iteration cap, and the grounding rules have
 * a single home rather than being duplicated per vendor.
 */

/** A tool the model may call. `inputSchema` is JSON Schema, passed through to both providers. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool invocation the model asked for. */
export interface ToolCall {
  /** Provider-assigned id. Must be echoed back on the matching result or the turn is malformed. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The result we hand back for one {@link ToolCall}. */
export interface ToolResult {
  /** Must equal the originating ToolCall.id. */
  id: string;
  /** Serialised rows. JSON, so the model gets structure rather than prose. */
  content: string;
}

/** One turn of conversation state, rebuilt on every round trip (both APIs are stateless). */
export type LlmTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

export interface LlmCompletion {
  /** The assistant's visible text. Empty when it only asked for tools. */
  text: string;
  /** Empty when the model is done and produced a final answer. */
  toolCalls: ToolCall[];
}

export interface LlmCompleteOptions {
  /** The provider's own model string (registry `wireModel`), never the UI-facing id. */
  model: string;
  /**
   * Model to retry on if the provider's safety classifiers decline the request. Always an explicit
   * model — never a "pick one for me" default — so the substitute is a deliberate choice, visible
   * in the registry and reviewable. Omitted when the provider has no such mechanism.
   */
  fallbackModel?: string;
  system: string;
  tools: ToolSpec[];
  turns: LlmTurn[];
  /**
   * Caps thinking AND response text together on reasoning models, so this needs real headroom —
   * a value sized for just the prose truncates the answer mid-sentence.
   */
  maxTokens: number;
}

/**
 * Why a provider call failed, in terms the HTTP layer can map without knowing either SDK.
 * `rejected` specifically means the key is bad — the only kind the user can fix themselves.
 */
export type LlmFailureKind = 'rejected' | 'rate_limited' | 'unavailable' | 'timeout' | 'refused';

/**
 * A provider failure, already scrubbed. Carries no upstream response body: those can echo request
 * content, and this message is rendered verbatim to the user.
 */
export class LlmProviderError extends Error {
  constructor(
    readonly kind: LlmFailureKind,
    readonly provider: LlmProviderId,
    message: string,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

/** One provider, already bound to an account's API key. */
export interface LlmProvider {
  readonly id: LlmProviderId;

  /**
   * Cheapest possible authenticated call, used to validate a key at save time. Resolves when the
   * key works; throws {@link LlmProviderError} otherwise. Must not consume tokens.
   */
  verifyKey(): Promise<void>;

  /** One round trip. Throws {@link LlmProviderError} on any provider-side failure. */
  complete(options: LlmCompleteOptions): Promise<LlmCompletion>;
}
