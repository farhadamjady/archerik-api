import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { validateCommits, validateContracts, validateGraph } from '../src/common/integrity';
import { createTestApp, login } from './e2e-utils';

/**
 * Contract e2e: boots the real app and re-runs the UI's integrity rules against the live HTTP
 * payloads. Requires `docker compose up -d db` and an account that holds at least one scan —
 * either `prisma db seed` or a real extractor ingest.
 *
 * Deliberately fixture-independent. An earlier version pinned `org: 'acme'` and
 * `repo: 'payment-service'` from the demo seed, so the whole suite went red the moment the database
 * held a real scan instead — which says nothing about whether the API contract holds. What the UI
 * actually depends on is the *shape*: the flat envelope, no deg/meta, working filters, and the
 * integrity validators. Those are asserted here against whatever the account really contains, with
 * the fixture values derived at runtime in beforeAll.
 *
 * The P0 endpoints are behind the global auth guard, so each request carries a bearer token.
 */
interface GraphNode {
  id: string;
  name: string;
  type: string;
  repo?: string | null;
  host?: string | null;
}
interface GraphEdge {
  from: string;
  to: string;
}

describe('P0 API contract', () => {
  let app: INestApplication;
  let token: string;
  /** A repo slug that genuinely exists in this account's graph — derived, never hardcoded. */
  let REPO: string;
  /** The account's org value, whatever it is (null is legitimate — the extractor may not report one). */
  let ORG: string | null;
  /** The service with the most inbound edges, so the "who calls X" ask has something to cite. */
  let BUSIEST: GraphNode | undefined;

  const authed = (path: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

  const authedPost = (path: string) =>
    request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await createTestApp();
    token = await login(app);

    const graph = (await authed('/api/v1/graph').expect(200)).body;
    ORG = graph.org ?? null;

    const nodes: GraphNode[] = graph.nodes ?? [];
    const edges: GraphEdge[] = graph.edges ?? [];
    if (nodes.length === 0) {
      throw new Error(
        'This account holds no scanned graph — run `npm run prisma:seed` or ingest a scan first.',
      );
    }

    const services = nodes.filter((n) => n.type === 'service' && n.repo);
    // Prefer the repo with the most service nodes: the most interesting subset to filter on.
    const byRepo = new Map<string, number>();
    for (const s of services) byRepo.set(s.repo!, (byRepo.get(s.repo!) ?? 0) + 1);
    REPO = [...byRepo.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const inbound = new Map<string, number>();
    for (const e of edges) inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
    BUSIEST = services.sort((a, b) => (inbound.get(b.id) ?? 0) - (inbound.get(a.id) ?? 0))[0];
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /graph — flat envelope, no deg/meta, integrity holds', async () => {
    const res = await authed('/api/v1/graph').query({ repo: REPO, branch: 'main' }).expect(200);

    expect(res.body).toMatchObject({ repo: REPO, branch: 'main' });
    expect(typeof res.body.scannedAt).toBe('string');
    expect(res.body).not.toHaveProperty('meta');
    // org is first-class on the envelope, but null is legitimate — the extractor may not report one.
    expect(res.body.org === null || typeof res.body.org === 'string').toBe(true);
    for (const node of res.body.nodes) {
      expect(node).not.toHaveProperty('deg');
      expect(node).not.toHaveProperty('inDeg');
    }
    // Every service node carries explicit repo + host (BACKEND-HANDOFF.md §3).
    const services = res.body.nodes.filter((n: GraphNode) => n.type === 'service');
    expect(services.length).toBeGreaterThan(0); // the filter matched something
    for (const node of services) {
      expect(typeof node.repo).toBe('string');
      expect(typeof node.host).toBe('string');
    }
    // The filter actually filters: every service in the subset belongs to the requested repo.
    for (const node of services) expect(node.repo).toBe(REPO);
    expect(validateGraph(res.body)).toEqual([]);
  });

  it('GET /graph (unscoped) — whole account, org present', async () => {
    const res = await authed('/api/v1/graph').expect(200);
    expect(res.body.repo).toBeNull();
    expect(res.body.org).toEqual(ORG);
    // The unscoped graph is a superset of any repo-filtered one.
    expect(res.body.nodes.length).toBeGreaterThan(0);
    expect(validateGraph(res.body)).toEqual([]);
  });

  it('GET /contracts — endpoints + topics, integrity holds', async () => {
    const res = await authed('/api/v1/contracts').query({ repo: REPO, branch: 'main' }).expect(200);

    expect(Array.isArray(res.body.endpoints)).toBe(true);
    expect(Array.isArray(res.body.topics)).toBe(true);
    expect(validateContracts(res.body)).toEqual([]);
  });

  it('GET /contracts?protocol=kafka — only topics', async () => {
    // Unscoped: whether any single repo happens to produce a topic is a property of the dataset,
    // not of the API. The filter semantics are what's under test.
    const all = await authed('/api/v1/contracts').query({ branch: 'main' }).expect(200);
    const res = await authed('/api/v1/contracts')
      .query({ branch: 'main', protocol: 'kafka' })
      .expect(200);

    expect(res.body.endpoints).toHaveLength(0);
    // Filtering by protocol must not drop topics — self-calibrating against the unfiltered call.
    expect(res.body.topics).toHaveLength(all.body.topics.length);
    for (const topic of res.body.topics) {
      expect(topic.kind).toBe('kafka');
      expect(typeof topic.topic).toBe('string');
    }
  });

  it('GET /commits — BARE ARRAY (no wrapper), newest first, integrity holds', async () => {
    const res = await authed('/api/v1/commits')
      .query({ repo: REPO, branch: 'main', limit: 20 })
      .expect(200);

    // Bare array, never a { commits: [...] } wrapper. In the account-scoped model the projection
    // produces no commits yet (the extractor doesn't send commit metadata), so this is an empty
    // array by design — the shape and ordering invariants must still hold.
    expect(Array.isArray(res.body)).toBe(true);
    const times = res.body.map((c: { when: string }) => new Date(c.when).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(validateCommits(res.body)).toEqual([]);
  });

  it('GET /models — non-empty list of {id,label,vendor,provider}', async () => {
    const res = await authed('/api/v1/models').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const m of res.body) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.label).toBe('string');
      expect(typeof m.vendor).toBe('string');
      // §5: the UI cross-references this against GET /settings/llm-keys to flag "needs key".
      expect(['anthropic', 'openai']).toContain(m.provider);
      // The provider's own model string stays server-side.
      expect(m).not.toHaveProperty('wireModel');
    }
    expect(res.body.some((m: { id: string }) => m.id === 'claude')).toBe(true);
    // `llama` was dropped: a model with no provider reads as always-available to the UI, and there
    // is no self-hosted inference endpoint to answer with.
    expect(res.body.some((m: { id: string }) => m.id === 'llama')).toBe(false);
  });

  it('POST /ask — grounded, returns cites, never invents', async () => {
    const res = await authedPost('/api/v1/ask')
      .send({ question: `what calls ${BUSIEST!.name}?`, model: 'claude' })
      .expect(201);

    expect(typeof res.body.text).toBe('string');
    expect(res.body.text.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.cites)).toBe(true);
    expect(res.body).toHaveProperty('note');
    // Sourced from the shared model registry, so /models and /ask can't drift apart.
    expect(res.body.model).toBe('claude-opus-5');

    // The invariant that actually matters (CLAUDE.md §6, "never invents"): every cite must name a
    // node that exists in the graph. Asserting a fixture's exact caller count tested the seed data;
    // this tests the guarantee, and survives Ask becoming a real LLM call.
    const graph = (await authed('/api/v1/graph').expect(200)).body;
    const known = new Set(
      (graph.nodes as GraphNode[]).flatMap((n) =>
        [n.name, n.repo, n.host, n.id].filter((v): v is string => typeof v === 'string'),
      ),
    );
    for (const cite of res.body.cites) {
      expect(known.has(cite.name)).toBe(true);
      expect(['confirmed', 'likely', 'uncertain']).toContain(cite.confidence);
    }
  });

  it('POST /ask — ungroundable question answers factually with no cites (never invents)', async () => {
    const res = await authedPost('/api/v1/ask')
      .send({ question: 'what is the weather today?' })
      .expect(201);
    expect(res.body.cites).toEqual([]);
    expect(typeof res.body.text).toBe('string');
    // Model resolution doesn't depend on seeded graph data, so it's pinned here too: an omitted
    // `model` falls back to the registry default rather than 400ing.
    expect(res.body.model).toBe('claude-opus-5');
  });

  it('POST /ask — empty question rejected (validation)', async () => {
    await authedPost('/api/v1/ask').send({ question: '' }).expect(400);
  });

  it('rejects an unknown query param (strict validation)', async () => {
    await authed('/api/v1/graph').query({ repo: REPO, bogus: 'x' }).expect(400);
  });

  it('unknown repo → 200 with an empty subset (account is the scope, repo is just a filter)', async () => {
    const res = await authed('/api/v1/graph').query({ repo: 'nope/nope' }).expect(200);
    expect(res.body.repo).toBe('nope/nope');
    expect(res.body.nodes).toEqual([]);
    expect(res.body.edges).toEqual([]);
  });

  it('401s without a token (protected endpoint)', async () => {
    await request(app.getHttpServer()).get('/api/v1/graph').query({ repo: REPO }).expect(401);
  });
});
