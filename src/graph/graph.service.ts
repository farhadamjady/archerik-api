import { Injectable } from '@nestjs/common';
import { GraphLookupService } from '../common/graph-lookup.service';
import { EdgeDto, GraphResponse, NodeDto, TeamDto } from '../common/types';

interface StoredGraphData {
  teams: TeamDto[];
  nodes: NodeDto[];
  edges: EdgeDto[];
}

@Injectable()
export class GraphService {
  constructor(private readonly lookup: GraphLookupService) {}

  async getGraph(repo: string, branch: string, at?: string): Promise<GraphResponse> {
    const graph = await this.lookup.findGraph(repo, branch, at);
    const data = graph.data as unknown as StoredGraphData;

    // Flat envelope per API-CONTRACT.md — no `meta`, no deg/inDeg/outDeg (UI computes those).
    return {
      repo: graph.repo,
      branch: graph.branch,
      scannedAt: graph.scannedAt.toISOString(),
      teams: data.teams,
      nodes: data.nodes,
      edges: data.edges,
    };
  }
}
