import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  validateCommits,
  validateContracts,
  validateGraph,
} from '../src/common/integrity';
import { createTestApp, login } from './e2e-utils';

/**
 * Contract e2e: boots the real app against the seeded DB and re-runs the UI's integrity rules
 * against the live HTTP payloads. Requires `docker compose up -d db` + `prisma db seed` first.
 * The P0 endpoints are now behind the global auth guard, so each request carries a bearer token.
 */
describe('P0 API contract', () => {
  let app: INestApplication;
  let token: string;
  const REPO = 'acme/shop-platform';

  const authed = (path: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

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
    for (const node of res.body.nodes) {
      expect(node).not.toHaveProperty('deg');
      expect(node).not.toHaveProperty('inDeg');
    }
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

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const times = res.body.map((c: { when: string }) => new Date(c.when).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(validateCommits(res.body)).toEqual([]);
  });

  it('rejects an unknown query param (strict validation)', async () => {
    await authed('/api/v1/graph').query({ repo: REPO, bogus: 'x' }).expect(400);
  });

  it('404s for an unknown repo', async () => {
    await authed('/api/v1/graph').query({ repo: 'nope/nope' }).expect(404);
  });

  it('401s without a token (protected endpoint)', async () => {
    await request(app.getHttpServer()).get('/api/v1/graph').query({ repo: REPO }).expect(401);
  });
});
