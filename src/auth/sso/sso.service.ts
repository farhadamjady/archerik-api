import { Injectable, UnauthorizedException } from '@nestjs/common';
import { SsoConnection } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth.service';
import { SsoClientRegistry } from './sso-client-registry.service';
import { SsoIdTokenClaims, SsoStartResponse } from './sso.types';

function extractDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
  return slug || 'user';
}

@Injectable()
export class SsoService {
  private readonly stateTtlMinutes = Number(process.env.SSO_STATE_TTL_MINUTES ?? 10);
  // Fixed across every tenant — the connection is resolved from `state` at the callback, not the
  // URL, so every customer's IdP admin registers this exact same redirect_uri. Unlike
  // SSO_ENCRYPTION_KEY, a missing BACKEND_PUBLIC_URL isn't a security hole, so it falls back like
  // APP_URL/PORT do elsewhere in this module rather than failing closed.
  private readonly redirectUri = `${process.env.BACKEND_PUBLIC_URL ?? 'http://localhost:3000'}/api/v1/auth/sso/callback`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SsoClientRegistry,
    private readonly authService: AuthService,
  ) {}

  /**
   * Resolves the account's SSO connection by email domain and starts an OIDC authorization
   * request. Returns the same `{ sso: false }` shape whether the domain has no SSO connection or a
   * disabled one — a bulk domain-probing attacker can't distinguish the two.
   */
  async start(email: string): Promise<SsoStartResponse> {
    const domain = extractDomain(email);
    const ssoDomain = await this.prisma.ssoDomain.findUnique({
      where: { domain },
      include: { connection: true },
    });
    if (!ssoDomain || !ssoDomain.connection.enabled) {
      return { sso: false };
    }
    const { connection } = ssoDomain;

    const { url, state, nonce, codeVerifier } = await this.registry.buildAuthorizationRequest(
      connection,
      this.redirectUri,
    );

    // Opportunistic cleanup — no cron needed, this route is hit often enough on its own.
    await this.prisma.ssoAuthRequest.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await this.prisma.ssoAuthRequest.create({
      data: {
        state,
        connectionId: connection.id,
        nonce,
        codeVerifier,
        expiresAt: new Date(Date.now() + this.stateTtlMinutes * 60_000),
      },
    });

    return { sso: true, redirectUrl: url };
  }

  /**
   * Completes the OIDC round trip and mints a session. Every failure path (unknown/expired/reused
   * state, IdP `error=`, exchange failure, unverified email, cross-account collision) throws — the
   * controller turns that into a generic error page, never a silent logged-in-anyway result.
   */
  async callback(query: Record<string, string | undefined>): Promise<string> {
    const state = query.state;
    if (!state) throw new UnauthorizedException('Missing state');

    const authRequest = await this.prisma.ssoAuthRequest.findUnique({
      where: { state },
      include: { connection: true },
    });
    // Single-use: delete on first read, before any awaited work, closing replay of a captured
    // state+code pair independent of the IdP's own single-use code guarantee.
    if (authRequest) {
      await this.prisma.ssoAuthRequest.delete({ where: { state } }).catch(() => undefined);
    }
    if (!authRequest || authRequest.expiresAt <= new Date()) {
      throw new UnauthorizedException('Unknown or expired SSO request');
    }

    const callbackUrl = new URL(this.redirectUri);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) callbackUrl.searchParams.set(key, value);
    }

    const claims = await this.registry.exchangeCode(authRequest.connection, {
      callbackUrl,
      state: authRequest.state,
      nonce: authRequest.nonce,
      codeVerifier: authRequest.codeVerifier,
    });

    if (!claims.email) throw new UnauthorizedException('IdP did not return an email claim');
    if (claims.email_verified === false) {
      throw new UnauthorizedException('IdP reports this email as unverified');
    }

    const user = await this.resolveUser(authRequest.connection, claims);
    return this.authService.createSession(user.id);
  }

  private async resolveUser(connection: SsoConnection, claims: SsoIdTokenClaims) {
    const email = claims.email!;
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      // User.email is globally unique, so a match under a *different* account means another
      // account's IdP just vouched for an identity it doesn't own — reject, never reassign.
      if (existing.accountId !== connection.accountId) {
        throw new UnauthorizedException('Email is registered under a different account');
      }
      // Same account: the admin who configured this IdP made it authoritative for the domain, so
      // an IdP-verified email outranks a self-service password signup — log in via SSO either way.
      return existing;
    }

    const handle = await this.uniqueHandle(claims, email);
    return this.prisma.user.create({
      data: {
        accountId: connection.accountId,
        email,
        // Random, never used to log in — this account is only reachable via SSO.
        passwordHash: await bcrypt.hash(randomBytes(16).toString('hex'), 10),
        name: claims.name ?? email.slice(0, email.indexOf('@')),
        handle,
        team: 'unassigned',
      },
    });
  }

  private async uniqueHandle(claims: SsoIdTokenClaims, email: string): Promise<string> {
    const base = slugify(claims.name ?? email.slice(0, email.indexOf('@')));
    let handle = base;
    let suffix = 1;
    // handle has no unique constraint, but keep collisions rare/readable rather than allowing dupes.
    while (await this.prisma.user.findFirst({ where: { handle } })) {
      suffix += 1;
      handle = `${base}${suffix}`;
    }
    return handle;
  }
}
