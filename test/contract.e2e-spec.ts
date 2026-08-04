import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { validateCommits, validateContracts, validateGraph } from '../src/common/integrity';
import { createTestApp, login } from './e2e-utils';

/**
 * Contract e2e: boots the real app against the seeded DB and re-runs the UI's integrity rules
 * against the live HTTP payloads. Requires `docker compose up -d db` + `prisma db seed` first.
 * The P0 endpoints are now behind the global auth guard, so each request carries a bearer token.
 */
describe('P0 API contract', () => {
  let app: INestApplication;
  let token: string;
  // The catalog is repo-centric: a repo == a service's own repository slug. `payment-service` has
  // both an endpoint and a produced topic, so it exercises both contract branches under a filter.
  const REPO = 'payment-service';

  const authed = (path: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

  const authedPost = (path: string) =>
    request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await createTestApp();
    token = await login(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /graph — flat envelope, no deg/meta, integrity holds', async () => {
    const res = await authed('/api/v1/graph').query({ repo: REPO, branch: 'main' }).expect(200);

    expect(res.body).toMatchObject({ repo: REPO, branch: 'main' });
    expect(typeof res.body.scannedAt).toBe('string');
    expect(res.body).not.toHaveProperty('meta');
    // org is now first-class on the envelope; the demo fleet is one org.
    expect(res.body.org).toBe('acme');
    for (const node of res.body.nodes) {
      expect(node).not.toHaveProperty('deg');
      expect(node).not.toHaveProperty('inDeg');
    }
    // Every service node carries explicit repo + host (BACKEND-HANDOFF.md §3).
    for (const node of res.body.nodes.filter((n: { type: string }) => n.type === 'service')) {
      expect(typeof node.repo).toBe('string');
      expect(typeof node.host).toBe('string');
    }
    expect(validateGraph(res.body)).toEqual([]);
  });

  it('GET /graph (unscoped) — whole account, org present', async () => {
    const res = await authed('/api/v1/graph').expect(200);
    expect(res.body.repo).toBeNull();
    expect(res.body.org).toBe('acme');
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
    const res = await authed('/api/v1/contracts')
      .query({ repo: REPO, branch: 'main', protocol: 'kafka' })
      .expect(200);

    expect(res.body.endpoints).toHaveLength(0);
    expect(res.body.topics.length).toBeGreaterThan(0);
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

  it('GET /models — non-empty list of {id,label,vendor}', async () => {
    const res = await authed('/api/v1/models').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const m of res.body) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.label).toBe('string');
      expect(typeof m.vendor).toBe('string');
    }
    expect(res.body.some((m: { id: string }) => m.id === 'claude')).toBe(true);
  });

  it('POST /ask — grounded, returns cites, never invents', async () => {
    const res = await authedPost('/api/v1/ask')
      .send({ question: 'what calls payment-service?', model: 'claude' })
      .expect(201);

    expect(typeof res.body.text).toBe('string');
    expect(res.body.text.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.cites)).toBe(true);
    // CheckoutOrchestrator and OrderService both call PaymentService in the demo fleet.
    expect(res.body.cites.length).toBeGreaterThanOrEqual(2);
    expect(res.body).toHaveProperty('note');
    expect(res.body.model).toBe('claude-sonnet-4-5');
  });

  it('POST /ask — ungroundable question answers factually with no cites (never invents)', async () => {
    const res = await authedPost('/api/v1/ask')
      .send({ question: 'what is the weather today?' })
      .expect(201);
    expect(res.body.cites).toEqual([]);
    expect(typeof res.body.text).toBe('string');
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
