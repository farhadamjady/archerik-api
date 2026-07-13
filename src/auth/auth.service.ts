import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, LoginResponse } from './auth.types';

@Injectable()
export class AuthService {
  private readonly ttlHours = Number(process.env.SESSION_TTL_HOURS ?? 168); // 7 days

  constructor(private readonly prisma: PrismaService) {}

  /** Opaque tokens are random; only their sha256 is stored, so a DB dump can't be replayed. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + this.ttlHours * 3600 * 1000);
    await this.prisma.session.create({
      data: { userId, tokenHash: this.hashToken(token), expiresAt },
    });
    return token;
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Same error whether the email is unknown or the password is wrong — no account enumeration.
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const token = await this.createSession(user.id);
    return { token, user: { name: user.name, handle: user.handle, team: user.team } };
  }

  /** Resolves a bearer token to a live user, or null if missing/expired/revoked. */
  async validateToken(token: string | undefined): Promise<AuthUser | null> {
    if (!token) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
    const { user } = session;
    return { id: user.id, email: user.email, name: user.name, handle: user.handle, team: user.team };
  }

  /** Best-effort revoke — safe to call with an unknown/expired token. */
  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.session.updateMany({
      where: { tokenHash: this.hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * SSO stub: stands in for the IdP dance. Upserts a demo SSO user and mints a session so the
   * browser lands back on the app already authenticated. Replace with a real OIDC flow later.
   */
  async ssoLogin(): Promise<string> {
    const email = process.env.SSO_DEMO_EMAIL ?? 'sso@acme.com';
    const user = await this.prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        // Random hash — this account is only reachable via SSO, never password login.
        passwordHash: await bcrypt.hash(randomBytes(16).toString('hex'), 10),
        name: 'SSO User',
        handle: 'sso',
        team: 'platform',
      },
    });
    return this.createSession(user.id);
  }
}
