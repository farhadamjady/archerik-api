import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, DEMO_API_KEY, DEMO_CREDENTIALS } from './e2e-utils';

/**
 * Extractor control-plane e2e. Requires `docker compose up -d db` +
 * `prisma db seed` (creates the demo Account + API key). A fresh random service_id per run keeps
 * "first scan" deterministic without cross-run baseline collisions.
 */
describe('extractor /v1 control plane', () => {
  let app: INestApplication;
  const auth = `Bearer ${DEMO_API_KEY}`;
  const serviceId = `e2e-svc-${Date.now()}`;

  const body = (extraDeps: unknown[] = []): string =>
    JSON.stringify({
      service_id: serviceId,
      service_name: `${serviceId}-service`,
      endpoints: [
        {
          method: 'GET',
          path: '/x/{id}',
          protocol: 'rest',
          detection: 'annotation',
          confidence: 'confirmed',
        },
      ],
      outbound_dependencies: extraDeps,
      kafka_producers: [],
      kafka_consumers: [],
      databases_used: [],
      config_dependencies: [],
    });

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /v1/auth/validate', () => {
    it('valid key → 200 + entitlement', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/validate')
        .set('Authorization', auth)
        .expect(200);
      expect(res.body).toMatchObject({
        plan: expect.any(String),
        quota_remaining: expect.any(Number),
      });
      expect(typeof res.body.expires_at).toBe('string');
    });

    it('missing / bad key → 401', async () => {
      await request(app.getHttpServer()).post('/v1/auth/validate').expect(401);
      await request(app.getHttpServer())
        .post('/v1/auth/validate')
        .set('Authorization', 'Bearer nope')
        .expect(401);
    });

    it('a UI session token is NOT accepted here (separate credential) → 401', async () => {
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send(DEMO_CREDENTIALS)
        .expect(201);
      await request(app.getHttpServer())
        .post('/v1/auth/validate')
        .set('Authorization', `Bearer ${login.body.token}`)
        .expect(401);
    });
  });

  describe('POST /v1/ingest', () => {
    it('first scan on the default branch → first_scan + baseline_updated, full diff', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/ingest')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .set('X-EKG-Default-Branch', 'main')
        .send(body())
        .expect(200);
      expect(res.body).toMatchObject({
        service_id: serviceId,
        unchanged: false,
        first_scan: true,
        baseline_updated: true,
      });
      expect(res.body.diff.summary.added).toBeGreaterThan(0);
    });

    it('byte-identical resubmit → unchanged fast path, no diff, empty markdown', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/ingest')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .set('X-EKG-Default-Branch', 'main')
        .send(body())
        .expect(200);
      expect(res.body.unchanged).toBe(true);
      expect(res.body.diff).toBeUndefined();
      expect(res.body.markdown).toBe('');
    });

    it('PR scan (non-default branch) → diffs but never writes the baseline', async () => {
      const pr = await request(app.getHttpServer())
        .post('/v1/ingest')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .set('X-EKG-Branch', 'feat/x')
        .set('X-EKG-Default-Branch', 'main')
        .send(
          body([
            {
              target_name: 'other-svc',
              protocol: 'rest',
              detection: 'feign',
              confidence: 'confirmed',
              resolved: false,
            },
          ]),
        )
        .expect(200);
      expect(pr.body.first_scan).toBe(false);
      expect(pr.body.baseline_updated).toBe(false);
      expect(pr.body.diff.outbound_dependencies.added).toHaveLength(1);

      // Baseline untouched: the original body still byte-matches.
      const after = await request(app.getHttpServer())
        .post('/v1/ingest')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .set('X-EKG-Default-Branch', 'main')
        .send(body())
        .expect(200);
      expect(after.body.unchanged).toBe(true);
    });

    it('body without service_id → 400', async () => {
      await request(app.getHttpServer())
        .post('/v1/ingest')
        .set('Authorization', auth)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ nope: true }))
        .expect(400);
    });

    it('bad API key → 401', async () => {
      await request(app.getHttpServer())
        .post('/v1/ingest')
        .set('Authorization', 'Bearer nope')
        .set('Content-Type', 'application/json')
        .send(body())
        .expect(401);
    });
  });
});
