import { Injectable } from '@nestjs/common';
import { GraphLookupService } from '../common/graph-lookup.service';
import { Protocol } from '../common/enums';
import {
  ContractsResponse,
  EndpointContractDto,
  TopicContractDto,
} from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: GraphLookupService,
  ) {}

  async getContracts(
    repo: string,
    branch: string,
    at?: string,
    protocol?: Protocol,
  ): Promise<ContractsResponse> {
    const graph = await this.lookup.findGraph(repo, branch, at);

    const rows = await this.prisma.contract.findMany({
      where: {
        graphId: graph.id,
        // 'rest' → endpoints, 'kafka' → topics. Contract.kind mirrors the protocol.
        ...(protocol ? { kind: protocol } : {}),
      },
    });

    const endpoints: EndpointContractDto[] = [];
    const topics: TopicContractDto[] = [];

    for (const row of rows) {
      if (row.kind === 'rest') {
        endpoints.push(row.data as unknown as EndpointContractDto);
      } else if (row.kind === 'kafka') {
        topics.push(row.data as unknown as TopicContractDto);
      }
    }

    return { endpoints, topics };
  }
}
