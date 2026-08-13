import { PrismaClient } from '@prisma/client';
import { createSign, generateKeyPairSync, KeyObject, randomUUID } from 'crypto';
import { encryptSecret } from '../src/auth/sso/sso-crypto';

export const MOCK_ISSUER = 'https://mock-idp.test';
const KID = 'test-key';

/**
 * RS256 signing with Node's built-in crypto rather than `jose`.
 *
 * `jose` is ESM-only, so importing it from this CommonJS-compiled fixture needed the same
 * `new Function('specifier', 'return import(specifier)')` trick as src/auth/sso/oidc-client.ts —
 * and that turned out to break the suite. V8 caches `new Function` compilations by source text, so
 * two call sites with byte-identical source share one compiled function, bound to the realm that
 * compiled it FIRST. Under Jest each test file gets its own realm, which is torn down when the file
 * finishes. Once any earlier suite had booted the app (compiling oidc-client's copy), this file's
 * identical `new Function` resolved to that dead realm and every SSO test failed with "Test
 * environment has been torn down" — with a stack that blamed oidc-client.ts for a call made here.
 *
 * It only reproduced when sso.e2e-spec did NOT run first, so a warm Jest cache (which reorders
 * previously-failing suites to the front) hid it locally while CI failed every time.
 *
 * Node's crypto signs RS256 natively and is a plain CommonJS built-in, so there is no dynamic
 * import here at all — the class of bug is gone rather than worked around.
 */
const b64url = (input: string | Buffer): string => Buffer.from(input).toString('base64url');

function signRs256(claims: Record<string, unknown>, privateKey: KeyObject): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const now = Math.floor(Date.now() / 1000);
  // Caller claims first, then the envelope this mock IdP always controls — mirroring the previous
  // jose chain, where .setIssuer()/.setIssuedAt()/.setExpirationTime() overrode the constructor.
  const payload = { ...claims, iss: MOCK_ISSUER, iat: now, exp: now + 300 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

export interface MockIdp {
  /** Signs an ID token as the mock IdP. Callers set `aud`/`sub`/`nonce`/email claims as needed. */
  signIdToken(claims: Record<string, unknown>): Promise<string>;
  /** Registers a one-shot response for the next POST /token call. */
  mockTokenEndpoint(idToken: string): void;
  /** Restores the real global fetch — call in afterEach. */
  restore(): void;
}

/**
 * Stands up a fake OIDC IdP by replacing `globalThis.fetch` with a handler for the three URLs
 * `openid-client` actually calls (discovery, jwks, token). Real RSA signing/verification runs
 * against real crypto; only the network is fake.
 *
 * This deliberately does NOT use undici's MockAgent/setGlobalDispatcher: under Jest's
 * `jest-environment-node`, test files run inside a `vm.createContext` sandbox with its own
 * `globalThis`, but Node's native `fetch` resolves its dispatcher against the *real* process realm
 * — so `setGlobalDispatcher` called from inside the sandbox silently never reaches it (verified:
 * even a bare `fetch()` call made directly in the same test file went out over the real network
 * instead of hitting the mock). Overwriting `globalThis.fetch` itself sidesteps that mismatch
 * entirely, since `openid-client`'s calls resolve the `fetch` identifier as a normal global lookup
 * in whatever realm its code is executing in.
 */
export async function setupMockIdp(): Promise<MockIdp> {
  // 2048-bit RSA, matching what jose.generateKeyPair('RS256') produced.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });

  const discoveryDocument = {
    issuer: MOCK_ISSUER,
    authorization_endpoint: `${MOCK_ISSUER}/authorize`,
    token_endpoint: `${MOCK_ISSUER}/token`,
    jwks_uri: `${MOCK_ISSUER}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  };

  let nextIdToken: string | undefined;
  const originalFetch = globalThis.fetch;

  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(MOCK_ISSUER)) {
      throw new Error(`sso-fixtures mock fetch: unexpected request to non-mocked URL ${href}`);
    }
    const { pathname } = new URL(href);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (pathname === '/.well-known/openid-configuration') return json(discoveryDocument);
    if (pathname === '/jwks') return json({ keys: [jwk] });
    if (pathname === '/token') {
      if (!nextIdToken) {
        throw new Error(
          'sso-fixtures mock fetch: no mock token response — call mockTokenEndpoint() first',
        );
      }
      const idToken = nextIdToken;
      nextIdToken = undefined;
      return json({ access_token: 'mock-access-token', token_type: 'Bearer', id_token: idToken });
    }
    throw new Error(
      `sso-fixtures mock fetch: unexpected path ${pathname} (init=${JSON.stringify(init)})`,
    );
  };
  globalThis.fetch = mockFetch as typeof fetch;

  return {
    async signIdToken(claims: Record<string, unknown>): Promise<string> {
      return signRs256(claims, privateKey);
    },
    mockTokenEndpoint(idToken: string): void {
      nextIdToken = idToken;
    },
    restore(): void {
      globalThis.fetch = originalFetch;
    },
  };
}

/** Upsert-style, matching prisma/seed.ts's conventions: seeds an SsoConnection + SsoDomain pair. */
export async function seedSsoConnection(
  prisma: PrismaClient,
  opts: {
    accountId: string;
    domain: string;
    clientId?: string;
    clientSecret?: string;
    enabled?: boolean;
  },
) {
  const clientId = opts.clientId ?? `mock-client-${randomUUID()}`;
  const clientSecret = opts.clientSecret ?? 'mock-client-secret';
  const connection = await prisma.ssoConnection.upsert({
    where: { accountId: opts.accountId },
    update: {
      issuer: MOCK_ISSUER,
      clientId,
      clientSecretEnc: encryptSecret(clientSecret),
      enabled: opts.enabled ?? true,
    },
    create: {
      accountId: opts.accountId,
      issuer: MOCK_ISSUER,
      clientId,
      clientSecretEnc: encryptSecret(clientSecret),
      enabled: opts.enabled ?? true,
    },
  });
  await prisma.ssoDomain.upsert({
    where: { domain: opts.domain },
    update: { connectionId: connection.id },
    create: { domain: opts.domain, connectionId: connection.id },
  });
  return connection;
}
