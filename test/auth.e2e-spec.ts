import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, DEMO_CREDENTIALS, login } from './e2e-utils';

/**
 * Auth e2e (P1 §6). Requires `docker compose up -d db` + `prisma db seed` (creates the demo user).
 */
describe('P1 auth', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /auth/login — valid creds → { token, user }', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(DEMO_CREDENTIALS)
      .expect(201);

    expect(typeof res.body.token).toBe('string');
    expect(res.body.user).toEqual({ name: 'Priya Nair', handle: 'priyan', team: 'payments' });
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('POST /auth/login — bad password → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: DEMO_CREDENTIALS.email, password: 'wrong' })
      .expect(401);
  });

  it('POST /auth/login — unknown email → 401 (no account enumeration)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@acme.com', password: 'whatever' })
      .expect(401);
  });

  it('POST /auth/login — malformed body → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email' })
      .expect(400);
  });

  it('GET /me — with token → profile; without token → 401', async () => {
    const token = await login(app);

    const ok = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(ok.body).toEqual({ name: 'Priya Nair', handle: 'priyan', team: 'payments' });

    await request(app.getHttpServer()).get('/api/v1/me').expect(401);
  });

  it('POST /auth/logout — token is invalidated afterwards', async () => {
    const token = await login(app);
    const auth = `Bearer ${token}`;

    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', auth).expect(200);
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Authorization', auth).expect(201);
    // Same token no longer works — server-side revocation, not just a client-side discard.
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', auth).expect(401);
  });

  it('GET /auth/sso — returns an HTML page that stores the token and redirects', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/sso').expect(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain("sessionStorage.setItem('cartograph.token'");
  });
});
