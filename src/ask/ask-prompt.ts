import { Catalog, displayName } from './catalog-tools';

/**
 * How many names we're willing to seed into the prompt. Past this the index costs more than the
 * discovery round trip it saves, and the model is told to search instead.
 */
const INDEX_LIMIT = 150;

/**
 * The system prompt for a grounded catalog answer.
 *
 * Kept in its own file because it is the load-bearing text of the feature — the rules below are
 * what keep answers factual, and they should be reviewable without reading the loop around them.
 *
 * It is byte-stable for a given catalog, which is what makes the cache breakpoint on the system
 * block worth having: an account asking several questions between scans re-reads the cached prefix
 * instead of paying for it each time.
 */
export function buildSystemPrompt(catalog: Catalog): string {
  return [
    'You answer questions about a software architecture catalog: services, the REST and Kafka',
    'dependencies between them, and their contracts. You are talking to an engineer who wants',
    'facts about their own system.',
    '',
    'Rules:',
    '',
    '- Answer ONLY from tool results. Never state a dependency, topic, endpoint, or field you have',
    '  not seen in a tool result in this conversation. If the catalog does not cover the question,',
    '  say so plainly and stop — do not reason about what is likely to be true.',
    '- Relationship rows carry an `evidence_id`. Finish your reply with a line of the form',
    '  `EVIDENCE: ev1, ev4` listing the ids your answer rests on. Cite only ids you were actually',
    '  given; an id you did not receive will be discarded.',
    '- Report facts, never judgments. Do not describe anything as breaking, risky, severe, or',
    '  problematic, and do not recommend action. Confidence levels are themselves facts: report',
    '  `confirmed`, `likely`, and `uncertain` as they come back.',
    '- Inbound REST dependencies and Kafka consumers are DERIVED from the calling code, not declared',
    '  by the service being called. Say so when a question turns on it.',
    '- An unresolved target means static analysis could not identify the service. Report it as',
    '  unresolved; never guess which service it might be.',
    '- Be brief: two to four sentences, no preamble, no headings, no bullet lists unless the answer',
    '  is genuinely a list.',
    '',
    catalogIndex(catalog),
  ].join('\n');
}

/**
 * A compact index of what exists, so the common question ("what calls X?") can go straight to the
 * right tool instead of spending a round trip discovering that X exists.
 */
function catalogIndex(catalog: Catalog): string {
  const services = catalog.nodes
    .filter((n) => n.type === 'service')
    .map(displayName)
    .sort();
  const topics = catalog.topics.map((t) => t.topic).sort();

  const lines = ['<catalog>'];
  lines.push(
    services.length === 0
      ? 'services: none scanned yet'
      : services.length <= INDEX_LIMIT
        ? `services (${services.length}): ${services.join(', ')}`
        : `services: ${services.length} in total — too many to list; use list_services to search.`,
  );
  lines.push(
    topics.length === 0
      ? 'kafka topics: none detected'
      : topics.length <= INDEX_LIMIT
        ? `kafka topics (${topics.length}): ${topics.join(', ')}`
        : `kafka topics: ${topics.length} in total — too many to list; use list_topics to search.`,
  );
  lines.push('</catalog>');
  return lines.join('\n');
}

/** Matches an evidence id anywhere in the model's prose, decorated or not. */
const EVIDENCE_TOKEN = /\bev\d+\b/gi;

/** Pulls out every evidence id the model named. The ledger drops any that aren't real. */
export function extractEvidenceIds(text: string): string[] {
  return text.match(EVIDENCE_TOKEN) ?? [];
}

/**
 * Removes the citation bookkeeping from the prose before it reaches the user. The UI renders cites
 * as its own affordance, so leaving `EVIDENCE: ev1, ev2` in the bubble would show the plumbing.
 */
export function stripEvidenceMarkup(text: string): string {
  return text
    .replace(/^\s*EVIDENCE\s*:.*$/gim, '') // the trailing citation line
    .replace(/[[(]\s*ev\d+(\s*,\s*ev\d+)*\s*[\])]/gi, '') // inline [ev1] / (ev1, ev2)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
