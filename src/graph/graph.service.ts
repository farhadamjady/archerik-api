import { Injectable } from '@nestjs/common';
import { GraphLookupService } from '../common/graph-lookup.service';
import { filterGraph, StoredGraphData } from '../common/graph-filter';
import { GraphResponse } from '../common/types';

/** Options that narrow the account-wide graph — all optional. */
export interface GraphQuery {
  repo?: string;
  service?: string;
  at?: string;
}

@Injectable()
export class GraphService {
  constructor(private readonly lookup: GraphLookupService) {}

  async getGraph(accountId: string, branch: string, query: GraphQuery): Promise<GraphResponse> {
    const graph = await this.lookup.findGraph(accountId, branch, query.at);

    // Fresh account (no scans yet) → empty graph with a 200, so the UI can show an empty state.
    if (!graph) {
      return {
        org: null,
        repo: query.repo ?? null,
        branch,
        scannedAt: null,
        teams: [],
        nodes: [],
        edges: [],
      };
    }

    const stored = graph.data as unknown as StoredGraphData;

    // Account is the scope; repo/service just subset it (whole account when neither is set).
    const { data } = filterGraph(stored, { repo: query.repo, service: query.service });

    // Flat envelope — no `meta` wrapper, no deg/inDeg/outDeg (the UI computes those itself).
    return {
      org: data.org ?? null,
      repo: query.repo ?? null,
      branch: graph.branch,
      scannedAt: graph.scannedAt.toISOString(),
      teams: data.teams,
      nodes: data.nodes,
      edges: data.edges,
    };
  }
}
