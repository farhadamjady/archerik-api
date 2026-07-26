import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type * as Jose from 'jose';
import { encryptSecret } from '../src/auth/sso/sso-crypto';

// `jose` (like `openid-client`, same maintainer) ships ESM-only, but ts-jest compiles this file to
// CommonJS — a static `import` downlevels to `require()`, which throws on an ESM-only package. Same
// fix as src/auth/sso/oidc-client.ts: hide the import behind `new Function` so it stays a genuine
// native `import()` at runtime instead of being rewritten.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<typeof Jose>;
const loadJose = (() => {
  let modulePromise: Promise<typeof Jose> | undefined;
  return () => (modulePromise ??= dynamicImport('jose'));
})();

export const MOCK_ISSUER = 'https://mock-idp.test';
const KID = 'test-key';

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
  const jose = await loadJose();
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(publicKey);
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
      return new jose.SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuedAt()
        .setIssuer(MOCK_ISSUER)
        .setExpirationTime('5m')
        .sign(privateKey);
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
