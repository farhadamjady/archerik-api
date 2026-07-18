import { Injectable } from '@nestjs/common';
import { Graph } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Resolves the account-wide graph row for an (account, branch, at?) query — shared by every read
 * endpoint. The account comes from the session, not the query. `at` pins to a specific commit SHA;
 * otherwise the most recently scanned graph wins.
 *
 * Returns `null` when the account has no matching graph (e.g. a brand-new account before its first
 * scan). Read endpoints treat that as an empty result (200), not an error — the UI's first call
 * after login is `GET /graph`, so a fresh account should render a "no scans yet" empty state.
 */
@Injectable()
export class GraphLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async findGraph(accountId: string, branch: string, at?: string): Promise<Graph | null> {
    return this.prisma.graph.findFirst({
      where: { accountId, branch, ...(at ? { commitSha: at } : {}) },
      orderBy: { scannedAt: 'desc' },
    });
  }
}
