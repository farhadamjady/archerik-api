import Anthropic from '@anthropic-ai/sdk';
import { classifyProviderError } from './llm-errors';
import {
  LlmCompleteOptions,
  LlmCompletion,
  LlmProvider,
  LlmProviderError,
  LlmTurn,
  ToolCall,
  ToolSpec,
} from './provider.types';
import { LlmProviderId } from './providers';

/** Enables the explicit `fallbacks` array. Exact string — other dates in the series are rejected. */
const FALLBACK_BETA = 'server-side-fallback-2026-06-01';

/**
 * Anthropic client for one account's key.
 *
 * Notes that are easy to get wrong and expensive to debug:
 *
 * - **Thinking is on by default** on Claude Opus 5, and `max_tokens` bounds thinking *plus*
 *   response text. A limit sized for the prose alone truncates the answer mid-sentence, so callers
 *   pass real headroom and we keep effort low — Ask is interactive, and low/medium effort is strong
 *   on this model.
 * - **`stop_reason` is checked before `content` is read.** Safety classifiers can decline a request
 *   with a perfectly normal HTTP 200 and an empty `content` array; indexing `content[0]` first
 *   throws a TypeError that looks nothing like the refusal it actually is.
 * - **The system prompt carries a cache breakpoint.** It and the tool definitions are byte-stable
 *   across every question an account asks, so repeat traffic reads the cached prefix.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id: LlmProviderId = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string, timeoutMs: number) {
    this.client = new Anthropic({
      apiKey,
      timeout: timeoutMs, // milliseconds
      maxRetries: 1, // Ask is interactive — fail fast rather than stack retries behind a spinner.
    });
  }

  /** `models.list` is auth-only: it validates the key without spending a token. */
  async verifyKey(): Promise<void> {
    try {
      await this.client.models.list({ limit: 1 });
    } catch (err) {
      throw classifyProviderError(err, this.id);
    }
  }

  async complete(options: LlmCompleteOptions): Promise<LlmCompletion> {
    try {
      const response = await this.client.beta.messages.create({
        model: options.model,
        max_tokens: options.maxTokens,
        // Interactive Q&A over a small, pre-retrieved context — depth buys little here and costs
        // latency the user is watching.
        output_config: { effort: 'low' },
        system: [
          {
            type: 'text',
            text: options.system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: options.tools.map(toAnthropicTool),
        messages: options.turns.map(toAnthropicMessage),
        ...(options.fallbackModel
          ? { betas: [FALLBACK_BETA], fallbacks: [{ model: options.fallbackModel }] }
          : {}),
      });

      if (response.stop_reason === 'refusal') {
        throw new LlmProviderError(
          'refused',
          this.id,
          'no grounded answer could be produced for that question',
        );
      }

      const text: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const block of response.content) {
        if (block.type === 'text') {
          text.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          });
        }
        // thinking / fallback blocks are audit markers here — nothing to surface.
      }

      return { text: text.join('').trim(), toolCalls };
    } catch (err) {
      throw classifyProviderError(err, this.id);
    }
  }
}

function toAnthropicTool(tool: ToolSpec): Anthropic.Beta.BetaToolUnion {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool['input_schema'],
  };
}

function toAnthropicMessage(turn: LlmTurn): Anthropic.Beta.BetaMessageParam {
  switch (turn.role) {
    case 'user':
      return { role: 'user', content: turn.text };

    case 'assistant': {
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (turn.text) content.push({ type: 'text', text: turn.text });
      for (const call of turn.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      return { role: 'assistant', content };
    }

    case 'tool':
      // Tool results are a USER turn in the Messages API, and all results for one assistant turn
      // must arrive in a single message — splitting them trains the model out of parallel calls.
      return {
        role: 'user',
        content: turn.results.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.id,
          content: result.content,
        })),
      };
  }
}
