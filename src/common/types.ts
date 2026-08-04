/**
 * Response shapes exactly as documented in API-CONTRACT.md.
 *
 * These are the wire types the UI binds to. Do NOT add fields the UI computes itself
 * (deg/inDeg/outDeg) or wrappers it doesn't expect (e.g. a { commits: [...] } envelope).
 */

import { ChangeKind, ChangeOp, Confidence, ContractKind, NodeType, Protocol } from './enums';

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
  /** Human-readable explanation, required for unknown AND deployment nodes; null otherwise. */
  note: string | null;
  /** Primary implementation language, canonical casing (e.g. "Java", "Kotlin"); null when not scanned/reported. */
  language?: string | null;
  /**
   * Repository slug — the catalog's primary label for a service box and the `org/<repo>` header
   * (e.g. "payment-service"). Sent for service/external nodes; null for unknown/deployment. This is
   * the per-service repo slug, NOT the owning system/org (that is GraphResponse.org).
   */
  repo?: string | null;
  /**
   * The host a caller uses to reach this node: the service slug for internal services, the real
   * third-party host for externals (e.g. "api.stripe.com"), the proven deploy host for deployment
   * nodes. null when genuinely unknown (unresolved runtime target).
   */
  host?: string | null;
}

export interface EdgeDto {
  id: string;
  from: string;
  to: string;
  protocol: Protocol;
  /** Free display string — NOT validated by the UI (FeignClient|WebClient|RestTemplate|route|@KafkaListener|HttpExchange|CloudStream…). */
  method: string;
  confidence: Confidence;
  /** Endpoint (verb + path) for rest, topic name for kafka. */
  label: string;
}

export interface GraphResponse {
  /** Organisation/system the catalog belongs to (sidebar "organisation"); null when it can't be derived. */
  org: string | null;
  /** The repo filter that was applied, or null when the whole account graph is returned. */
  repo: string | null;
  branch: string;
  /** ISO-8601, or null when the account has no scans yet (empty graph). */
  scannedAt: string | null;
  teams: TeamDto[];
  nodes: NodeDto[];
  edges: EdgeDto[];
}

// ---------------------------------------------------------------------------
// GET /api/v1/contracts
// ---------------------------------------------------------------------------

/**
 * One node of a request/response/message schema. Recursive: a field whose type is a DTO carries its
 * children in `nested`, up to the extractor's truncation boundary. The wire shape mirrors the
 * extractor's `Schema` (BACKEND_CONTRACT.md §4a) — the backend passes it through VERBATIM (never
 * flattens, never synthesizes), so the UI renders nested tables, enum/constraint chips, and
 * collapsed-truncation nodes directly. Only non-empty keys are emitted (`name`/`type`/`nullable`
 * always present; `note` kept for provenance).
 */
export interface FieldDto {
  name: string;
  /** JSON primitive (`string|integer|number|boolean|object|array|map|void`) or a DTO type NAME. */
  type: string;
  /** May the value be null (distinct from `required`). */
  nullable: boolean;
  /** Optional provenance text (e.g. "added in c98d0aa"); rendered verbatim. */
  note: string | null;
  /** Tri-state presence, distinct from `nullable`. */
  required?: 'required' | 'optional' | 'unknown';
  /** Arrays: element type name (array-of-object also hoists the element's fields into `nested`). */
  items?: string;
  /** Maps: key/value type names (values are named, not expanded). */
  key_type?: string;
  value_type?: string;
  /** Walk stopped here — render as "<type> (collapsed)", never as empty. */
  truncated?: boolean;
  /** Enum members in declaration order — do NOT re-sort. Missing ⇒ "not captured", not "no members". */
  enum?: string[];
  /** Validation metadata (string→string, e.g. {"maxLength":"10"}). Tolerate unknown keys. */
  constraints?: Record<string, string>;
  /** Per-node detection certainty; may degrade below the edge's confidence for an opaque subtree. */
  confidence?: Confidence;
  /** Child fields (object) or hoisted element fields (array-of-object). */
  nested?: FieldDto[];
}

export interface EndpointContractDto {
  id: string;
  kind: 'rest';
  service: string;
  verb: string;
  path: string;
  source: string;
  confidence: Confidence;
  /** Free display string — not validated by the UI (see EdgeDto.method). */
  method: string;
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
  ({ kind: 'rest' } & EndpointContractDto) | ({ kind: 'kafka' } & TopicContractDto);

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
