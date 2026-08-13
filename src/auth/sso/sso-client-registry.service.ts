import { Injectable } from '@nestjs/common';
import type { Configuration } from 'openid-client';
import type { SsoConnection } from '@prisma/client';
import { loadOidcClient } from './oidc-client';
import { decryptSecret } from './sso-crypto';
import { SsoIdTokenClaims } from './sso.types';

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h — no Redis in this stack, so a per-process cache;
// worst case after a restart is one extra discovery round trip, not a correctness issue.

interface CacheEntry {
  configuration: Configuration;
  cachedAt: number;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/**
 * Per-connection OIDC discovery + the authorize-URL / code-exchange calls, wrapping `openid-client`
 * so the rest of the SSO flow never touches the library directly. All iss/aud/exp/signature/nonce
 * validation is delegated to `openid-client`'s real JWKS-based checks — never hand-rolled here.
 */
@Injectable()
export class SsoClientRegistry {
  private readonly cache = new Map<string, CacheEntry>();

  private async getConfiguration(connection: SsoConnection): Promise<Configuration> {
    const cached = this.cache.get(connection.id);
    if (cached && Date.now() - cached.cachedAt < DISCOVERY_TTL_MS) {
      return cached.configuration;
    }
    const client = await loadOidcClient();
    const clientSecret = decryptSecret(Buffer.from(connection.clientSecretEnc));
    const configuration = await client.discovery(
      new URL(connection.issuer),
      connection.clientId,
      clientSecret,
    );
    this.cache.set(connection.id, { configuration, cachedAt: Date.now() });
    return configuration;
  }

  /** Invalidates the cached discovery document — call after a connection's issuer/secret changes. */
  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  async buildAuthorizationRequest(
    connection: SsoConnection,
    redirectUri: string,
  ): Promise<AuthorizationRequest> {
    const client = await loadOidcClient();
    const configuration = await this.getConfiguration(connection);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return { url: url.toString(), state, nonce, codeVerifier };
  }

  async exchangeCode(
    connection: SsoConnection,
    params: { callbackUrl: URL; state: string; nonce: string; codeVerifier: string },
  ): Promise<SsoIdTokenClaims> {
    const client = await loadOidcClient();
    const configuration = await this.getConfiguration(connection);
    const tokens = await client.authorizationCodeGrant(configuration, params.callbackUrl, {
      expectedState: params.state,
      expectedNonce: params.nonce,
      pkceCodeVerifier: params.codeVerifier,
    });
    const claims = tokens.claims();
    if (!claims) {
      throw new Error('IdP token response did not include an ID token');
    }
    return claims as SsoIdTokenClaims;
  }
}
