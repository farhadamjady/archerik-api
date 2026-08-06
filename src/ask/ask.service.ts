import { Injectable } from '@nestjs/common';
import { resolveModel } from '../llm/model-registry';
import { StoredGraphData } from '../common/graph-filter';
import { GraphLookupService } from '../common/graph-lookup.service';
import { EdgeDto, NodeDto, TopicContractDto } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

/** One piece of evidence the answer rests on (BACKEND-HANDOFF.md §5). */
export interface AskCite {
  name: string;
  dir: string;
  confidence: string;
}

export interface AskResponse {
  text: string;
  cites: AskCite[];
  note: string | null;
  model: string;
}

// The model string echoed into the "grounded in catalog · <model>" header comes from the shared
// registry (src/llm/model-registry.ts), so the id the user picked, the provider key that will be
// loaded, and the model sent upstream can't drift apart. An unknown id falls back to the default
// rather than 400ing — a stale id from a cached UI bundle should still get an answer.
//
// NOTE: the answer engine below is still the deterministic resolver. It is replaced by a real
// provider call in step 6 of LLM-KEYS-PLAN.md; the registry lookup lands early so /models and /ask
// agree on the model vocabulary from here on.

/**
 * POST /api/v1/ask — grounded Q&A over the account catalog.
 *
 * Deterministic and grounded by construction: every answer is computed from the stored graph + Kafka
 * contracts, and every claim is backed by the actual edges/consumers it rests on (returned as
 * `cites`). It NEVER invents a call — an unrecognized question returns a factual "point me at a
 * service or topic" prompt with no cites, and an internal failure throws (the UI shows its explicit
 * "no answer" bubble). Mirrors the reference resolver in the UI's dev-server / DC file.
 */
@Injectable()
export class AskService {
  constructor(
    private readonly lookup: GraphLookupService,
    private readonly prisma: PrismaService,
  ) {}

  async ask(
    accountId: string,
    branch: string,
    question: string,
    model?: string,
  ): Promise<AskResponse> {
    const modelLabel = resolveModel(model).wireModel;

    const graph = await this.lookup.findGraph(accountId, branch);
    if (!graph) {
      return {
        text: 'I answer from the current catalog, but no repositories have been scanned for this account yet.',
        cites: [],
        note: null,
        model: modelLabel,
      };
    }

    const data = graph.data as unknown as StoredGraphData;
    const topicRows = await this.prisma.contract.findMany({
      where: { graphId: graph.id, kind: 'kafka' },
    });
    const topics = topicRows.map((r) => r.data as unknown as TopicContractDto);

    return { ...answer(question, data.nodes ?? [], data.edges ?? [], topics), model: modelLabel };
  }
}

// --- pure grounded resolver (no DB, no I/O) ---

/** Display name for a node id — the friendly name, else its repo slug, else the raw id. */
function labeller(nodes: NodeDto[]): (id: string) => string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (id: string) => {
    const n = byId.get(id);
    return n?.name || n?.repo || id;
  };
}

/** Direction/method label for a cite: the Kafka topic ("via <topic>") or the REST method string. */
const citeDir = (e: EdgeDto): string => (e.protocol === 'kafka' ? `via ${e.label}` : e.method);

/**
 * Find the node and/or topic a free-text question is about. A node matches when the question mentions
 * its name, repo slug, or host (longest match wins, so "payment-service" beats a bare "service"); a
 * topic matches on its name. Substring match on the lowercased question, mirroring the UI reference.
 */
function findEntity(
  lc: string,
  nodes: NodeDto[],
  topics: TopicContractDto[],
): { node: NodeDto | null; topic: TopicContractDto | null } {
  let node: NodeDto | null = null;
  let bestLen = 0;
  for (const n of nodes) {
    for (const cand of [n.name, n.repo, n.host]) {
      const c = (cand ?? '').toLowerCase();
      if (c && lc.includes(c) && c.length > bestLen) {
        node = n;
        bestLen = c.length;
      }
    }
  }

  let topic: TopicContractDto | null = null;
  let tLen = 0;
  for (const t of topics) {
    const tn = t.topic.toLowerCase();
    if (tn && lc.includes(tn) && tn.length > tLen) {
      topic = t;
      tLen = tn.length;
    }
  }

  return { node, topic };
}

function answer(
  question: string,
  nodes: NodeDto[],
  edges: EdgeDto[],
  topics: TopicContractDto[],
): Omit<AskResponse, 'model'> {
  const lc = question.toLowerCase();
  const nameOf = labeller(nodes);
  const { node, topic } = findEntity(lc, nodes, topics);

  // Who consumes / subscribes to a topic.
  if (topic && /(consume|subscrib|listen|who.*(reads|gets))/.test(lc)) {
    const cites: AskCite[] = topic.consumers.map((c) => ({
      name: nameOf(c),
      dir: 'consumes',
      confidence: 'confirmed',
    }));
    const prod = topic.producer ? nameOf(topic.producer) : null;
    return {
      text: `${topic.consumers.length} service${topic.consumers.length === 1 ? '' : 's'} consume the ${topic.topic} topic${
        prod ? `, produced by ${prod}` : ' — no producer was found in the scanned repositories'
      }.`,
      cites,
      note: prod
        ? null
        : 'The producer of this topic is unresolved, so the message shape is recorded as uncertain.',
    };
  }

  // Dependents of a service (inbound / who calls it).
  if (node && /(depend|calls?|who.*(call|use)|upstream|callers?)/.test(lc)) {
    const inbound = edges.filter((e) => e.to === node.id);
    const byConf = { confirmed: 0, likely: 0, uncertain: 0 };
    for (const e of inbound) byConf[e.confidence]++;
    const cites: AskCite[] = inbound
      .slice(0, 8)
      .map((e) => ({ name: nameOf(e.from), dir: citeDir(e), confidence: e.confidence }));
    const uncertain = byConf.likely + byConf.uncertain;
    return {
      text: `${inbound.length} ${inbound.length === 1 ? 'dependency points' : 'dependencies point'} at ${nameOf(node.id)} — ${byConf.confirmed} confirmed, ${byConf.likely} likely, ${byConf.uncertain} uncertain. These are derived from callers' code, not declared by ${nameOf(node.id)}.`,
      cites,
      note: uncertain
        ? `${uncertain} of these rest on likely/uncertain edges — treat the list as indicative, not exhaustive.`
        : null,
    };
  }

  // What a service calls (outbound / downstream).
  if (node && /(what.*(call|depend)|downstream|outbound|reach)/.test(lc)) {
    const out = edges.filter((e) => e.from === node.id);
    const cites: AskCite[] = out
      .slice(0, 8)
      .map((e) => ({ name: nameOf(e.to), dir: citeDir(e), confidence: e.confidence }));
    return {
      text: `${nameOf(node.id)} has ${out.length} outbound ${out.length === 1 ? 'dependency' : 'dependencies'}.`,
      cites,
      note: null,
    };
  }

  // A named service with no matched intent → a factual summary that points the user at what to ask.
  if (node) {
    const inbound = edges.filter((e) => e.to === node.id).length;
    const out = edges.filter((e) => e.from === node.id).length;
    return {
      text: `${nameOf(node.id)} has ${inbound} inbound and ${out} outbound ${
        inbound + out === 1 ? 'dependency' : 'dependencies'
      }. Ask who calls it, what it calls, or about a topic it produces or consumes.`,
      cites: [],
      note: null,
    };
  }

  // Nothing matched — never invent. Tell the user how to ground a question.
  return {
    text: 'I answer only from the scanned catalog. Name a service (e.g. "what calls payment-service?") or a Kafka topic (e.g. "who consumes OrderCreated?").',
    cites: [],
    note: null,
  };
}
