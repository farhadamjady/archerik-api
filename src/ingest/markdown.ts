// Renders the PR-comment markdown returned in IngestResponse.markdown. The CI posts this verbatim;
// the server never touches GitHub.

import { CategoryDiff, Endpoint, GraphDiff, KafkaEdge, OutboundDependency } from './model';

const FOOTER =
  '<sub>archerik · confidence: confirmed = found literally · likely = resolved through ' +
  'config · uncertain = not statically resolvable (still real)</sub>';

const MARK = { added: '➕', removed: '➖', changed: '🔄' } as const;

function endpointLine(mark: string, e: Endpoint): string {
  return `- ${mark} ${e.method} ${e.path} · ${e.protocol} · ${e.detection} · ${e.confidence}`;
}

function depLine(mark: string, d: OutboundDependency, resolutions: Record<string, string>): string {
  const url = d.url ? ` → \`${d.url}\`` : '';
  const resolution = resolutions[`${d.target_name}|${d.detection}`] ?? 'external';
  return `- ${mark} ${d.target_name}${url} · ${d.protocol} · ${d.detection} · ${d.confidence} · ${resolution}`;
}

function kafkaLine(mark: string, k: KafkaEdge): string {
  return `- ${mark} ${k.topic} · ${k.protocol} · ${k.detection} · ${k.confidence}`;
}

function section<T>(
  title: string,
  cat: CategoryDiff<T>,
  line: (mark: string, t: T) => string,
): string[] {
  const lines: string[] = [];
  for (const t of cat.added ?? []) lines.push(line(MARK.added, t));
  for (const t of cat.removed ?? []) lines.push(line(MARK.removed, t));
  for (const t of cat.changed ?? []) {
    const names = (t as { changed?: string[] }).changed?.join(', ');
    lines.push(`${line(MARK.changed, t)}${names ? ` · changed: ${names}` : ''}`);
  }
  return lines.length ? [`#### ${title}`, ...lines] : [];
}

/** Returns the rendered comment, or "" when there is nothing to post. */
export function renderMarkdown(diff: GraphDiff, firstScan: boolean): string {
  const { added, removed, changed } = diff.summary;
  if (added + removed + changed === 0) return '';

  const heading = firstScan
    ? `### 🏗 Architecture impact: **${diff.service_id}** (first scan)`
    : `### 🏗 Architecture impact: **${diff.service_id}**`;

  const body = [
    ...section('Endpoints', diff.endpoints, endpointLine),
    ...section('Outbound dependencies', diff.outbound_dependencies, (m, d) =>
      depLine(m, d, diff.target_resolutions),
    ),
    ...section('Kafka producers', diff.kafka_producers, kafkaLine),
    ...section('Kafka consumers', diff.kafka_consumers, kafkaLine),
  ];

  return (
    [
      heading,
      '',
      `**${added} added · ${removed} removed · ${changed} changed**`,
      '',
      ...body,
      '',
    ].join('\n') +
    '\n' +
    FOOTER +
    '\n'
  );
}
