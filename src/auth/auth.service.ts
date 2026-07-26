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

  /** Mints an opaque, DB-backed session for a user — shared by password login and SsoService. */
  async createSession(userId: string): Promise<string> {
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
    return {
      id: user.id,
      accountId: user.accountId,
      email: user.email,
      name: user.name,
      handle: user.handle,
      team: user.team,
    };
  }

  /** Best-effort revoke — safe to call with an unknown/expired token. */
  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.session.updateMany({
      where: { tokenHash: this.hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
