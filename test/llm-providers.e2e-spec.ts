import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { AnthropicProvider } from '../src/llm/anthropic.provider';
import { OpenAiProvider } from '../src/llm/openai.provider';
import { LlmCompleteOptions, LlmProviderError } from '../src/llm/provider.types';

/**
 * Wire-shape tests for the two provider adapters.
 *
 * Type-checking proves the SDK accepts our arguments; it does NOT prove we built the request the
 * API expects. A misplaced `fallbacks`, a tool result sent as its own message on Anthropic, or an
 * unparsed OpenAI argument string all compile fine and fail only against a live provider — which
 * is exactly where the Ask loop would discover them, mid-feature and with a real key.
 *
 * So: both SDKs are pointed at a local server via their base-URL env var, and we assert the JSON
 * they actually put on the wire, plus how each response is parsed back. No credentials, no network.
 */

interface Captured {
  path: string;
  headers: NodeJS.Dict<string | string[]>;
  body: Record<string, unknown>;
}

/** Serves one canned response and records what was sent to it. */
class MockProviderServer {
  private server!: Server;
  readonly requests: Captured[] = [];
  respondWith: { status: number; body: unknown } = { status: 200, body: {} };

  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        this.requests.push({
          path: req.url ?? '',
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
        res.writeHead(this.respondWith.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.respondWith.body));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get lastBody(): Record<string, unknown> {
    return this.requests[this.requests.length - 1].body;
  }
}

/** A conversation mid-tool-loop: user question, assistant tool call, our tool result. */
const CONVERSATION: Omit<LlmCompleteOptions, 'model'> = {
  system: 'You answer only from the catalog.',
  maxTokens: 8000,
  tools: [
    {
      name: 'list_services',
      description: 'Find services by name.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
  turns: [
    { role: 'user', text: 'what calls payment-service?' },
    {
      role: 'assistant',
      text: 'Looking that up.',
      toolCalls: [{ id: 'call_1', name: 'list_services', input: { query: 'payment' } }],
    },
    { role: 'tool', results: [{ id: 'call_1', content: '[{"id":"ev1","name":"checkout"}]' }] },
  ],
};

const ANTHROPIC_REPLY = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [
    { type: 'text', text: 'Two services call it.' },
    { type: 'tool_use', id: 'toolu_9', name: 'list_services', input: { query: 'checkout' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

const OPENAI_REPLY = {
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'Two services call it.',
        tool_calls: [
          {
            id: 'call_9',
            type: 'function',
            function: { name: 'list_services', arguments: '{"query":"checkout"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
};

describe('AnthropicProvider — wire shape', () => {
  let mock: MockProviderServer;
  const saved = process.env.ANTHROPIC_BASE_URL;

  beforeAll(async () => {
    mock = new MockProviderServer();
    process.env.ANTHROPIC_BASE_URL = await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved;
  });

  beforeEach(() => {
    mock.respondWith = { status: 200, body: ANTHROPIC_REPLY };
    mock.requests.length = 0;
  });

  it('sends system as a cache-marked block, tools, and a well-formed tool loop', async () => {
    const provider = new AnthropicProvider('sk-ant-test', 5_000);
    await provider.complete({ ...CONVERSATION, model: 'claude-opus-5' });

    const body = mock.lastBody;
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(8000);
    expect(body.output_config).toEqual({ effort: 'low' });

    // System is a block array carrying the cache breakpoint, not a bare string.
    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'You answer only from the catalog.',
        cache_control: { type: 'ephemeral' },
      },
    ]);

    // Tool schema is passed through under input_schema.
    expect(body.tools).toEqual([
      {
        name: 'list_services',
        description: 'Find services by name.',
        input_schema: CONVERSATION.tools[0].inputSchema,
      },
    ]);

    // The tool RESULT must be a user turn whose content is a tool_result block — the single most
    // common way to get a 400 here is to send it as role:'tool' (which is the OpenAI shape).
    expect(body.messages).toEqual([
      { role: 'user', content: 'what calls payment-service?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking that up.' },
          { type: 'tool_use', id: 'call_1', name: 'list_services', input: { query: 'payment' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: '[{"id":"ev1","name":"checkout"}]',
          },
        ],
      },
    ]);
  });

  it('sends an explicit fallback model and its beta flag only when one is configured', async () => {
    const provider = new AnthropicProvider('sk-ant-test', 5_000);

    await provider.complete({
      ...CONVERSATION,
      model: 'claude-opus-5',
      fallbackModel: 'claude-opus-4-8',
    });
    expect(mock.lastBody.fallbacks).toEqual([{ model: 'claude-opus-4-8' }]);
    // The beta goes on the header, and the array form pins this exact date.
    expect(mock.requests.at(-1)!.headers['anthropic-beta']).toContain(
      'server-side-fallback-2026-06-01',
    );

    await provider.complete({ ...CONVERSATION, model: 'claude-opus-5' });
    expect(mock.lastBody).not.toHaveProperty('fallbacks');
  });

  it('parses text and tool calls out of the response', async () => {
    const provider = new AnthropicProvider('sk-ant-test', 5_000);
    const result = await provider.complete({ ...CONVERSATION, model: 'claude-opus-5' });

    expect(result.text).toBe('Two services call it.');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_9', name: 'list_services', input: { query: 'checkout' } },
    ]);
  });

  it('surfaces a refusal instead of reading content', async () => {
    // A refusal is HTTP 200 with an empty content array — reading content[0] blindly would throw a
    // TypeError that looks nothing like the refusal it is.
    mock.respondWith = {
      status: 200,
      body: { ...ANTHROPIC_REPLY, content: [], stop_reason: 'refusal' },
    };
    const provider = new AnthropicProvider('sk-ant-test', 5_000);

    await expect(
      provider.complete({ ...CONVERSATION, model: 'claude-opus-5' }),
    ).rejects.toMatchObject({ name: 'LlmProviderError', kind: 'refused' });
  });

  it('classifies a 401 as a rejected key, without echoing the upstream body', async () => {
    mock.respondWith = {
      status: 401,
      body: { error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-secret' } },
    };
    const provider = new AnthropicProvider('sk-ant-test', 5_000);

    const err = await provider
      .complete({ ...CONVERSATION, model: 'claude-opus-5' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).kind).toBe('rejected');
    // The upstream message quoted a key-shaped string; ours must not repeat it.
    expect((err as LlmProviderError).message).not.toContain('sk-ant-secret');
    expect((err as LlmProviderError).message).toContain('Settings → LLM');
  });

  it('verifyKey hits the models endpoint and spends no tokens', async () => {
    mock.respondWith = { status: 200, body: { data: [], has_more: false } };
    await new AnthropicProvider('sk-ant-test', 5_000).verifyKey();

    expect(mock.requests.at(-1)!.path).toContain('/v1/models');
  });
});

describe('OpenAiProvider — wire shape', () => {
  let mock: MockProviderServer;
  const saved = process.env.OPENAI_BASE_URL;

  beforeAll(async () => {
    mock = new MockProviderServer();
    process.env.OPENAI_BASE_URL = await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
    if (saved === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved;
  });

  beforeEach(() => {
    mock.respondWith = { status: 200, body: OPENAI_REPLY };
    mock.requests.length = 0;
  });

  it('sends system as a message and tool results keyed by tool_call_id', async () => {
    const provider = new OpenAiProvider('sk-openai-test', 5_000);
    await provider.complete({ ...CONVERSATION, model: 'gpt-4o' });

    const body = mock.lastBody;
    expect(body.model).toBe('gpt-4o');
    expect(body.max_completion_tokens).toBe(8000);

    expect(body.messages).toEqual([
      { role: 'system', content: 'You answer only from the catalog.' },
      { role: 'user', content: 'what calls payment-service?' },
      {
        role: 'assistant',
        content: 'Looking that up.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            // Arguments are a STRING here, unlike Anthropic's parsed object.
            function: { name: 'list_services', arguments: '{"query":"payment"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '[{"id":"ev1","name":"checkout"}]' },
    ]);

    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'list_services',
          description: 'Find services by name.',
          parameters: CONVERSATION.tools[0].inputSchema,
        },
      },
    ]);
  });

  it('ignores fallbackModel — OpenAI has no server-side fallback to send it to', async () => {
    const provider = new OpenAiProvider('sk-openai-test', 5_000);
    await provider.complete({ ...CONVERSATION, model: 'gpt-4o', fallbackModel: 'gpt-4o-mini' });

    expect(mock.lastBody).not.toHaveProperty('fallbacks');
    expect(mock.lastBody).not.toHaveProperty('fallbackModel');
  });

  it('parses the JSON-string tool arguments back into an object', async () => {
    const provider = new OpenAiProvider('sk-openai-test', 5_000);
    const result = await provider.complete({ ...CONVERSATION, model: 'gpt-4o' });

    expect(result.text).toBe('Two services call it.');
    expect(result.toolCalls).toEqual([
      { id: 'call_9', name: 'list_services', input: { query: 'checkout' } },
    ]);
  });

  it('treats malformed tool arguments as empty rather than crashing the loop', async () => {
    const broken = structuredClone(OPENAI_REPLY);
    broken.choices[0].message.tool_calls[0].function.arguments = '{"query": ';
    mock.respondWith = { status: 200, body: broken };

    const result = await new OpenAiProvider('sk-openai-test', 5_000).complete({
      ...CONVERSATION,
      model: 'gpt-4o',
    });

    // The tool executor validates its own input and can hand the model a usable error, which lets
    // the loop self-correct — better than failing the whole request on one bad token.
    expect(result.toolCalls).toEqual([{ id: 'call_9', name: 'list_services', input: {} }]);
  });

  it('surfaces a refusal', async () => {
    const refused = structuredClone(OPENAI_REPLY) as Record<string, any>;
    refused.choices[0].message = { role: 'assistant', content: null, refusal: 'I cannot help' };
    mock.respondWith = { status: 200, body: refused };

    await expect(
      new OpenAiProvider('sk-openai-test', 5_000).complete({ ...CONVERSATION, model: 'gpt-4o' }),
    ).rejects.toMatchObject({ name: 'LlmProviderError', kind: 'refused' });
  });

  it('verifyKey hits the models endpoint and spends no tokens', async () => {
    mock.respondWith = { status: 200, body: { object: 'list', data: [] } };
    await new OpenAiProvider('sk-openai-test', 5_000).verifyKey();

    expect(mock.requests.at(-1)!.path).toContain('/models');
  });
});
