// Wire vocabulary the extractor speaks (BACKEND_CONTRACT.md §4). Source of truth is the Go
// `internal/model` package; these are the fields we read/diff. Extra fields are preserved (we store
// raw bytes) but not typed here.

/** A schema field in a request/response/message DTO. Depth-2 walk; deeper => truncated:true. */
export interface SchemaField {
  name: string;
  type: string;
  /** Tri-state, always emitted. Distinct from `nullable`. */
  required?: 'required' | 'optional' | 'unknown';
  nullable?: boolean;
  items?: string;
  truncated?: boolean;
  nested?: SchemaField[];
}

export interface SchemaType {
  type: string;
  required?: string;
  nested?: SchemaField[];
}

export interface Endpoint {
  method: string;
  path: string;
  request?: SchemaType;
  response?: SchemaType;
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
  schema?: SchemaType;
  protocol: string;
  detection: string;
  confidence: string;
}

/** One JSON object per service — the /v1/ingest request body. */
export interface ServiceBody {
  service_id: string;
  service_name?: string;
  repository?: string;
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

// --- Diff shapes (BACKEND_CONTRACT.md §5) ---

export interface SchemaFieldDiff {
  op: 'add' | 'remove' | 'change';
  name: string;
  type?: string;
  from?: string;
  to?: string;
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

/** The /v1/ingest 2xx response (BACKEND_CONTRACT.md §3). */
export interface IngestResponse {
  service_id: string;
  unchanged: boolean;
  first_scan: boolean;
  baseline_updated: boolean;
  diff?: GraphDiff;
  markdown: string;
}

/** The /v1/auth/validate 200 body (BACKEND_CONTRACT.md §2). */
export interface Entitlement {
  plan: string;
  quota_remaining: number;
  expires_at: string;
}
