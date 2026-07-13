import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  validateCommits,
  validateContracts,
  validateGraph,
} from '../src/common/integrity';

/**
 * Contract e2e: boots the real app against the seeded DB and re-runs the UI's integrity rules
 * against the live HTTP payloads. Requires `docker compose up -d db` + `prisma db seed` first.
 */
describe('P0 API contract', () => {
  let app: INestApplication;
  const REPO = 'acme/shop-platform';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /graph — flat envelope, no deg/meta, integrity holds', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/graph')
      .query({ repo: REPO, branch: 'main' })
      .expect(200);

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
    const res = await request(app.getHttpServer())
      .get('/api/v1/contracts')
      .query({ repo: REPO, branch: 'main' })
      .expect(200);

    expect(Array.isArray(res.body.endpoints)).toBe(true);
    expect(Array.isArray(res.body.topics)).toBe(true);
    expect(validateContracts(res.body)).toEqual([]);
  });

  it('GET /contracts?protocol=kafka — only topics', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/contracts')
      .query({ repo: REPO, branch: 'main', protocol: 'kafka' })
      .expect(200);

    expect(res.body.endpoints).toHaveLength(0);
    expect(res.body.topics.length).toBeGreaterThan(0);
  });

  it('GET /commits — BARE ARRAY (no wrapper), newest first, integrity holds', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/commits')
      .query({ repo: REPO, branch: 'main', limit: 20 })
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const times = res.body.map((c: { when: string }) => new Date(c.when).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(validateCommits(res.body)).toEqual([]);
  });

  it('rejects an unknown query param (strict validation)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/graph')
      .query({ repo: REPO, bogus: 'x' })
      .expect(400);
  });

  it('404s for an unknown repo', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/graph')
      .query({ repo: 'nope/nope' })
      .expect(404);
  });
});
