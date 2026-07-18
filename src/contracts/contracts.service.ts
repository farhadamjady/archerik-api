import { Injectable } from '@nestjs/common';
import { GraphLookupService } from '../common/graph-lookup.service';
import { filterGraph, StoredGraphData } from '../common/graph-filter';
import { Protocol } from '../common/enums';
import { ContractsResponse, EndpointContractDto, TopicContractDto } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

/** Options that narrow the account-wide contracts — all optional. */
export interface ContractsQuery {
  repo?: string;
  service?: string;
  at?: string;
  protocol?: Protocol;
}

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: GraphLookupService,
  ) {}

  async getContracts(
    accountId: string,
    branch: string,
    query: ContractsQuery,
  ): Promise<ContractsResponse> {
    const graph = await this.lookup.findGraph(accountId, branch, query.at);

    // Fresh account (no scans yet) → empty contracts with a 200, mirroring /graph.
    if (!graph) return { endpoints: [], topics: [] };

    // Resolve which services are in focus (repo/service filter), so contracts match the graph view.
    const stored = graph.data as unknown as StoredGraphData;
    const { focusServiceIds } = filterGraph(stored, {
      repo: query.repo,
      service: query.service,
    });
    const focused = Boolean(query.repo || query.service);

    const rows = await this.prisma.contract.findMany({
      where: {
        graphId: graph.id,
        // 'rest' → endpoints, 'kafka' → topics. Contract.kind mirrors the protocol.
        ...(query.protocol ? { kind: query.protocol } : {}),
      },
    });

    const endpoints: EndpointContractDto[] = [];
    const topics: TopicContractDto[] = [];

    for (const row of rows) {
      if (row.kind === 'rest') {
        const ep = row.data as unknown as EndpointContractDto;
        // An endpoint belongs to one service; keep it when that service is in focus.
        if (!focused || focusServiceIds.has(ep.service)) endpoints.push(ep);
      } else if (row.kind === 'kafka') {
        const tp = row.data as unknown as TopicContractDto;
        // A topic is in focus if its producer or any consumer is a focused service.
        const inFocus =
          (tp.producer !== null && focusServiceIds.has(tp.producer)) ||
          tp.consumers.some((c) => focusServiceIds.has(c));
        if (!focused || inFocus) topics.push(tp);
      }
    }

    return { endpoints, topics };
  }
}
