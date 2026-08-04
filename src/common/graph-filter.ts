// Narrows the account-wide graph to an optional repo/service focus. The account is always the full
// scope; these filters just subset it. Pure — no DB, no I/O — so both the graph and contracts read
// paths apply exactly the same focus.

import { EdgeDto, NodeDto, TeamDto } from './types';

export interface StoredGraphData {
  /** Organisation/system the catalog belongs to; may be absent on graphs projected before org existed. */
  org?: string | null;
  teams: TeamDto[];
  nodes: NodeDto[];
  edges: EdgeDto[];
}

export interface GraphFilter {
  repo?: string;
  service?: string;
}

export interface FilteredGraph {
  data: StoredGraphData;
  /**
   * The service ids in focus BEFORE neighbour expansion — i.e. the services the filter selects.
   * Contracts are filtered against this (a repo's own endpoints), not the expanded neighbourhood.
   */
  focusServiceIds: Set<string>;
}

/**
 * Apply a repo/service filter to an account graph. With no filter, returns everything. With a
 * filter, returns the focused services plus their immediate (1-hop) neighbours and the edges
 * between them, so the UI shows a service/repo in context rather than in isolation.
 */
export function filterGraph(data: StoredGraphData, filter: GraphFilter): FilteredGraph {
  const serviceNodes = data.nodes.filter((n) => n.type === 'service');
  const allServiceIds = new Set(serviceNodes.map((n) => n.id));

  const hasFilter = Boolean(filter.repo || filter.service);
  if (!hasFilter) {
    return { data, focusServiceIds: allServiceIds };
  }

  // Sequential AND: repo narrows to a repo's services; service narrows to one service (by id or name).
  let focus = serviceNodes;
  if (filter.repo) focus = focus.filter((n) => n.repo === filter.repo);
  if (filter.service) {
    const want = filter.service.toLowerCase();
    focus = focus.filter((n) => n.id.toLowerCase() === want || n.name.toLowerCase() === want);
  }
  const focusServiceIds = new Set(focus.map((n) => n.id));

  // 1-hop neighbourhood: any edge touching a focus service, plus the nodes on both ends.
  const keptEdges = data.edges.filter(
    (e) => focusServiceIds.has(e.from) || focusServiceIds.has(e.to),
  );
  const keptNodeIds = new Set<string>(focusServiceIds);
  for (const e of keptEdges) {
    keptNodeIds.add(e.from);
    keptNodeIds.add(e.to);
  }
  const keptNodes = data.nodes.filter((n) => keptNodeIds.has(n.id));

  // Only surface team buckets that a kept node still uses.
  const usedTeams = new Set(keptNodes.map((n) => n.team));
  const teams = data.teams.filter((t) => usedTeams.has(t.id));

  return {
    data: { org: data.org, teams, nodes: keptNodes, edges: keptEdges },
    focusServiceIds,
  };
}
