// Projects the fleet's per-service baselines into the read model the UI consumes
// (GraphResponse + ContractsResponse). Pure and deterministic — no DB, no I/O. The ingest
// service gathers all baselines for a (repo, branch), calls this, and persists the result as a
// single current-head Graph row (+ Contract rows). Diffs/commits are NOT produced here: the
// extractor doesn't send commit metadata yet, so /api/v1/commits stays empty by design.

import { CONFIDENCE, PROTOCOL, Confidence, EdgeMethod, Protocol } from '../common/enums';
import {
  EdgeDto,
  EndpointContractDto,
  FieldDto,
  NodeDto,
  TeamDto,
  TopicContractDto,
} from '../common/types';
import { KafkaEdge, OutboundDependency, SchemaField, SchemaType, ServiceBody } from './model';
import { externalKey, resolveTarget } from './resolve';

/** One service's baseline, ready to project (body already parsed from stored bytes). */
export interface ParsedService {
  serviceId: string;
  serviceName: string | null;
  language: string | null;
  /** Owning repo (from the Service body); null when the extractor didn't report one. */
  repo: string | null;
  body: ServiceBody;
}

export interface ProjectedGraph {
  /** Organisation the catalog belongs to (single system → its org segment, else null). */
  org: string | null;
  teams: TeamDto[];
  nodes: NodeDto[];
  edges: EdgeDto[];
}

export interface ProjectedContracts {
  endpoints: EndpointContractDto[];
  topics: TopicContractDto[];
}

// Non-service node buckets — the extractor doesn't send team assignments, so every scanned service
// lands in one team and off-graph targets get their own buckets (mirrors the read DTO contract).
const TEAM_SERVICE = 'unassigned';
const TEAM_EXTERNAL = 'external';
const TEAM_UNKNOWN = 'unknown';

const TEAM_DEFS: Record<string, TeamDto> = {
  [TEAM_SERVICE]: { id: TEAM_SERVICE, name: 'Services', tier: 2, hue: 210 },
  [TEAM_EXTERNAL]: { id: TEAM_EXTERNAL, name: 'External', tier: 3, hue: 0 },
  [TEAM_UNKNOWN]: { id: TEAM_UNKNOWN, name: 'Unknown', tier: 3, hue: 0 },
};

const asConfidence = (v: string): Confidence =>
  (CONFIDENCE as readonly string[]).includes(v) ? (v as Confidence) : 'uncertain';

// The extractor emits detection lowercase (`feign`, `webclient`, `resttemplate`, `router`); these are
// the canonical display strings we map them onto. `method` is a FREE wire string (the UI never
// validates it), so an unrecognized detection is passed through verbatim rather than coerced.
const DETECTION_METHOD: Record<string, EdgeMethod | string> = {
  feign: 'FeignClient',
  feignclient: 'FeignClient',
  webclient: 'WebClient',
  resttemplate: 'RestTemplate',
  router: 'route',
  route: 'route',
  kafkatemplate: 'KafkaTemplate',
  kafkalistener: '@KafkaListener',
  '@kafkalistener': '@KafkaListener',
  httpexchange: 'HttpExchange',
  cloudstream: 'CloudStream',
};

const asMethod = (v: string, fallback: string): string => {
  const d = (v ?? '').toLowerCase();
  if (DETECTION_METHOD[d]) return DETECTION_METHOD[d];
  return v || fallback; // pass an unrecognized detection through verbatim
};

// `protocol` IS strictly validated by the UI against PROTOCOL. Normalize the extractor's transport
// string; http(s) → rest; anything unrecognized falls back (rest for REST callers, kafka handled
// separately). An empty/undetermined transport is honestly recorded as `unknown` when no fallback fits.
const asProtocol = (v: string, fallback: Protocol): Protocol => {
  const p = (v ?? '').toLowerCase();
  if (p === 'http' || p === 'https') return 'rest';
  return (PROTOCOL as readonly string[]).includes(p) ? (p as Protocol) : fallback;
};

/**
 * The logical system (repo group) a service belongs to: its `repository` with the trailing
 * `/<serviceId>` service segment removed. The extractor emits `repository` PER SERVICE
 * (`github.com/<system>/<service>`), so the system is the parent path — that is what groups a fleet
 * and what name->service resolution must be scoped to. Falls back to the raw repo when it doesn't
 * end in the serviceId (e.g. a repo-root-style `acme/shop-platform`). Empty when no repo reported.
 */
export function systemOf(repo: string | null, serviceId: string): string {
  if (!repo) return '';
  const suffix = `/${serviceId}`;
  return repo.endsWith(suffix) ? repo.slice(0, -suffix.length) : repo;
}

/**
 * Globally-unique node id for a service: `<system>/<serviceId>`. For per-service repositories this
 * reconstructs `repository`; crucially it disambiguates the same `serviceId` across systems (every
 * repo has an `order-service`), so three unrelated `order-service`s stay three nodes. Bare
 * `serviceId` only when no repository was reported.
 */
export function nodeIdOf(repo: string | null, serviceId: string): string {
  const system = systemOf(repo, serviceId);
  return system ? `${system}/${serviceId}` : serviceId;
}

/**
 * The per-service repository SLUG — the catalog's primary service-box label (`payment-service`). The
 * last path segment of the reported `repository` (`github.com/acme/payment-service` → `payment-service`),
 * falling back to the serviceId when no repository was reported. Distinct from the owning system/org.
 */
export function repoSlugOf(repo: string | null, serviceId: string): string {
  if (!repo) return serviceId;
  const parts = repo.split('/').filter(Boolean);
  return parts[parts.length - 1] || serviceId;
}

/**
 * The organisation segment of a system path: drop a leading VCS-host label (`github.com`, `gitlab.com`)
 * then take the first path segment (`github.com/acme` → `acme`, `acme/shop-platform` → `acme`). Empty
 * when the system has no path.
 */
export function orgOf(system: string): string {
  const parts = system.split('/').filter(Boolean);
  if (parts.length > 1 && parts[0].includes('.')) parts.shift();
  return parts[0] ?? '';
}

/**
 * The catalog's organisation: the single org shared by every scanned service, or null when the
 * account spans multiple orgs (the UI then falls back to its own derivation). Best-effort and
 * honest — we never pick an arbitrary one.
 */
export function orgFor(services: ParsedService[]): string | null {
  const orgs = new Set<string>();
  for (const svc of services) {
    const org = orgOf(systemOf(svc.repo, svc.serviceId));
    if (org) orgs.add(org);
  }
  return orgs.size === 1 ? [...orgs][0] : null;
}

/**
 * One extractor `Schema` node -> a UI `FieldDto`, VERBATIM and recursive: nesting, array-of-object
 * hoisting (`items` + `nested`), maps (`key_type`/`value_type`), truncation, enums, constraints, and
 * per-node confidence all pass through untouched. We do NOT flatten to a display string or collapse
 * `required` into `nullable` — the UI owns rendering (`array<Line>` chips, collapsed-truncation
 * nodes, enum/constraint chips). Field order is preserved (the extractor already sorts by wire name).
 * `nullable` keeps the explicit flag, falling back to the tri-state (`optional` ⇒ may be absent/null).
 */
function toFieldDto(f: SchemaField): FieldDto {
  const dto: FieldDto = {
    name: f.name ?? '',
    type: f.type,
    nullable: f.nullable ?? f.required === 'optional',
    note: null,
  };
  if (f.required) dto.required = f.required;
  if (f.items) dto.items = f.items;
  if (f.key_type) dto.key_type = f.key_type;
  if (f.value_type) dto.value_type = f.value_type;
  if (f.truncated) dto.truncated = true;
  if (f.enum) dto.enum = f.enum;
  if (f.constraints) dto.constraints = f.constraints;
  if (f.confidence) dto.confidence = asConfidence(f.confidence);
  if (f.nested) dto.nested = f.nested.map(toFieldDto);
  return dto;
}

/** A root schema's child fields -> UI FieldDto[] (empty when the body was void or untyped). */
function toFields(st?: SchemaType): FieldDto[] {
  return st?.nested ? st.nested.map(toFieldDto) : [];
}

/** REST detection -> a human-readable contract source string (types.ts source is free text).
 *  Detection arrives lowercase from the extractor (feign/webclient/resttemplate for callers,
 *  annotation/router for served endpoints). */
function restSource(detection: string): string {
  switch ((detection ?? '').toLowerCase()) {
    case 'feign':
    case 'feignclient':
      return 'in-code DTO (Feign)';
    case 'webclient':
      return 'in-code DTO (WebClient)';
    case 'resttemplate':
      return 'in-code (RestTemplate)';
    case 'router':
    case 'route':
      return 'OpenAPI spec';
    case 'annotation':
      return 'in-code (annotation)';
    default:
      return `in-code (${detection})`;
  }
}

/** Classify a non-internal target: unresolved (runtime/legacy) -> unknown, otherwise external.
 *  Keyed by the normalized target identity so every URL-shape/port/case variant of the same target
 *  lands on ONE node (see resolve.ts externalKey), never a node-per-URL-string. `nodeIds` is the set
 *  of scanned service node ids (system-qualified): an off-graph target must never REUSE one, or the
 *  edge would silently attach to a real service. In practice a plain external key can't collide with
 *  a qualified `<system>/<serviceId>` id, so this guard is defensive and rarely fires. */
function offGraphNode(dep: OutboundDependency, nodeIds: Set<string>): NodeDto {
  const key = externalKey(dep);
  const id = nodeIds.has(key) ? `unresolved:${key}` : key;
  // `key` is the bucket identity: the lowercased host when the target was host-shaped, else a bare
  // name (or `unknown-target` for a runtime host with no name). It IS the reachable host for anything
  // but the nameless runtime case.
  const host = key === 'unknown-target' ? null : key;
  if (dep.resolved === false) {
    return {
      id,
      name: key,
      team: TEAM_UNKNOWN,
      type: 'unknown',
      note: dep.url
        ? 'Target host resolved from a variable at runtime — service identity is not known.'
        : 'Call target could not be matched to a scanned service in scan scope.',
      language: null,
      // An unresolved target has no owning repo; keep the host when we actually know it.
      repo: null,
      host,
    };
  }
  // External third party: the host is the real hostname; repo mirrors it (no friendlier slug exists).
  return {
    id,
    name: key,
    team: TEAM_EXTERNAL,
    type: 'external',
    note: null,
    language: null,
    repo: host,
    host,
  };
}

/**
 * Build the read model from every service baseline the account owns (across all systems/repos).
 * Node identity is system-qualified (`<system>/<serviceId>`), so the same `serviceId` in different
 * systems stays distinct. The fleet registry is built PER SYSTEM: name->service resolution is scoped
 * to the emitting service's own system (the parent of its per-service `repository`), so a call
 * resolves to a same-system service and never to an unrelated system's same-named one — it falls
 * back to external. Resolution runs here on every reproject against the whole current fleet, so a
 * service scanned before its callee still links once both baselines exist.
 */
export function projectReadModel(services: ParsedService[]): {
  graph: ProjectedGraph;
  contracts: ProjectedContracts;
} {
  const nodes = new Map<string, NodeDto>();
  const edges: EdgeDto[] = [];
  const endpoints: EndpointContractDto[] = [];

  // Stable qualified id per service, reused as node id / edge endpoint / contract service key.
  const idOf = (svc: ParsedService): string => nodeIdOf(svc.repo, svc.serviceId);
  const nodeIds = new Set(services.map(idOf));

  // Per-system fleet registry: system -> (lowercased matchable name -> that service's node id).
  const registryBySystem = new Map<string, Map<string, string>>();
  for (const svc of services) {
    const system = systemOf(svc.repo, svc.serviceId);
    let reg = registryBySystem.get(system);
    if (!reg) registryBySystem.set(system, (reg = new Map<string, string>()));
    reg.set(svc.serviceId.toLowerCase(), idOf(svc));
    if (svc.serviceName) reg.set(svc.serviceName.toLowerCase(), idOf(svc));
  }
  const EMPTY_REGISTRY = new Map<string, string>();
  const knownFor = (svc: ParsedService): Map<string, string> =>
    registryBySystem.get(systemOf(svc.repo, svc.serviceId)) ?? EMPTY_REGISTRY;

  // Which services call each service (approximate: by resolved target, not path-matched). Keyed and
  // valued by node id.
  const callersOf = new Map<string, Set<string>>();
  // topic -> producers/consumers, aggregated across the fleet (Kafka pairs globally by topic name).
  type Side = { service: string; edge: KafkaEdge };
  const topics = new Map<string, { producers: Side[]; consumers: Side[] }>();
  const topicOf = (t: string) => {
    let e = topics.get(t);
    if (!e) topics.set(t, (e = { producers: [], consumers: [] }));
    return e;
  };

  // Resolve one outbound dependency to its target node:
  //   1. name -> a scanned service (fleet-registry resolution) — wins;
  //   2. else off-graph (external / unknown).
  // Returns the target node id and, for a freshly-minted off-graph node, the node to register. Used
  // by BOTH passes so endpoint `callers[]` and edges agree on the same target.
  type EdgeTarget = { id: string; node?: NodeDto };
  const resolveEdgeTarget = (dep: OutboundDependency, svc: ParsedService): EdgeTarget => {
    const named = resolveTarget(dep, knownFor(svc));
    if (named !== 'external' && nodeIds.has(named)) return { id: named };

    const node = offGraphNode(dep, nodeIds);
    return { id: node.id, node };
  };

  // First pass: service nodes + gather callers + kafka sides.
  for (const svc of services) {
    const id = idOf(svc);
    nodes.set(id, {
      id,
      name: svc.serviceName || svc.serviceId,
      team: TEAM_SERVICE,
      type: 'service',
      note: null,
      language: svc.language,
      // repo = the per-service slug (catalog label); host = the in-cluster service slug callers use.
      repo: repoSlugOf(svc.repo, svc.serviceId),
      host: svc.serviceId,
    });

    for (const dep of svc.body.outbound_dependencies ?? []) {
      // A caller only for targets that ARE scanned services (off-graph ids aren't in nodeIds).
      const { id: target } = resolveEdgeTarget(dep, svc);
      if (nodeIds.has(target)) {
        if (!callersOf.has(target)) callersOf.set(target, new Set());
        callersOf.get(target)!.add(id);
      }
    }

    for (const p of svc.body.kafka_producers ?? [])
      topicOf(p.topic).producers.push({ service: id, edge: p });
    for (const c of svc.body.kafka_consumers ?? [])
      topicOf(c.topic).consumers.push({ service: id, edge: c });
  }

  // Second pass: endpoints (now that callersOf is complete).
  let epId = 0;
  for (const svc of services) {
    const id = idOf(svc);
    for (const ep of svc.body.endpoints ?? []) {
      endpoints.push({
        id: `ep${epId++}`,
        kind: 'rest',
        service: id,
        verb: ep.method,
        path: ep.path,
        source: restSource(ep.detection),
        confidence: asConfidence(ep.confidence),
        method: asMethod(ep.detection, 'FeignClient'),
        unresolved: false,
        callers: [...(callersOf.get(id) ?? [])].sort(),
        request: toFields(ep.request),
        response: toFields(ep.response),
      });
    }
  }

  // REST edges from outbound dependencies (creating external/unknown nodes as needed).
  let edgeId = 0;
  for (const svc of services) {
    const from = idOf(svc);
    for (const dep of svc.body.outbound_dependencies ?? []) {
      const t = resolveEdgeTarget(dep, svc);
      if (t.node && !nodes.has(t.node.id)) nodes.set(t.node.id, t.node);
      const to = t.id;
      edges.push({
        id: `e${edgeId++}`,
        from,
        to,
        // Honor the extractor's transport (grpc/websocket survive); REST callers fall back to rest.
        protocol: asProtocol(dep.protocol, 'rest'),
        method: asMethod(dep.detection, 'RestTemplate'),
        confidence: asConfidence(dep.confidence),
        label: dep.url || dep.target_name,
      });
    }
  }

  // Kafka: one producer->consumer edge per consumer (label = topic), plus a topic contract.
  const topicContracts: TopicContractDto[] = [];
  let tpId = 0;
  for (const [topic, sides] of topics) {
    const producer = sides.producers[0];
    const schemaSource = producer?.edge.schema ?? sides.consumers[0]?.edge.schema;
    // Invariant (CLAUDE.md §6 / validateContracts): a topic with no producer in scan scope is
    // "uncertain" — a consumer's own @KafkaListener confidence must NOT promote the topic, or the
    // UI rejects the contracts payload (producer null but confidence != uncertain).
    const confidence: Confidence = producer ? asConfidence(producer.edge.confidence) : 'uncertain';

    if (producer) {
      for (const c of sides.consumers) {
        edges.push({
          id: `e${edgeId++}`,
          from: producer.service,
          to: c.service,
          protocol: 'kafka',
          method: '@KafkaListener',
          confidence: asConfidence(c.edge.confidence),
          label: topic,
        });
      }
    }

    topicContracts.push({
      id: `tp${tpId++}`,
      kind: 'kafka',
      topic,
      producer: producer?.service ?? null,
      source: schemaSource ? 'Schema Registry (Avro)' : 'no registered schema',
      confidence,
      consumers: sides.consumers.map((c) => c.service).sort(),
      message: toFields(schemaSource),
    });
  }

  // Only include team buckets actually used by a node.
  const usedTeams = new Set([...nodes.values()].map((n) => n.team));
  const teams = [...usedTeams].map((id) => TEAM_DEFS[id]).filter(Boolean);

  return {
    graph: { org: orgFor(services), teams, nodes: [...nodes.values()], edges },
    contracts: { endpoints, topics: topicContracts },
  };
}
