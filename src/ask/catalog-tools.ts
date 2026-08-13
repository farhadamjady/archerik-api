import { EdgeDto, EndpointContractDto, NodeDto, TopicContractDto } from '../common/types';
import { ToolSpec } from '../llm/provider.types';
import { AskCite, EvidenceLedger } from './evidence';

/**
 * The read-only view of one account's catalog that Ask answers from.
 *
 * The model sees the graph ONLY through the tools below. It gets no raw dump, so it cannot describe
 * a service, edge or topic that isn't in here.
 */
export interface Catalog {
  nodes: NodeDto[];
  edges: EdgeDto[];
  topics: TopicContractDto[];
  endpoints: EndpointContractDto[];
}

/** Keeps a single tool result from crowding out the conversation. */
const ROW_LIMIT = 50;

/**
 * Which tool results count as evidence.
 *
 * Only *relationships* are citable — a dependency edge, a topic's producer/consumers, an endpoint's
 * callers. A bare service listing is discovery, not proof of anything, so `list_services` and
 * `list_topics` record nothing. This keeps `cites` meaning "the facts this claim rests on" rather
 * than "everything the model happened to look at".
 */
export const CATALOG_TOOLS: ToolSpec[] = [
  {
    name: 'list_services',
    description:
      'Find services in the catalog by name, repository slug, or host. Omit `query` to list ' +
      'everything. Use this first when the question names something you have not seen yet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring to match.' },
      },
      required: [],
    },
  },
  {
    name: 'get_service_dependencies',
    description:
      'List the dependency edges of one service. `inbound` = who calls it (derived from callers’ ' +
      'code, not declared by the service). `outbound` = what it calls. Each row carries an ' +
      'evidence id you must cite.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name, repo slug, or host.' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'both'] },
      },
      required: ['service'],
    },
  },
  {
    name: 'list_topics',
    description: 'Find Kafka topics in the catalog by name. Omit `query` to list everything.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'get_topic',
    description:
      'Get one Kafka topic: its producer, its consumers, and its message schema. Producer and ' +
      'consumers each carry an evidence id you must cite.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'Exact or partial topic name.' } },
      required: ['topic'],
    },
  },
  {
    name: 'get_endpoints',
    description:
      'List REST endpoints exposed by a service, with their request/response field names and each ' +
      "endpoint's callers. Callers carry evidence ids you must cite.",
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name, repo slug, or host.' },
        path: { type: 'string', description: 'Optional substring filter on the endpoint path.' },
      },
      required: ['service'],
    },
  },
];

export interface ToolContext {
  catalog: Catalog;
  ledger: EvidenceLedger;
}

/** Whatever a tool returns, serialised to JSON for the model. `error` is a recoverable hint. */
export type ToolOutput = Record<string, unknown>;

/**
 * Runs one tool call. Never throws: a bad tool name or bad arguments come back as an `error` field
 * the model can read and retry from, which lets the loop self-correct instead of failing the whole
 * request on one malformed call.
 */
export function executeCatalogTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): ToolOutput {
  switch (name) {
    case 'list_services':
      return listServices(input, ctx);
    case 'get_service_dependencies':
      return getServiceDependencies(input, ctx);
    case 'list_topics':
      return listTopics(input, ctx);
    case 'get_topic':
      return getTopic(input, ctx);
    case 'get_endpoints':
      return getEndpoints(input, ctx);
    default:
      return {
        error: `unknown tool "${name}"`,
        available: CATALOG_TOOLS.map((t) => t.name),
      };
  }
}

// --- tools ---------------------------------------------------------------

function listServices(input: Record<string, unknown>, { catalog }: ToolContext): ToolOutput {
  const query = str(input.query);
  const services = catalog.nodes.filter((n) => n.type === 'service');
  const matched = query ? services.filter((n) => matchesNode(n, query)) : services;

  return {
    services: matched.slice(0, ROW_LIMIT).map((n) => ({
      name: displayName(n),
      repo: n.repo ?? null,
      host: n.host ?? null,
      language: n.language ?? null,
      team: n.team,
      inbound: catalog.edges.filter((e) => e.to === n.id).length,
      outbound: catalog.edges.filter((e) => e.from === n.id).length,
    })),
    total: matched.length,
    truncated: matched.length > ROW_LIMIT,
  };
}

function getServiceDependencies(input: Record<string, unknown>, ctx: ToolContext): ToolOutput {
  const { catalog, ledger } = ctx;
  const wanted = str(input.service);
  if (!wanted) return { error: 'service is required' };

  const node = findNode(catalog, wanted);
  if (!node) return notFound(catalog, wanted);

  const direction = str(input.direction) ?? 'both';
  if (!['inbound', 'outbound', 'both'].includes(direction)) {
    return { error: `direction must be one of inbound, outbound, both (got "${direction}")` };
  }

  const nameOf = labeller(catalog);
  const rows: ToolOutput[] = [];

  if (direction !== 'outbound') {
    for (const edge of catalog.edges.filter((e) => e.to === node.id).slice(0, ROW_LIMIT)) {
      rows.push({
        evidence_id: ledger.record(citeFromEdge(edge, nameOf(edge.from))),
        direction: 'inbound',
        caller: nameOf(edge.from),
        protocol: edge.protocol,
        method: edge.method,
        confidence: edge.confidence,
        label: edge.label,
      });
    }
  }
  if (direction !== 'inbound') {
    for (const edge of catalog.edges.filter((e) => e.from === node.id).slice(0, ROW_LIMIT)) {
      rows.push({
        evidence_id: ledger.record(citeFromEdge(edge, nameOf(edge.to))),
        direction: 'outbound',
        target: nameOf(edge.to),
        protocol: edge.protocol,
        method: edge.method,
        confidence: edge.confidence,
        label: edge.label,
      });
    }
  }

  return {
    service: displayName(node),
    dependencies: rows,
    // Stated so the model can reproduce the contract's wording rather than invent a framing.
    note: 'Inbound edges are derived from callers’ code, not declared by this service.',
  };
}

function listTopics(input: Record<string, unknown>, { catalog }: ToolContext): ToolOutput {
  const query = str(input.query)?.toLowerCase();
  const matched = query
    ? catalog.topics.filter((t) => t.topic.toLowerCase().includes(query))
    : catalog.topics;

  return {
    topics: matched.slice(0, ROW_LIMIT).map((t) => ({
      topic: t.topic,
      producer: t.producer,
      consumer_count: t.consumers.length,
      confidence: t.confidence,
    })),
    total: matched.length,
    truncated: matched.length > ROW_LIMIT,
  };
}

function getTopic(input: Record<string, unknown>, ctx: ToolContext): ToolOutput {
  const { catalog, ledger } = ctx;
  const wanted = str(input.topic);
  if (!wanted) return { error: 'topic is required' };

  const lower = wanted.toLowerCase();
  const topic =
    catalog.topics.find((t) => t.topic.toLowerCase() === lower) ??
    catalog.topics.find((t) => t.topic.toLowerCase().includes(lower));

  if (!topic) {
    return {
      error: `no topic matching "${wanted}"`,
      available: catalog.topics.slice(0, ROW_LIMIT).map((t) => t.topic),
    };
  }

  const nameOf = labeller(catalog);
  return {
    topic: topic.topic,
    producer: topic.producer
      ? {
          name: nameOf(topic.producer),
          evidence_id: ledger.record({
            name: nameOf(topic.producer),
            dir: `produces ${topic.topic}`,
            confidence: topic.confidence,
          }),
        }
      : null,
    consumers: topic.consumers.slice(0, ROW_LIMIT).map((consumer) => ({
      name: nameOf(consumer),
      evidence_id: ledger.record({
        name: nameOf(consumer),
        dir: 'consumes',
        confidence: topic.confidence,
      }),
    })),
    source: topic.source,
    confidence: topic.confidence,
    message_fields: topic.message.map((f) => ({
      name: f.name,
      type: f.type,
      nullable: f.nullable,
    })),
    note: topic.producer
      ? 'Consumers are derived from consumers’ code, not declared by the producer.'
      : 'No producer was found in the scanned repositories, so the message shape is uncertain.',
  };
}

function getEndpoints(input: Record<string, unknown>, ctx: ToolContext): ToolOutput {
  const { catalog, ledger } = ctx;
  const wanted = str(input.service);
  if (!wanted) return { error: 'service is required' };

  const node = findNode(catalog, wanted);
  if (!node) return notFound(catalog, wanted);

  const nameOf = labeller(catalog);
  const serviceKeys = new Set(
    [node.id, node.name, node.repo, node.host].filter((v): v is string => Boolean(v)),
  );
  const pathFilter = str(input.path)?.toLowerCase();

  const matched = catalog.endpoints
    .filter((e) => serviceKeys.has(e.service))
    .filter((e) => !pathFilter || e.path.toLowerCase().includes(pathFilter));

  return {
    service: displayName(node),
    endpoints: matched.slice(0, ROW_LIMIT).map((endpoint) => ({
      verb: endpoint.verb,
      path: endpoint.path,
      source: endpoint.source,
      confidence: endpoint.confidence,
      unresolved: endpoint.unresolved,
      callers: endpoint.callers.map((caller) => ({
        name: nameOf(caller),
        evidence_id: ledger.record({
          name: nameOf(caller),
          dir: `${endpoint.verb} ${endpoint.path}`,
          confidence: endpoint.confidence,
        }),
      })),
      request_fields: endpoint.request.map((f) => f.name),
      response_fields: endpoint.response.map((f) => f.name),
    })),
    total: matched.length,
    truncated: matched.length > ROW_LIMIT,
  };
}

// --- helpers -------------------------------------------------------------

/** Direction label on a cite: the Kafka topic ("via <topic>") or the REST method string. */
export function citeFromEdge(edge: EdgeDto, otherName: string): AskCite {
  return {
    name: otherName,
    dir: edge.protocol === 'kafka' ? `via ${edge.label}` : edge.method,
    confidence: edge.confidence,
  };
}

/** Friendly name, else repo slug, else the raw id — matches how the UI labels a node. */
export function displayName(node: NodeDto): string {
  return node.name || node.repo || node.id;
}

/** Resolves a node id to a display name; unknown ids pass through so nothing is silently dropped. */
export function labeller(catalog: Catalog): (id: string) => string {
  const byId = new Map(catalog.nodes.map((n) => [n.id, n]));
  return (id: string) => {
    const node = byId.get(id);
    return node ? displayName(node) : id;
  };
}

/**
 * Resolves free text to a node: exact match on id/name/repo/host first, then longest substring —
 * so "payment-service" beats a bare "service" when both would match.
 */
function findNode(catalog: Catalog, wanted: string): NodeDto | undefined {
  const lower = wanted.toLowerCase();
  const candidates = (n: NodeDto) =>
    [n.id, n.name, n.repo, n.host]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase());

  const exact = catalog.nodes.find((n) => candidates(n).includes(lower));
  if (exact) return exact;

  let best: NodeDto | undefined;
  let bestLen = 0;
  for (const node of catalog.nodes) {
    for (const candidate of candidates(node)) {
      if ((candidate.includes(lower) || lower.includes(candidate)) && candidate.length > bestLen) {
        best = node;
        bestLen = candidate.length;
      }
    }
  }
  return best;
}

/** A miss is a recoverable hint, not a failure — the model retries with a real name. */
function notFound(catalog: Catalog, wanted: string): ToolOutput {
  return {
    error: `no service matching "${wanted}"`,
    available: catalog.nodes
      .filter((n) => n.type === 'service')
      .slice(0, ROW_LIMIT)
      .map(displayName),
  };
}

function matchesNode(node: NodeDto, query: string): boolean {
  const lower = query.toLowerCase();
  return [node.id, node.name, node.repo, node.host]
    .filter((v): v is string => Boolean(v))
    .some((v) => v.toLowerCase().includes(lower));
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
