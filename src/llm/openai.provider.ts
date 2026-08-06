import OpenAI from 'openai';
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

/**
 * OpenAI client for one account's key.
 *
 * Shape differences from the Anthropic path that the adapter absorbs:
 *
 * - The system prompt is a message with `role: 'system'`, not a top-level field.
 * - Tool arguments arrive as a JSON *string* that we parse; Anthropic hands back a parsed object.
 *   A model can emit malformed JSON here, so the parse is guarded — a hard crash mid-loop would be
 *   indistinguishable from a provider outage.
 * - There is no server-side fallback mechanism, so `fallbackModel` is ignored rather than faked.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id: LlmProviderId = 'openai';
  private readonly client: OpenAI;

  constructor(apiKey: string, timeoutMs: number) {
    this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  }

  /** `models.list` is auth-only: it validates the key without spending a token. */
  async verifyKey(): Promise<void> {
    try {
      await this.client.models.list();
    } catch (err) {
      throw classifyProviderError(err, this.id);
    }
  }

  async complete(options: LlmCompleteOptions): Promise<LlmCompletion> {
    try {
      const response = await this.client.chat.completions.create({
        model: options.model,
        max_completion_tokens: options.maxTokens,
        messages: [
          { role: 'system', content: options.system },
          ...options.turns.flatMap(toOpenAiMessages),
        ],
        tools: options.tools.map(toOpenAiTool),
      });

      const message = response.choices[0]?.message;
      if (!message) {
        throw new LlmProviderError('unavailable', this.id, 'OpenAI returned an empty response');
      }
      if (message.refusal) {
        throw new LlmProviderError(
          'refused',
          this.id,
          'no grounded answer could be produced for that question',
        );
      }

      const toolCalls: ToolCall[] = [];
      for (const call of message.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        toolCalls.push({
          id: call.id,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
        });
      }

      return { text: (message.content ?? '').trim(), toolCalls };
    } catch (err) {
      throw classifyProviderError(err, this.id);
    }
  }
}

/**
 * Tool arguments come back as a JSON string. Malformed JSON is treated as an empty input rather
 * than thrown: the tool executor already validates its own arguments and can return a usable error
 * to the model, which lets the loop self-correct instead of failing the whole request.
 */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toOpenAiTool(tool: ToolSpec): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toOpenAiMessages(turn: LlmTurn): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  switch (turn.role) {
    case 'user':
      return [{ role: 'user', content: turn.text }];

    case 'assistant':
      return [
        {
          role: 'assistant',
          content: turn.text || null,
          ...(turn.toolCalls.length
            ? {
                tool_calls: turn.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                })),
              }
            : {}),
        },
      ];

    case 'tool':
      // Unlike Anthropic, each result is its own message keyed by tool_call_id.
      return turn.results.map((result) => ({
        role: 'tool' as const,
        tool_call_id: result.id,
        content: result.content,
      }));
  }
}
