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
import { resolveTarget } from './resolve';

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

const asMethod = (v: string, fallback: EdgeMethod): EdgeMethod =>
  (EDGE_METHOD as readonly string[]).includes(v) ? (v as EdgeMethod) : fallback;

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

/** REST detection -> a human-readable contract source string (types.ts source is free text). */
function restSource(detection: string): string {
  switch (detection) {
    case 'FeignClient':
      return 'in-code DTO (Feign)';
    case 'WebClient':
      return 'in-code DTO (WebClient)';
    case 'RestTemplate':
      return 'in-code (RestTemplate)';
    case 'route':
      return 'OpenAPI spec';
    default:
      return `in-code (${detection})`;
  }
}

/** Classify a non-internal target: unresolved (runtime/legacy) -> unknown, otherwise external. */
function offGraphNode(dep: OutboundDependency): NodeDto {
  const id = dep.target_name || dep.url || 'unknown-target';
  if (dep.resolved === false) {
    return {
      id,
      name: id,
      team: TEAM_UNKNOWN,
      type: 'unknown',
      note: dep.url
        ? 'Target host resolved from a variable at runtime — service identity is not known.'
        : 'Call target could not be matched to a scanned service in scan scope.',
      language: null,
    };
  }
  return { id, name: id, team: TEAM_EXTERNAL, type: 'external', note: null, language: null };
}

/**
 * Build the read model from every service baseline in a (repo, branch).
 * `known` maps a lowercased matchable name -> canonical service_id (the fleet registry).
 */
export function projectReadModel(
  services: ParsedService[],
  known: Map<string, string>,
): { graph: ProjectedGraph; contracts: ProjectedContracts } {
  const nodes = new Map<string, NodeDto>();
  const edges: EdgeDto[] = [];
  const endpoints: EndpointContractDto[] = [];

  const serviceIds = new Set(services.map((s) => s.serviceId));

  // Which services call each service (approximate: by resolved target, not path-matched).
  const callersOf = new Map<string, Set<string>>();
  // topic -> producers/consumers, aggregated across the fleet.
  type Side = { service: string; edge: KafkaEdge };
  const topics = new Map<string, { producers: Side[]; consumers: Side[] }>();
  const topicOf = (t: string) => {
    let e = topics.get(t);
    if (!e) topics.set(t, (e = { producers: [], consumers: [] }));
    return e;
  };

  // First pass: service nodes + REST endpoints + gather kafka sides.
  for (const svc of services) {
    nodes.set(svc.serviceId, {
      id: svc.serviceId,
      name: svc.serviceName || svc.serviceId,
      team: TEAM_SERVICE,
      type: 'service',
      note: null,
      language: svc.language,
      repo: svc.repo,
    });

    for (const dep of svc.body.outbound_dependencies ?? []) {
      const target = resolveTarget(dep, known);
      if (target !== 'external' && serviceIds.has(target)) {
        if (!callersOf.has(target)) callersOf.set(target, new Set());
        callersOf.get(target)!.add(svc.serviceId);
      }
    }

    for (const p of svc.body.kafka_producers ?? [])
      topicOf(p.topic).producers.push({ service: svc.serviceId, edge: p });
    for (const c of svc.body.kafka_consumers ?? [])
      topicOf(c.topic).consumers.push({ service: svc.serviceId, edge: c });
  }

  // Second pass: endpoints (now that callersOf is complete).
  let epId = 0;
  for (const svc of services) {
    for (const ep of svc.body.endpoints ?? []) {
      endpoints.push({
        id: `ep${epId++}`,
        kind: 'rest',
        service: svc.serviceId,
        verb: ep.method,
        path: ep.path,
        source: restSource(ep.detection),
        confidence: asConfidence(ep.confidence),
        method: asMethod(ep.detection, 'FeignClient'),
        unresolved: false,
        callers: [...(callersOf.get(svc.serviceId) ?? [])].sort(),
        request: toFields(ep.request),
        response: toFields(ep.response),
      });
    }
  }

  // REST edges from outbound dependencies (creating external/unknown nodes as needed).
  let edgeId = 0;
  for (const svc of services) {
    for (const dep of svc.body.outbound_dependencies ?? []) {
      const target = resolveTarget(dep, known);
      let to: string;
      if (target !== 'external' && serviceIds.has(target)) {
        to = target;
      } else {
        const node = offGraphNode(dep);
        if (!nodes.has(node.id)) nodes.set(node.id, node);
        to = node.id;
      }
      edges.push({
        id: `e${edgeId++}`,
        from: svc.serviceId,
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
    const confidence = asConfidence(
      producer?.edge.confidence ?? sides.consumers[0]?.edge.confidence ?? 'uncertain',
    );

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
