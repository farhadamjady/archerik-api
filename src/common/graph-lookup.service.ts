import { Injectable, NotFoundException } from '@nestjs/common';
import { Graph } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Resolves the graph row for a (repo, branch, at?) query — shared by every read endpoint.
 * `at` pins to a specific commit SHA; otherwise the most recently scanned graph wins.
 */
@Injectable()
export class GraphLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async findGraph(repo: string, branch: string, at?: string): Promise<Graph> {
    const graph = await this.prisma.graph.findFirst({
      where: { repo, branch, ...(at ? { commitSha: at } : {}) },
      orderBy: { scannedAt: 'desc' },
    });

    if (!graph) {
      throw new NotFoundException(
        at
          ? `No graph found for ${repo}@${branch} at commit ${at}.`
          : `No graph found for ${repo}@${branch}.`,
      );
    }
    return graph;
  }
}
