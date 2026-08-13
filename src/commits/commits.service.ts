import { Injectable } from '@nestjs/common';
import { GraphLookupService } from '../common/graph-lookup.service';
import { ChangeDto, CommitDto } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CommitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: GraphLookupService,
  ) {}

  /** Returns a BARE ARRAY of commits (newest first) — no { commits: [...] } wrapper. */
  async getCommits(
    accountId: string,
    branch: string,
    limit: number,
    at?: string,
  ): Promise<CommitDto[]> {
    const graph = await this.lookup.findGraph(accountId, branch, at);

    // Fresh account (no scans yet) → empty list with a 200, mirroring /graph.
    if (!graph) return [];

    const rows = await this.prisma.commit.findMany({
      where: { graphId: graph.id },
      orderBy: { when: 'desc' },
      take: limit,
    });

    return rows.map((row) => ({
      sha: row.commitSha,
      author: {
        name: row.authorName,
        ...(row.authorHandle ? { handle: row.authorHandle } : {}),
      },
      message: row.message,
      when: row.when.toISOString(),
      pr: row.pr,
      branch: row.branch,
      changes: row.changes as unknown as ChangeDto[],
    }));
  }
}
