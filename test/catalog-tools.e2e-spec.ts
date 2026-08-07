import {
  Catalog,
  CATALOG_TOOLS,
  executeCatalogTool,
  ToolContext,
} from '../src/ask/catalog-tools';
import { buildNote, EvidenceLedger } from '../src/ask/evidence';
import { EdgeDto, EndpointContractDto, NodeDto, TopicContractDto } from '../src/common/types';

/**
 * Pure unit tests for the catalog tools and the evidence ledger — no app, no DB, no network. They
 * ride the e2e runner because that is the only ts-jest-configured jest project in the repo.
 *
 * This is the layer that makes "never invents" (CLAUDE.md §6) structural, so it is tested on its
 * own rather than through a live Ask call, where a model's cooperation would be doing half the work.
 */

const node = (over: Partial<NodeDto> & { id: string }): NodeDto => ({
  name: over.id,
  team: 'platform',
  type: 'service',
  note: null,
  ...over,
});

const CATALOG: Catalog = {
  nodes: [
    node({ id: 'payment-service', repo: 'payment-service', host: 'payment-service', language: 'Java' }),
    node({ id: 'checkout', name: 'CheckoutOrchestrator', repo: 'checkout', host: 'checkout' }),
    node({ id: 'refund', name: 'RefundService', repo: 'refund', host: 'refund' }),
    node({ id: 'stripe', name: 'StripeAPI', type: 'external', host: 'api.stripe.com' }),
  ],
  edges: [
    {
      id: 'e0',
      from: 'checkout',
      to: 'payment-service',
      protocol: 'rest',
      method: 'FeignClient',
      confidence: 'confirmed',
      label: 'POST /payments',
    },
    {
      id: 'e1',
      from: 'refund',
      to: 'payment-service',
      protocol: 'rest',
      method: 'RestTemplate',
      confidence: 'uncertain',
      label: 'POST /payments/{id}/refund',
    },
    {
      id: 'e2',
      from: 'payment-service',
      to: 'stripe',
      protocol: 'rest',
      method: 'WebClient',
      confidence: 'likely',
      label: 'POST /v1/charges',
    },
    {
      id: 'e3',
      from: 'payment-service',
      to: 'PaymentAuthorized',
      protocol: 'kafka',
      method: 'KafkaTemplate',
      confidence: 'confirmed',
      label: 'PaymentAuthorized',
    },
  ] as EdgeDto[],
  topics: [
    {
      id: 'tp0',
      kind: 'kafka',
      topic: 'PaymentAuthorized',
      producer: 'payment-service',
      source: 'Schema Registry (Avro)',
      confidence: 'confirmed',
      consumers: ['checkout', 'refund'],
      message: [{ name: 'paymentId', type: 'UUID', nullable: false, note: null }],
    },
    {
      id: 'tp1',
      kind: 'kafka',
      topic: 'OrphanEvent',
      producer: null,
      source: 'no registered schema',
      confidence: 'uncertain',
      consumers: ['checkout'],
      message: [],
    },
  ] as TopicContractDto[],
  endpoints: [
    {
      id: 'ep0',
      kind: 'rest',
      service: 'payment-service',
      verb: 'POST',
      path: '/payments',
      source: 'in-code DTO (Feign)',
      confidence: 'confirmed',
      method: 'FeignClient',
      unresolved: false,
      callers: ['checkout', 'refund'],
      request: [{ name: 'orderId', type: 'UUID', nullable: false, note: null }],
      response: [{ name: 'paymentId', type: 'UUID', nullable: false, note: null }],
    },
  ] as EndpointContractDto[],
};

const context = (): ToolContext => ({ catalog: CATALOG, ledger: new EvidenceLedger() });
const run = (name: string, input: Record<string, unknown>, ctx: ToolContext) =>
  executeCatalogTool(name, input, ctx);

describe('catalog tools', () => {
  it('every tool spec is a well-formed JSON Schema object', () => {
    for (const tool of CATALOG_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema).toHaveProperty('properties');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
    // Every executable tool is advertised, and every advertised tool executes.
    for (const tool of CATALOG_TOOLS) {
      expect(run(tool.name, {}, context())).not.toMatchObject({ error: expect.stringContaining('unknown tool') });
    }
  });

  it('list_services filters and reports degree', () => {
    const out = run('list_services', { query: 'payment' }, context()) as any;
    expect(out.services).toHaveLength(1);
    expect(out.services[0]).toMatchObject({
      name: 'payment-service',
      language: 'Java',
      inbound: 2,
      outbound: 2,
    });
  });

  it('list_services records no evidence — a listing proves nothing', () => {
    const ctx = context();
    run('list_services', {}, ctx);
    expect(ctx.ledger.size).toBe(0);
  });

  it('get_service_dependencies returns inbound edges with evidence ids', () => {
    const ctx = context();
    const out = run(
      'get_service_dependencies',
      { service: 'payment-service', direction: 'inbound' },
      ctx,
    ) as any;

    expect(out.dependencies).toHaveLength(2);
    expect(out.dependencies[0]).toMatchObject({
      direction: 'inbound',
      caller: 'CheckoutOrchestrator',
      confidence: 'confirmed',
      evidence_id: 'ev1',
    });
    // The contract's wording about derived-vs-declared is supplied, not left to the model.
    expect(out.note).toContain('derived from callers');
    expect(ctx.ledger.size).toBe(2);
  });

  it('labels a kafka edge by topic and a rest edge by method', () => {
    const ctx = context();
    run('get_service_dependencies', { service: 'payment-service', direction: 'outbound' }, ctx);

    const cites = ctx.ledger.all();
    expect(cites).toContainEqual({ name: 'StripeAPI', dir: 'WebClient', confidence: 'likely' });
    expect(cites).toContainEqual({
      name: 'PaymentAuthorized',
      dir: 'via PaymentAuthorized',
      confidence: 'confirmed',
    });
  });

  it('resolves a service by repo slug or host, not just by name', () => {
    for (const service of ['checkout', 'CheckoutOrchestrator']) {
      const out = run('get_service_dependencies', { service }, context()) as any;
      expect(out.service).toBe('CheckoutOrchestrator');
    }
  });

  it('get_topic records producer and consumers, and flags a missing producer', () => {
    const ctx = context();
    const out = run('get_topic', { topic: 'PaymentAuthorized' }, ctx) as any;

    expect(out.producer).toMatchObject({ name: 'payment-service', evidence_id: expect.any(String) });
    expect(out.consumers.map((c: any) => c.name)).toEqual(['CheckoutOrchestrator', 'RefundService']);
    expect(ctx.ledger.size).toBe(3); // producer + 2 consumers

    const orphan = run('get_topic', { topic: 'OrphanEvent' }, context()) as any;
    expect(orphan.producer).toBeNull();
    expect(orphan.note).toContain('No producer was found');
  });

  it('get_endpoints returns callers as evidence and lists field names', () => {
    const ctx = context();
    const out = run('get_endpoints', { service: 'payment-service' }, ctx) as any;

    expect(out.endpoints[0]).toMatchObject({ verb: 'POST', path: '/payments' });
    expect(out.endpoints[0].callers.map((c: any) => c.name)).toEqual([
      'CheckoutOrchestrator',
      'RefundService',
    ]);
    expect(out.endpoints[0].request_fields).toEqual(['orderId']);
    expect(ctx.ledger.size).toBe(2);
  });

  describe('recoverable errors — the loop must be able to self-correct', () => {
    it('unknown tool name lists what is available', () => {
      const out = run('get_weather', {}, context()) as any;
      expect(out.error).toContain('unknown tool');
      expect(out.available).toContain('list_services');
    });

    it('unknown service suggests real ones instead of failing', () => {
      const out = run('get_service_dependencies', { service: 'nope-service' }, context()) as any;
      expect(out.error).toContain('no service matching');
      expect(out.available).toContain('payment-service');
    });

    it('missing and invalid arguments are reported, never thrown', () => {
      expect(run('get_service_dependencies', {}, context())).toMatchObject({
        error: 'service is required',
      });
      expect(
        run('get_service_dependencies', { service: 'payment-service', direction: 'sideways' }, context()),
      ).toMatchObject({ error: expect.stringContaining('direction must be one of') });
      expect(run('get_topic', {}, context())).toMatchObject({ error: 'topic is required' });
    });

    it('survives arguments of the wrong type (a model can emit anything)', () => {
      for (const bad of [{ service: 42 }, { service: null }, { service: { a: 1 } }, {}]) {
        expect(() => run('get_service_dependencies', bad as any, context())).not.toThrow();
      }
    });
  });
});

describe('evidence ledger', () => {
  it('assigns stable sequential ids and collapses a repeated fact', () => {
    const ledger = new EvidenceLedger();
    const first = ledger.record({ name: 'checkout', dir: 'FeignClient', confidence: 'confirmed' });
    const again = ledger.record({ name: 'checkout', dir: 'FeignClient', confidence: 'confirmed' });
    const other = ledger.record({ name: 'refund', dir: 'RestTemplate', confidence: 'uncertain' });

    expect(first).toBe('ev1');
    expect(again).toBe('ev1'); // same fact, same handle
    expect(other).toBe('ev2');
    expect(ledger.size).toBe(2);
  });

  it('DROPS ids the model invented — the whole point of the ledger', () => {
    const ctx = context();
    run('get_service_dependencies', { service: 'payment-service', direction: 'inbound' }, ctx);

    // ev1/ev2 are real; the rest are fabrications of exactly the kind we must never publish.
    const cites = ctx.ledger.resolveCites(['ev1', 'ev99', 'ev-fake', 'PaymentService']);

    expect(cites).toHaveLength(1);
    expect(cites[0].name).toBe('CheckoutOrchestrator');
  });

  it('tolerates decorated ids in prose', () => {
    const ctx = context();
    run('get_service_dependencies', { service: 'payment-service', direction: 'inbound' }, ctx);

    expect(ctx.ledger.resolveCites(['[ev1]', 'EV2.'])).toHaveLength(2);
  });

  it('falls back to gathered evidence when the model names nothing usable', () => {
    const ctx = context();
    run('get_service_dependencies', { service: 'payment-service', direction: 'inbound' }, ctx);

    // The evidence is real either way — only the model's bookkeeping failed.
    expect(ctx.ledger.resolveCites([])).toHaveLength(2);
    expect(ctx.ledger.resolveCites(['ev404'])).toHaveLength(2);
  });

  it('returns nothing when no tool ever ran, rather than inventing a basis', () => {
    const ledger = new EvidenceLedger();
    expect(ledger.resolveCites(['ev1'])).toEqual([]);
    expect(ledger.all()).toEqual([]);
  });

  it('caps cites at 8', () => {
    const ledger = new EvidenceLedger();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(ledger.record({ name: `svc-${i}`, dir: 'FeignClient', confidence: 'confirmed' }));
    }
    expect(ledger.resolveCites(ids)).toHaveLength(8);
    expect(ledger.all()).toHaveLength(8);
  });

  it('deduplicates repeated ids in the model’s answer', () => {
    const ctx = context();
    run('get_service_dependencies', { service: 'payment-service', direction: 'inbound' }, ctx);
    expect(ctx.ledger.resolveCites(['ev1', 'ev1', 'ev1'])).toHaveLength(1);
  });
});

describe('buildNote', () => {
  it('is null when every cite is confirmed', () => {
    expect(buildNote([{ name: 'a', dir: 'FeignClient', confidence: 'confirmed' }])).toBeNull();
  });

  it('counts likely and uncertain evidence', () => {
    const note = buildNote([
      { name: 'a', dir: 'FeignClient', confidence: 'confirmed' },
      { name: 'b', dir: 'WebClient', confidence: 'likely' },
      { name: 'c', dir: 'RestTemplate', confidence: 'uncertain' },
    ]);
    expect(note).toBe(
      '2 of these rest on likely/uncertain edges — treat the list as indicative, not exhaustive.',
    );
  });

  it('is null for an empty answer', () => {
    expect(buildNote([])).toBeNull();
  });
});
