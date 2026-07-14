import { Injectable } from '@nestjs/common';
import { Account } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/** sha256(key) hex — we store only the hash, so a DB dump can't be replayed. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

@Injectable()
export class IngestAuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve a bearer API key to its Account, or null if the key is unknown/revoked.
   * Entitlement (expiry) and quota are checked separately so the caller can return the
   * contract's distinct 403 / 429 (this only governs the 401 key gate).
   */
  async authenticate(key: string | undefined): Promise<Account | null> {
    if (!key) return null;
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { keyHash: hashKey(key), revokedAt: null },
      include: { account: true },
    });
    return apiKey?.account ?? null;
  }
}
