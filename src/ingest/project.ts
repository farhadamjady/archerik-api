// Projects the fleet's per-service baselines into the read model the UI consumes
// (GraphResponse + ContractsResponse). Pure and deterministic — no DB, no I/O. The ingest
// service gathers all baselines for a (repo, branch), calls this, and persists the result as a
// single current-head Graph row (+ Contract rows). Diffs/commits are NOT produced here: the
// extractor doesn't send commit metadata yet, so /api/v1/commits stays empty by design.

import { CONFIDENCE, EDGE_METHOD, Confidence, EdgeMethod } from '../common/enums';
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

// The extractor emits detection lowercase (`feign`, `webclient`, `resttemplate`, `router`); the wire
// EDGE_METHOD vocabulary is canonical-cased. Map so a Feign edge reads `FeignClient`, not the old
// `RestTemplate` fallback (which was every non-matching detection).
const DETECTION_METHOD: Record<string, EdgeMethod> = {
  feign: 'FeignClient',
  feignclient: 'FeignClient',
  webclient: 'WebClient',
  resttemplate: 'RestTemplate',
  router: 'route',
  route: 'route',
  kafkatemplate: 'KafkaTemplate',
  kafkalistener: '@KafkaListener',
  '@kafkalistener': '@KafkaListener',
};

const asMethod = (v: string, fallback: EdgeMethod): EdgeMethod => {
  const d = (v ?? '').toLowerCase();
  if (DETECTION_METHOD[d]) return DETECTION_METHOD[d];
  return (EDGE_METHOD as readonly string[]).includes(v) ? (v as EdgeMethod) : fallback;
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

/** Render one schema field as a display type, e.g. array<LineItem>. */
const fieldType = (f: SchemaField): string => (f.items ? `array<${f.items}>` : f.type);

/** SchemaType.nested -> UI FieldDto[]. `nullable` prefers the explicit flag, else the tri-state. */
function toFields(st?: SchemaType): FieldDto[] {
  if (!st?.nested) return [];
  return st.nested.map((f) => ({
    name: f.name,
    type: fieldType(f),
    nullable: f.nullable ?? f.required === 'optional',
    note: null,
  }));
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
    };
  }
  return { id, name: key, team: TEAM_EXTERNAL, type: 'external', note: null, language: null };
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
      repo: systemOf(svc.repo, svc.serviceId) || null,
    });

    for (const dep of svc.body.outbound_dependencies ?? []) {
      const target = resolveTarget(dep, knownFor(svc));
      if (target !== 'external' && nodeIds.has(target)) {
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
      const target = resolveTarget(dep, knownFor(svc));
      let to: string;
      if (target !== 'external' && nodeIds.has(target)) {
        to = target;
      } else {
        const node = offGraphNode(dep, nodeIds);
        if (!nodes.has(node.id)) nodes.set(node.id, node);
        to = node.id;
      }
      edges.push({
        id: `e${edgeId++}`,
        from,
        to,
        protocol: 'rest',
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
    // Invariant (CLAUDE.md §3.3 / validateContracts): a topic with no producer in scan scope is
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
    graph: { teams, nodes: [...nodes.values()], edges },
    contracts: { endpoints, topics: topicContracts },
  };
}
