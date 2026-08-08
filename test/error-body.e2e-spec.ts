import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, login } from './e2e-utils';

/**
 * The one promise: every non-2xx body is `{ error: <string> }` and nothing else.
 *
 * The UI renders that string verbatim, so these cases are deliberately the ones NOBODY wrote by
 * hand — framework rejections that used to emit `{statusCode, message, error}` (ValidationPipe) or
 * a body with no `error` key at all (ThrottlerGuard). Each asserts the exact key set, because a
 * stray `statusCode` alongside `error` would still let a UI bug hide.
 */
describe('error body shape (e2e)', () => {
  let app: NestExpressApplication;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    token = await login(app);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Asserts the body is exactly `{ error: <non-empty string> }` and returns the message. */
  function errorOf(body: unknown): string {
    expect(Object.keys(body as object)).toEqual(['error']);
    const { error } = body as { error: unknown };
    expect(typeof error).toBe('string');
    expect(error).not.toBe('');
    return error as string;
  }

  it('normalises a ValidationPipe rejection, keeping the useful text', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({ question: '' })
      .expect(400);

    // The old body put "Bad Request" in `error` and this text in `message`; the UI showed the
    // former. The class-validator message names the offending field, which is the point.
    expect(errorOf(res.body)).toContain('question');
  });

  it('normalises a rejected unknown query param', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/graph?branch=main&bogus=1')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    expect(errorOf(res.body)).toContain('bogus');
  });

  it('normalises the auth guard 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/graph?branch=main').expect(401);

    errorOf(res.body);
  });

  it('normalises a 404 for an unknown route', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/does-not-exist')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    errorOf(res.body);
  });

  it('passes a hand-written { error } body through verbatim', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/settings/llm-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'mistral', apiKey: 'sk-whatever' })
      .expect(422);

    // Exactly the string the service raised — the filter must not reword or wrap ours.
    expect(errorOf(res.body)).toBe('unknown provider');
  });

  it('normalises the extractor control plane too (/v1, not /api/v1)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/ingest')
      .set('Authorization', 'Bearer definitely-not-a-key')
      .send({ service_id: 'x' })
      .expect(401);

    // Safe to reshape: the Go CLI switches on status and never decodes an error body.
    errorOf(res.body);
  });

  // Last: exhausting the limiter poisons it for the rest of this app instance.
  it('normalises a throttled request, which used to have no error key at all', async () => {
    const send = (): request.Test =>
      request(app.getHttpServer())
        .post('/api/v1/auth/sso/start')
        .send({ email: 'nobody@example.com' });

    // Limit is 20/60s; the 21st trips it.
    let throttled: request.Response | undefined;
    for (let i = 0; i < 25 && !throttled; i++) {
      const res = await send();
      if (res.status === 429) throttled = res;
    }

    expect(throttled).toBeDefined();
    // Default was "ThrottlerException: Too many requests" — a class name in a user-facing bubble.
    expect(errorOf(throttled!.body)).toBe('Too many requests — wait a moment and try again.');
  });
});
