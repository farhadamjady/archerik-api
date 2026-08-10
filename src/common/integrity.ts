/**
 * Referential-integrity + enum validation for the wire payloads.
 *
 * This encodes exactly what the UI enforces (unknown enum value or an edge whose from/to doesn't
 * match a node id makes the whole load fail). Running it at seed time — and re-running it against
 * live HTTP responses in the e2e test — guarantees the backend never ships the UI a payload that
 * trips its strict validation.
 */

import { CHANGE_KIND, CHANGE_OP, CONFIDENCE, NODE_TYPE, PROTOCOL } from './enums';
import { CommitDto, ContractsResponse, GraphResponse } from './types';

const has = <T>(set: readonly T[], value: unknown): boolean => set.includes(value as T);

export function validateGraph(graph: GraphResponse): string[] {
  const errors: string[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const teamIds = new Set(graph.teams.map((t) => t.id));

  for (const node of graph.nodes) {
    if (!has(NODE_TYPE, node.type)) errors.push(`node ${node.id}: bad type "${node.type}"`);
    if (!node.team) errors.push(`node ${node.id}: missing team`);
    else if (!teamIds.has(node.team))
      errors.push(`node ${node.id}: team "${node.team}" not in teams[]`);
    // An unknown node must explain why it stayed unresolved — the "never hide uncertainty"
    // invariant (CLAUDE.md §6), enforced here so an unexplained node can't reach the UI.
    if (node.type === 'unknown' && !node.note) {
      errors.push(`node ${node.id}: unknown node must carry a note`);
    }
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from))
      errors.push(`edge ${edge.id}: from "${edge.from}" is not a node id`);
    if (!nodeIds.has(edge.to)) errors.push(`edge ${edge.id}: to "${edge.to}" is not a node id`);
    if (!has(PROTOCOL, edge.protocol))
      errors.push(`edge ${edge.id}: bad protocol "${edge.protocol}"`);
    // `method` is intentionally NOT validated — it's a free display string the UI never checks.
    if (!has(CONFIDENCE, edge.confidence)) {
      errors.push(`edge ${edge.id}: bad confidence "${edge.confidence}"`);
    }
  }

  return errors;
}

export function validateContracts(contracts: ContractsResponse): string[] {
  const errors: string[] = [];

  for (const ep of contracts.endpoints) {
    if (ep.kind !== 'rest') errors.push(`endpoint ${ep.id}: kind must be "rest"`);
    if (!has(CONFIDENCE, ep.confidence)) errors.push(`endpoint ${ep.id}: bad confidence`);
    // `method` intentionally not validated (free display string, see validateGraph).
    if (typeof ep.unresolved !== 'boolean')
      errors.push(`endpoint ${ep.id}: unresolved must be boolean`);
  }

  for (const tp of contracts.topics) {
    if (tp.kind !== 'kafka') errors.push(`topic ${tp.id}: kind must be "kafka"`);
    if (!has(CONFIDENCE, tp.confidence)) errors.push(`topic ${tp.id}: bad confidence`);
    // Invariant: no producer found → uncertain.
    if (tp.producer === null && tp.confidence !== 'uncertain') {
      errors.push(`topic ${tp.id}: producer is null but confidence is not "uncertain"`);
    }
  }

  return errors;
}

export function validateCommits(commits: CommitDto[]): string[] {
  const errors: string[] = [];
  for (const c of commits) {
    for (const [i, ch] of c.changes.entries()) {
      const where = `commit ${c.sha} change[${i}]`;
      if (!has(CHANGE_OP, ch.op)) errors.push(`${where}: bad op "${ch.op}"`);
      if (!has(CHANGE_KIND, ch.kind)) errors.push(`${where}: bad kind "${ch.kind}"`);
      if (!has(PROTOCOL, ch.protocol)) errors.push(`${where}: bad protocol "${ch.protocol}"`);
      if (!has(CONFIDENCE, ch.confidence))
        errors.push(`${where}: bad confidence "${ch.confidence}"`);
    }
  }
  return errors;
}
