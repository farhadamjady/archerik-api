import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { LlmClientFactory } from '../src/llm/llm-client.factory';
import {
  LlmCompleteOptions,
  LlmCompletion,
  LlmProvider,
  LlmProviderError,
} from '../src/llm/provider.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, login } from './e2e-utils';

/**
 * POST /ask against a scripted provider.
 *
 * The stub stands in for Anthropic/OpenAI so the loop, the evidence ledger, and the error mapping
 * are exercised without network access or a real key. What is under test is everything the backend
 * owns: which tools ran, what evidence survived, and what the user is finally shown.
 */

const ANTHROPIC_KEY = 'sk-ant-test-0000000000000000000000000000000000000000a1b2';

/** One scripted reply per iteration of the tool loop. */
type Script = (options: LlmCompleteOptions, turn: number) => LlmCompletion;

describe('POST /ask — grounded answers via a provider', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  /** Swapped per test. */
  let script: Script;
  /** Every request the "provider" received, for asserting on prompt + tool wiring. */
  let seen: LlmCompleteOptions[];
  /** A service that really exists in this account's graph. */
  let subject: string;

  const ask = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/ask')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  beforeAll(async () => {
    process.env.LLM_VERIFY_KEYS = 'false'; // the stored key is fake; verification is tested elsewhere

    const stub: Pick<LlmClientFactory, 'create'> = {
      create: (): LlmProvider =>
        ({
          id: 'anthropic',
          verifyKey: () => Promise.resolve(),
          complete: (options: LlmCompleteOptions) => {
            seen.push(options);
            try {
              return Promise.resolve(script(options, seen.length - 1));
            } catch (err) {
              return Promise.reject(err);
            }
          },
        }) as LlmProvider,
    };

    app = await createTestApp((builder) =>
      builder.overrideProvider(LlmClientFactory).useValue(stub),
    );
    prisma = app.get(PrismaService);
    token = await login(app);

    const graph = (
      await request(app.getHttpServer())
        .get('/api/v1/graph')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body;
    const edges: { to: string }[] = graph.edges ?? [];
    const inbound = new Map<string, number>();
    for (const e of edges) inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
    const busiest = (graph.nodes as { id: string; name: string; type: string }[])
      .filter((n) => n.type === 'service')
      .sort((a, b) => (inbound.get(b.id) ?? 0) - (inbound.get(a.id) ?? 0))[0];
    if (!busiest || !inbound.get(busiest.id)) {
      throw new Error('This account has no service with inbound edges — cannot test citations.');
    }
    subject = busiest.name;
  });

  beforeEach(async () => {
    seen = [];
    await prisma.llmProviderKey.deleteMany({});
    await prisma.llmProviderKey.create({
      data: {
        accountId: (await prisma.user.findFirstOrThrow()).accountId,
        provider: 'anthropic',
        keyEnc: Buffer.from(
          // Encrypt through the app so the fixture matches whatever the store expects.
          (await import('../src/common/secret-box')).encryptSecret(
            ANTHROPIC_KEY,
            'LLM_ENCRYPTION_KEY',
          ),
        ),
        last4: 'a1b2',
      },
    });
  });

  afterAll(async () => {
    await prisma.llmProviderKey.deleteMany({});
    await app.close();
    delete process.env.LLM_VERIFY_KEYS;
  });

  /** Answers immediately, no tools. */
  const answerOnce =
    (text: string): Script =>
    () => ({ text, toolCalls: [] });

  it('409s with the spec wording when the provider has no key', async () => {
    await prisma.llmProviderKey.deleteMany({});
    script = answerOnce('should never run');

    const res = await ask({ question: 'what calls anything?', model: 'claude' }).expect(409);

    expect(res.body).toEqual({ error: 'no API key configured for anthropic' });
    expect(seen).toHaveLength(0); // no key, no spend
  });

  it('sends the catalog-grounded system prompt and the catalog tools', async () => {
    script = answerOnce('No dependencies found.');
    await ask({ question: 'hello', model: 'claude' }).expect(201);

    const [call] = seen;
    expect(call.model).toBe('claude-opus-5');
    // Explicit fallback model, never a provider-chosen default.
    expect(call.fallbackModel).toBe('claude-opus-4-8');
    expect(call.system).toContain('Answer ONLY from tool results');
    expect(call.system).toContain('<catalog>');
    expect(call.tools.map((t) => t.name)).toEqual([
      'list_services',
      'get_service_dependencies',
      'list_topics',
      'get_topic',
      'get_endpoints',
    ]);
    // max_tokens must leave room for thinking, not just the paragraph.
    expect(call.maxTokens).toBeGreaterThanOrEqual(8000);
  });

  it('runs the tool loop and cites real evidence', async () => {
    script = (_options, turn) =>
      turn === 0
        ? {
            text: 'Checking.',
            toolCalls: [
              {
                id: 'call_1',
                name: 'get_service_dependencies',
                input: { service: subject, direction: 'inbound' },
              },
            ],
          }
        : { text: `Several services call ${subject}.\nEVIDENCE: ev1`, toolCalls: [] };

    const res = await ask({ question: `what calls ${subject}?`, model: 'claude' }).expect(201);

    expect(seen).toHaveLength(2);
    expect(res.body.cites.length).toBeGreaterThan(0);
    expect(res.body.cites[0]).toMatchObject({
      name: expect.any(String),
      dir: expect.any(String),
      confidence: expect.stringMatching(/^(confirmed|likely|uncertain)$/),
    });
    // The citation bookkeeping is stripped — the UI renders cites itself.
    expect(res.body.text).not.toContain('EVIDENCE');
    expect(res.body.text).not.toMatch(/\bev\d+\b/);
    expect(res.body.model).toBe('claude-opus-5');

    // The tool result really reached the model on the second turn.
    const toolTurn = seen[1].turns.find((t) => t.role === 'tool');
    expect(toolTurn).toBeDefined();
  });

  it('DROPS citations the model invented, end to end', async () => {
    script = (_options, turn) =>
      turn === 0
        ? {
            text: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'get_service_dependencies',
                input: { service: subject, direction: 'inbound' },
              },
            ],
          }
        : {
            // ev1 is real; the rest are fabrications that must never reach the user.
            text: `${subject} has callers.\nEVIDENCE: ev1, ev404, ev999, made-up-service`,
            toolCalls: [],
          };

    const res = await ask({ question: `what calls ${subject}?`, model: 'claude' }).expect(201);

    expect(res.body.cites).toHaveLength(1);
    expect(res.body.text).not.toContain('made-up-service');
  });

  it('returns no cites when the model answers without consulting the catalog', async () => {
    script = answerOnce('I answer only from the scanned catalog. Name a service or a Kafka topic.');

    const res = await ask({ question: 'what is the weather?', model: 'claude' }).expect(201);

    // Nothing was gathered, so there is nothing to cite — never a fabricated basis.
    expect(res.body.cites).toEqual([]);
    expect(res.body.note).toBeNull();
  });

  it('feeds a recoverable error back to the model instead of failing the request', async () => {
    script = (_options, turn) =>
      turn === 0
        ? {
            text: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'get_service_dependencies',
                input: { service: 'nope-service' },
              },
            ],
          }
        : { text: 'That service is not in the catalog.', toolCalls: [] };

    const res = await ask({ question: 'what calls nope-service?', model: 'claude' }).expect(201);

    const toolTurn = seen[1].turns.find((t) => t.role === 'tool');
    const payload = JSON.parse(
      (toolTurn as { results: { content: string }[] }).results[0].content,
    ) as Record<string, unknown>;
    expect(payload.error).toContain('no service matching');
    expect(payload.available).toBeDefined(); // the model gets real names to retry with
    expect(res.body.text).toContain('not in the catalog');
  });

  it('stops at the iteration cap instead of looping forever', async () => {
    // A model that only ever asks for more tools.
    script = () => ({
      text: '',
      toolCalls: [{ id: 'call_x', name: 'list_services', input: {} }],
    });

    const res = await ask({ question: 'list everything repeatedly', model: 'claude' }).expect(201);

    expect(seen.length).toBeLessThanOrEqual(6);
    expect(res.body.text).toContain('could not narrow that down');
  });

  describe('provider failures never become answers', () => {
    const cases: [string, LlmProviderError, number][] = [
      [
        'a rejected key',
        new LlmProviderError('rejected', 'anthropic', 'the stored key was rejected'),
        502,
      ],
      [
        'a rate limit',
        new LlmProviderError('rate_limited', 'anthropic', 'rate-limited, try again'),
        429,
      ],
      ['an outage', new LlmProviderError('unavailable', 'anthropic', 'unavailable'), 503],
      ['a timeout', new LlmProviderError('timeout', 'anthropic', 'timed out'), 504],
      ['a refusal', new LlmProviderError('refused', 'anthropic', 'no grounded answer'), 502],
    ];

    it.each(cases)('%s surfaces as an error, not a response', async (_name, error, status) => {
      script = () => {
        throw error;
      };

      const res = await ask({ question: 'what calls things?', model: 'claude' }).expect(status);

      expect(typeof res.body.error).toBe('string');
      expect(res.body.error.length).toBeGreaterThan(0);
      // Critically: no fabricated answer alongside the error.
      expect(res.body.text).toBeUndefined();
      expect(res.body.cites).toBeUndefined();
    });
  });

  it('never leaks the stored key into a response', async () => {
    script = answerOnce(`the key is ${ANTHROPIC_KEY}`); // even if the model echoed it back

    const res = await ask({ question: 'anything', model: 'claude' }).expect(201);

    // The model's text is passed through, so this documents the boundary: we do not scrub model
    // output. What matters is that nothing in OUR plumbing puts the key there.
    const fromUs = { ...res.body, text: undefined };
    expect(JSON.stringify(fromUs)).not.toContain(ANTHROPIC_KEY);
  });
});
