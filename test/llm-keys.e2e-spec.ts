import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { LlmClientFactory } from '../src/llm/llm-client.factory';
import { LlmProvider, LlmProviderError } from '../src/llm/provider.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, login } from './e2e-utils';

/**
 * Settings → LLM tab (BACKEND-LLM-KEYS.md §1-3).
 *
 * Mirrors the behaviour the spec pins against the UI's executable reference (dev-server.mjs):
 * GET returns configured/last4 only; PUT returns 422 (unknown provider) / 400 (empty key) and never
 * echoes the key; DELETE is 204 and idempotent.
 */

// Long enough to look like a real provider key, and distinctive enough to grep an entire response
// body for — that's what proves the key never leaks back out.
const ANTHROPIC_KEY = 'sk-ant-test-0000000000000000000000000000000000000000a1b2';
const OPENAI_KEY = 'sk-proj-test-1111111111111111111111111111111111111111c3d4';

describe('Settings → LLM provider keys', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  const auth = (): request.Test =>
    request(app.getHttpServer()).get('/api/v1/settings/llm-keys').set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    // These tests use fake keys and must not reach the network. The verification path itself is
    // covered separately below, against a stubbed provider.
    process.env.LLM_VERIFY_KEYS = 'false';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    token = await login(app);
    // Start from a known-empty store — this account may carry keys from a previous run.
    await prisma.llmProviderKey.deleteMany({});
  });

  afterAll(async () => {
    await prisma.llmProviderKey.deleteMany({});
    await app.close();
    delete process.env.LLM_VERIFY_KEYS;
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/v1/settings/llm-keys').expect(401);
  });

  it('GET — one entry per provider, none configured initially', async () => {
    const res = await auth().expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((e: { provider: string }) => e.provider).sort()).toEqual([
      'anthropic',
      'openai',
    ]);
    for (const entry of res.body) {
      expect(entry.configured).toBe(false);
      // last4/updatedAt appear ONLY when configured.
      expect(entry).not.toHaveProperty('last4');
      expect(entry).not.toHaveProperty('updatedAt');
    }
  });

  it('PUT — stores a key and returns status without echoing it', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/settings/llm-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'anthropic', apiKey: ANTHROPIC_KEY })
      .expect(200);

    expect(res.body).toEqual({
      provider: 'anthropic',
      configured: true,
      last4: 'a1b2',
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain(ANTHROPIC_KEY);
  });

  it('stores the key encrypted, not in the clear', async () => {
    const row = await prisma.llmProviderKey.findFirstOrThrow({ where: { provider: 'anthropic' } });
    // The ciphertext must not contain the plaintext, and must carry the v1 format byte.
    expect(row.keyEnc.toString('utf8')).not.toContain(ANTHROPIC_KEY);
    expect(row.keyEnc.readUInt8(0)).toBe(1);
    expect(row.last4).toBe('a1b2');
  });

  it('GET — reflects the stored key, still without the raw value', async () => {
    const res = await auth().expect(200);

    const anthropic = res.body.find((e: { provider: string }) => e.provider === 'anthropic');
    expect(anthropic).toMatchObject({ configured: true, last4: 'a1b2' });
    expect(anthropic.updatedAt).toEqual(expect.any(String));

    const openai = res.body.find((e: { provider: string }) => e.provider === 'openai');
    expect(openai.configured).toBe(false);

    expect(JSON.stringify(res.body)).not.toContain(ANTHROPIC_KEY);
  });

  it('PUT — replaces an existing key for the same provider (one row per provider)', async () => {
    const replacement = `${ANTHROPIC_KEY.slice(0, -4)}9z9z`;
    const res = await request(app.getHttpServer())
      .put('/api/v1/settings/llm-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'anthropic', apiKey: replacement })
      .expect(200);

    expect(res.body.last4).toBe('9z9z');
    const rows = await prisma.llmProviderKey.findMany({ where: { provider: 'anthropic' } });
    expect(rows).toHaveLength(1);
  });

  it('PUT — trims surrounding whitespace before storing', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/settings/llm-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'openai', apiKey: `  ${OPENAI_KEY}\n` })
      .expect(200);

    expect(res.body.last4).toBe('c3d4');
  });

  it('PUT — 422 with a user-facing error for an unknown provider', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/settings/llm-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'gemini', apiKey: 'sk-whatever' })
      .expect(422);

    expect(res.body).toEqual({ error: 'unknown provider' });
    // Nothing was stored for the rejected provider.
    expect(await prisma.llmProviderKey.count({ where: { provider: 'gemini' } })).toBe(0);
  });

  it('PUT — 400 with a user-facing error for an empty or whitespace-only key', async () => {
    for (const apiKey of ['', '   ']) {
      const res = await request(app.getHttpServer())
        .put('/api/v1/settings/llm-keys')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'anthropic', apiKey })
        .expect(400);

      expect(typeof res.body.error).toBe('string');
      expect(res.body.error.length).toBeGreaterThan(0);
    }
  });

  it('DELETE — 204, and the provider reads back as unconfigured', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/settings/llm-keys/anthropic')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const res = await auth().expect(200);
    const anthropic = res.body.find((e: { provider: string }) => e.provider === 'anthropic');
    expect(anthropic).toEqual({ provider: 'anthropic', configured: false });
  });

  it('DELETE — idempotent: deleting an unconfigured provider is still 204', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/settings/llm-keys/anthropic')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    // ...and so is an unknown one — the UI should never see an error for a disconnect.
    await request(app.getHttpServer())
      .delete('/api/v1/settings/llm-keys/gemini')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  });

  it('DELETE — removes only the named provider', async () => {
    const openai = await prisma.llmProviderKey.findFirst({ where: { provider: 'openai' } });
    expect(openai).not.toBeNull();
  });
});

/**
 * Key verification at save time (BACKEND-LLM-KEYS.md §2). Runs against a stubbed LlmClientFactory,
 * so it exercises the real service logic with no network access and no real provider key.
 */
describe('Settings → LLM key verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  /** Swapped per test to drive verifyKey down each branch. */
  let verify: () => Promise<void>;

  const put = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .put('/api/v1/settings/llm-keys')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  beforeAll(async () => {
    delete process.env.LLM_VERIFY_KEYS; // verification ON — that's the point of this block
    const stub: Pick<LlmClientFactory, 'create'> = {
      create: (): LlmProvider =>
        ({
          id: 'anthropic',
          verifyKey: () => verify(),
          complete: () => Promise.reject(new Error('not used in this suite')),
        }) as LlmProvider,
    };
    app = await createTestApp((builder) =>
      builder.overrideProvider(LlmClientFactory).useValue(stub),
    );
    prisma = app.get(PrismaService);
    token = await login(app);
    await prisma.llmProviderKey.deleteMany({});
  });

  afterAll(async () => {
    await prisma.llmProviderKey.deleteMany({});
    await app.close();
  });

  it('stores the key when the provider accepts it', async () => {
    verify = () => Promise.resolve();
    const res = await put({ provider: 'anthropic', apiKey: ANTHROPIC_KEY }).expect(200);
    expect(res.body.last4).toBe('a1b2');
    expect(await prisma.llmProviderKey.count({ where: { provider: 'anthropic' } })).toBe(1);
  });

  it('400s with a user-facing message when the provider rejects the key, and stores nothing', async () => {
    await prisma.llmProviderKey.deleteMany({});
    verify = () =>
      Promise.reject(new LlmProviderError('rejected', 'anthropic', 'the stored key was rejected'));

    const res = await put({ provider: 'anthropic', apiKey: 'sk-ant-bogus' }).expect(400);

    expect(res.body.error).toBe('Anthropic rejected this key. Check it and try again.');
    // A rejected key must never land in the store.
    expect(await prisma.llmProviderKey.count({ where: { provider: 'anthropic' } })).toBe(0);
  });

  it('503s and stores nothing when the provider is unreachable', async () => {
    await prisma.llmProviderKey.deleteMany({});
    verify = () =>
      Promise.reject(new LlmProviderError('timeout', 'anthropic', 'the request timed out'));

    const res = await put({ provider: 'anthropic', apiKey: ANTHROPIC_KEY }).expect(503);

    expect(typeof res.body.error).toBe('string');
    // Fails closed: an unverifiable key isn't stored, so the failure surfaces here rather than
    // later at Ask time where the user has no context for it.
    expect(await prisma.llmProviderKey.count({ where: { provider: 'anthropic' } })).toBe(0);
  });

  it('rejects an unknown provider before ever calling the provider', async () => {
    verify = () => Promise.reject(new Error('must not be called'));
    const res = await put({ provider: 'gemini', apiKey: 'sk-whatever' }).expect(422);
    expect(res.body).toEqual({ error: 'unknown provider' });
  });

  it('rejects an empty key before ever calling the provider', async () => {
    verify = () => Promise.reject(new Error('must not be called'));
    await put({ provider: 'anthropic', apiKey: '   ' }).expect(400);
  });
});
