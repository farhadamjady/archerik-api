// Wire vocabulary the extractor speaks. These are the fields we read/diff;
// extra fields the extractor sends are preserved (we store raw bytes) but not typed here.

/**
 * One node of a request/response/message schema. The SAME recursive shape
 * appears at the root (endpoint request/response, kafka schema) and at every nested field — a root
 * has no `name`, a field does. The extractor emits only non-empty keys (`required` excepted — always
 * present); we store what arrives VERBATIM and never synthesize structure, because a missing or
 * uncertain node is a real signal about the source code, not a gap to paper over.
 */
export interface Schema {
  /** Wire name (post-@JsonProperty / json-tag rename). Absent on a root schema. */
  name?: string;
  /** JSON primitive (`string|integer|number|boolean|object|array|map|void`) OR a DTO type NAME. */
  type: string;
  /** May the VALUE be null. Orthogonal to `required`; omitted when false. */
  nullable?: boolean;
  /** Tri-state, always emitted by the extractor. Distinct from `nullable`. */
  required?: 'required' | 'optional' | 'unknown';
  /** Arrays only — element type name (array-of-object also HOISTS the element's fields into `nested`). */
  items?: string;
  /** Maps only — the key/value type names (values are named, not expanded). */
  key_type?: string;
  value_type?: string;
  /** Child fields (object) or hoisted element fields (array-of-object). */
  nested?: Schema[];
  /** Walk stopped here (depth limit or cycle): `{type:"<TypeName>",truncated:true}`, no `nested`. */
  truncated?: boolean;
  /** Enum members in DECLARATION order — never re-sort (omitted when absent). */
  enum?: string[];
  /** Bean-Validation metadata, open string→string map, e.g. `{maxLength:"10"}` (omitted when empty). */
  constraints?: Record<string, string>;
  /** PER-NODE detection certainty (`confirmed|likely|uncertain`) — degrades gracefully by design. */
  confidence?: string;
}

/**
 * Historical aliases — request/response/message schemas and their fields are one recursive `Schema`
 * now. Kept so call sites still read as "a field" vs. "a root type".
 */
export type SchemaField = Schema;
export type SchemaType = Schema;

export interface Endpoint {
  method: string;
  path: string;
  request?: Schema;
  response?: Schema;
  protocol: string;
  detection: string;
  confidence: string;
}

export interface OutboundDependency {
  target_name: string;
  url?: string;
  protocol: string;
  detection: string;
  confidence: string;
  resolved?: boolean;
  conditional?: boolean;
  candidate_group?: string;
}

export interface KafkaEdge {
  topic: string;
  resolved?: boolean;
  schema?: Schema;
  protocol: string;
  detection: string;
  confidence: string;
}

/** One JSON object per service — the /v1/ingest request body. */
export interface ServiceBody {
  service_id: string;
  service_name?: string;
  repository?: string;
  /**
   * Primary implementation language, if the extractor reports it (not sent by the extractor yet).
   * Canonical casing expected — "Java", "Kotlin", "Go", "TypeScript", "Python" — so it matches the
   * display strings in the read-model graph (common/types.ts NodeDto.language). Stored verbatim.
   */
  language?: string;
  endpoints: Endpoint[];
  outbound_dependencies: OutboundDependency[];
  kafka_producers: KafkaEdge[];
  kafka_consumers: KafkaEdge[];
  databases_used: unknown[];
  config_dependencies: unknown[];
}

/** Empty graph used as the baseline for a first scan. */
export const EMPTY_SERVICE: ServiceBody = {
  service_id: '',
  endpoints: [],
  outbound_dependencies: [],
  kafka_producers: [],
  kafka_consumers: [],
  databases_used: [],
  config_dependencies: [],
};

// --- Diff shapes ---

/**
 * One field-level schema change. A node is identified by its
 * **wire-name path** from the edge root (`customer.address`, `lines[].sku`; `""` = the root itself).
 * - path present on one side only → `add` / `remove` (with the node's `type`).
 * - same path, different type facet (`type`/`items`/`key_type`/`value_type`) → `change` with `from`→`to`.
 * - same path, same type, differing attribute (nullable/required/enum/constraints/confidence/truncated)
 *   → `change` with `attrs` naming what differs.
 */
export interface SchemaFieldDiff {
  op: 'add' | 'remove' | 'change';
  /** Wire-name path from the edge root; `""` denotes the root schema node. */
  path: string;
  /** Node type facet at that path (for add/remove, and context on a type change). */
  type?: string;
  /** Old → new type facet, on a type change. */
  from?: string;
  to?: string;
  /** Attribute names that differ, on an attribute-only change. */
  attrs?: string[];
}

/** A `changed` entry: the head object plus what differs and (for schema changes) field-level diff. */
export type ChangedEntry<T> = T & {
  changed: string[];
  schema_diff?: SchemaFieldDiff[];
};

export interface CategoryDiff<T> {
  added?: T[];
  removed?: T[];
  changed?: ChangedEntry<T>[];
}

export interface GraphDiff {
  endpoints: CategoryDiff<Endpoint>;
  outbound_dependencies: CategoryDiff<OutboundDependency>;
  kafka_producers: CategoryDiff<KafkaEdge>;
  kafka_consumers: CategoryDiff<KafkaEdge>;
  service_id: string;
  summary: { added: number; removed: number; changed: number };
  /** Filled by us from fleet knowledge: dependencyKey -> service_id | "external". */
  target_resolutions: Record<string, string>;
}

/** The /v1/ingest 2xx response. */
export interface IngestResponse {
  service_id: string;
  unchanged: boolean;
  first_scan: boolean;
  baseline_updated: boolean;
  diff?: GraphDiff;
  markdown: string;
}

/** The /v1/auth/validate 200 body. */
export interface Entitlement {
  plan: string;
  quota_remaining: number;
  expires_at: string;
}
