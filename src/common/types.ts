/**
 * Response shapes exactly as documented in API-CONTRACT.md.
 *
 * These are the wire types the UI binds to. Do NOT add fields the UI computes itself
 * (deg/inDeg/outDeg) or wrappers it doesn't expect (e.g. a { commits: [...] } envelope).
 */

import {
  ChangeKind,
  ChangeOp,
  Confidence,
  ContractKind,
  EdgeMethod,
  NodeType,
  Protocol,
} from './enums';

// ---------------------------------------------------------------------------
// GET /api/v1/graph
// ---------------------------------------------------------------------------

export interface TeamDto {
  id: string;
  name: string;
  /** 0=edge/BFF, 1=checkout, 2=core, 3=data/support — drives the Layered layout. */
  tier: number;
  /** Optional; UI assigns display hues if omitted. */
  hue?: number;
}

export interface NodeDto {
  id: string;
  name: string;
  /** Always present, including "external" / "unknown" for those node types. */
  team: string;
  type: NodeType;
  /** Human-readable explanation, required for unknown nodes; null otherwise. */
  note: string | null;
}

export interface EdgeDto {
  id: string;
  from: string;
  to: string;
  protocol: Protocol;
  method: EdgeMethod;
  confidence: Confidence;
  /** Endpoint (verb + path) for rest, topic name for kafka. */
  label: string;
}

export interface GraphResponse {
  repo: string;
  branch: string;
  /** ISO-8601. */
  scannedAt: string;
  teams: TeamDto[];
  nodes: NodeDto[];
  edges: EdgeDto[];
}

// ---------------------------------------------------------------------------
// GET /api/v1/contracts
// ---------------------------------------------------------------------------

export interface FieldDto {
  name: string;
  type: string;
  nullable: boolean;
  /** Optional provenance text (e.g. "added in c98d0aa"); rendered verbatim. */
  note: string | null;
}

export interface EndpointContractDto {
  id: string;
  kind: 'rest';
  service: string;
  verb: string;
  path: string;
  source: string;
  confidence: Confidence;
  method: EdgeMethod;
  unresolved: boolean;
  callers: string[];
  request: FieldDto[];
  response: FieldDto[];
}

export interface TopicContractDto {
  id: string;
  kind: 'kafka';
  topic: string;
  /** null when no producer found in scan scope. */
  producer: string | null;
  source: string;
  confidence: Confidence;
  consumers: string[];
  message: FieldDto[];
}

export interface ContractsResponse {
  endpoints: EndpointContractDto[];
  topics: TopicContractDto[];
}

export type AnyContract =
  | ({ kind: 'rest' } & EndpointContractDto)
  | ({ kind: 'kafka' } & TopicContractDto);

// ---------------------------------------------------------------------------
// GET /api/v1/commits (bare array)
// ---------------------------------------------------------------------------

export interface CommitAuthorDto {
  name: string;
  handle?: string;
  initials?: string;
  hue?: number;
}

export interface ChangeDto {
  op: ChangeOp;
  kind: ChangeKind;
  from: string;
  /** null for endpoint/topic/schema changes. */
  to: string | null;
  protocol: Protocol;
  confidence: Confidence;
  /** Links the change to a contract (chip in UI). */
  contract: string;
  /** Factual, single-sentence — never a breaking-change/severity judgment. */
  detail: string;
}

export interface CommitDto {
  sha: string;
  author: CommitAuthorDto;
  message: string;
  /** ISO timestamp. */
  when: string;
  pr: string | null;
  branch: string | null;
  changes: ChangeDto[];
}

// Re-export for convenience.
export type { ContractKind };
