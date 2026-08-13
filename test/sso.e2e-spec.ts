import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './e2e-utils';
import { MockIdp, seedSsoConnection, setupMockIdp } from './sso-fixtures';

/**
 * SSO e2e (P1 §6, replaces the old ssoLogin() stub). Requires `docker compose up -d db` +
 * `prisma db seed`, same as auth.e2e-spec.ts. No live IdP: `setupMockIdp` (test/sso-fixtures.ts)
 * intercepts the three URLs `openid-client` actually calls (discovery/jwks/token) by overriding
 * `globalThis.fetch`, so real signature/iss/aud/nonce validation runs against real crypto, just a
 * fake network.
 */
describe('SSO login', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let mockIdp: MockIdp;
  let accountId: string;
  let domain: string;
  // Accounts created during a test (via prisma.account.create — beforeEach's + any test-local
  // extras like the cross-account collision test's second account), cascade-deleted in afterEach so
  // repeated local runs don't accumulate users/handles across runs.
  let createdAccountIds: string[];

  async function createAccount(name: string): Promise<string> {
    const account = await prisma.account.create({
      data: { name, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) },
    });
    createdAccountIds.push(account.id);
    return account.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    mockIdp = await setupMockIdp();
    createdAccountIds = [];
    domain = `sso-test-${randomUUID()}.example`;
    accountId = await createAccount('SSO test account');
    await seedSsoConnection(prisma, { accountId, domain });
  });

  afterEach(async () => {
    mockIdp.restore();
    // Cascades to Users/SsoConnection/SsoDomain/SsoAuthRequest owned by these accounts.
    await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  });

  /** Starts the flow and returns the parsed authorize-URL params ({@link accountId}'s connection). */
  async function start(email: string): Promise<{ url: URL; body: unknown }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/sso/start')
      .send({ email })
      .expect(201);
    return {
      url: new URL((res.body as { redirectUrl?: string }).redirectUrl ?? 'http://x/'),
      body: res.body,
    };
  }

  async function completeCallback(
    email: string,
    claimOverrides: Record<string, unknown> = {},
  ): Promise<{ code: number; text: string }> {
    const { url } = await start(email);
    const state = url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;
    const connection = await prisma.ssoConnection.findUnique({ where: { accountId } });

    const idToken = await mockIdp.signIdToken({
      sub: `idp-sub-${randomUUID()}`,
      aud: connection!.clientId,
      email,
      email_verified: true,
      name: 'Test User',
      nonce,
      ...claimOverrides,
    });
    mockIdp.mockTokenEndpoint(idToken);

    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/sso/callback')
      .query({ code: `mock-code-${randomUUID()}`, state });
    return { code: res.status, text: res.text };
  }

  function tokenFrom(html: string): string {
    const match = html.match(/cartograph\.token', "([^"]+)"\)/);
    if (!match) throw new Error(`No token found in HTML: ${html}`);
    return match[1];
  }

  it('unconfigured domain → { sso: false }', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/sso/start')
      .send({ email: `user@no-such-domain-${randomUUID()}.example` })
      .expect(201);
    expect(res.body).toEqual({ sso: false });
  });

  it('disabled connection → { sso: false } (same shape as unconfigured)', async () => {
    await prisma.ssoConnection.update({ where: { accountId }, data: { enabled: false } });
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/sso/start')
      .send({ email: `user@${domain}` })
      .expect(201);
    expect(res.body).toEqual({ sso: false });
  });

  it('configured domain → { sso: true, redirectUrl } with state/nonce/PKCE', async () => {
    const { url, body } = await start(`user@${domain}`);
    expect((body as { sso: boolean }).sso).toBe(true);
    expect(url.origin).toBe('https://mock-idp.test');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('full round trip JIT-creates a user under the right account and issues a working session', async () => {
    const email = `newuser-${randomUUID()}@${domain}`;
    // Unique name so the handle-slug assertion below can't collide with another test's JIT user —
    // handle uniqueness is deduped app-wide (no per-test DB reset), not scoped to this test.
    const { code, text } = await completeCallback(email, { name: 'Round Trip User' });
    expect(code).toBe(200);
    expect(text).toContain("sessionStorage.setItem('cartograph.token'");

    const token = tokenFrom(text);
    const me = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.handle).toBe('round-trip-user');

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.accountId).toBe(accountId);
  });

  it('repeat login reuses the same user (no duplicate row)', async () => {
    const email = `repeat-${randomUUID()}@${domain}`;
    await completeCallback(email);
    await completeCallback(email);

    const users = await prisma.user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
  });

  it('links an existing same-account password user instead of duplicating', async () => {
    const email = `password-user-${randomUUID()}@${domain}`;
    const existing = await prisma.user.create({
      data: {
        accountId,
        email,
        passwordHash: 'unused-in-this-test',
        name: 'Password User',
        handle: 'password-user',
        team: 'payments',
      },
    });

    const { code, text } = await completeCallback(email);
    expect(code).toBe(200);
    const token = tokenFrom(text);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const users = await prisma.user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe(existing.id);
    expect(users[0].passwordHash).toBe('unused-in-this-test');
  });

  it('rejects an email that already belongs to a different account', async () => {
    const email = `collision-${randomUUID()}@${domain}`;
    const otherAccountId = await createAccount('Other account');
    await prisma.user.create({
      data: {
        accountId: otherAccountId,
        email,
        passwordHash: 'unused-in-this-test',
        name: 'Other Account User',
        handle: 'other-user',
        team: 'payments',
      },
    });

    const { code, text } = await completeCallback(email);
    // The callback always renders 200 (full-page navigation), but the error page — not a session.
    expect(code).toBe(200);
    expect(text).not.toContain('cartograph.token');
    expect(text).toContain('sso_error=1');

    const users = await prisma.user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
    expect(users[0].accountId).toBe(otherAccountId);
  });

  it('rejects an unverified email claim', async () => {
    const email = `unverified-${randomUUID()}@${domain}`;
    const { code, text } = await completeCallback(email, { email_verified: false });
    expect(code).toBe(200);
    expect(text).not.toContain('cartograph.token');
    expect(text).toContain('sso_error=1');
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('rejects a nonce mismatch', async () => {
    const email = `bad-nonce-${randomUUID()}@${domain}`;
    const { code, text } = await completeCallback(email, { nonce: 'wrong-nonce' });
    expect(code).toBe(200);
    expect(text).toContain('sso_error=1');
  });

  it('rejects an audience mismatch', async () => {
    const email = `bad-aud-${randomUUID()}@${domain}`;
    const { code, text } = await completeCallback(email, { aud: 'someone-elses-client-id' });
    expect(code).toBe(200);
    expect(text).toContain('sso_error=1');
  });

  it('rejects an unknown state', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/sso/callback')
      .query({ code: 'mock-code', state: 'not-a-real-state' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('sso_error=1');
  });

  it('rejects a reused state (single-use)', async () => {
    const email = `reuse-state-${randomUUID()}@${domain}`;
    const { url } = await start(email);
    const state = url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;
    const connection = await prisma.ssoConnection.findUnique({ where: { accountId } });
    const idToken = await mockIdp.signIdToken({
      sub: 'idp-sub-reuse',
      aud: connection!.clientId,
      email,
      email_verified: true,
      nonce,
    });
    mockIdp.mockTokenEndpoint(idToken);

    const first = await request(app.getHttpServer())
      .get('/api/v1/auth/sso/callback')
      .query({ code: 'mock-code-1', state });
    expect(first.text).toContain('cartograph.token');

    const second = await request(app.getHttpServer())
      .get('/api/v1/auth/sso/callback')
      .query({ code: 'mock-code-2', state });
    expect(second.text).toContain('sso_error=1');
  });
});
