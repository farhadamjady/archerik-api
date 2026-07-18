// Semantic diff over two Service bodies (BACKEND_CONTRACT.md §5). Pure function of (baseline, head).
//
// CRITICAL: the identity keys MUST match the extractor's exactly (`internal/model/identity.go`) or
// diffs desync — the same edge would look added+removed across scans.
//   endpoint   = method + " " + path
//   dependency = target_name + "|" + detection
//   kafka edge = topic + "|" + direction   (direction implied by which slice it's in)
// Renames are intentionally NOT paired: a changed path is remove + add.

import {
  CategoryDiff,
  ChangedEntry,
  Endpoint,
  GraphDiff,
  KafkaEdge,
  OutboundDependency,
  SchemaField,
  SchemaFieldDiff,
  SchemaType,
  ServiceBody,
} from './model';

export const endpointKey = (e: Endpoint): string => `${e.method} ${e.path}`;
export const dependencyKey = (d: OutboundDependency): string => `${d.target_name}|${d.detection}`;
export const kafkaKey = (k: KafkaEdge, direction: 'producer' | 'consumer'): string =>
  `${k.topic}|${direction}`;

/** Compare two schemas by field name (one level; nested handled recursively). */
function diffSchema(base?: SchemaType, head?: SchemaType): SchemaFieldDiff[] {
  const diffs: SchemaFieldDiff[] = [];
  const walk = (b: SchemaField[] = [], h: SchemaField[] = []): void => {
    const byName = (fs: SchemaField[]): Map<string, SchemaField> =>
      new Map(fs.map((f) => [f.name, f]));
    const bm = byName(b);
    const hm = byName(h);
    for (const [name, hf] of hm) {
      const bf = bm.get(name);
      if (!bf) {
        diffs.push({ op: 'add', name, type: hf.type });
      } else if (bf.type !== hf.type) {
        diffs.push({ op: 'change', name, from: bf.type, to: hf.type });
      }
      if (bf) walk(bf.nested, hf.nested);
    }
    for (const [name, bf] of bm) {
      if (!hm.has(name)) diffs.push({ op: 'remove', name, type: bf.type });
    }
  };
  walk(base?.nested, head?.nested);
  return diffs;
}

/** Generic added/removed/changed over one category keyed by `key`, with a per-item field comparer. */
function diffCategory<T>(
  base: T[],
  head: T[],
  key: (t: T) => string,
  compare: (b: T, h: T) => { changed: string[]; schema_diff?: SchemaFieldDiff[] },
): CategoryDiff<T> {
  const bm = new Map(base.map((t) => [key(t), t]));
  const hm = new Map(head.map((t) => [key(t), t]));

  const added: T[] = [];
  const removed: T[] = [];
  const changed: ChangedEntry<T>[] = [];

  for (const [k, h] of hm) {
    const b = bm.get(k);
    if (!b) {
      added.push(h);
      continue;
    }
    const { changed: names, schema_diff } = compare(b, h);
    if (names.length > 0) {
      changed.push({ ...h, changed: names, ...(schema_diff?.length ? { schema_diff } : {}) });
    }
  }
  for (const [k, b] of bm) {
    if (!hm.has(k)) removed.push(b);
  }

  // Omit empty arrays; an untouched category serializes as {} (matches the reference fixtures).
  const out: CategoryDiff<T> = {};
  if (added.length) out.added = added;
  if (removed.length) out.removed = removed;
  if (changed.length) out.changed = changed;
  return out;
}

function compareEndpoint(
  b: Endpoint,
  h: Endpoint,
): {
  changed: string[];
  schema_diff?: SchemaFieldDiff[];
} {
  const changed: string[] = [];
  if (b.confidence !== h.confidence) changed.push('confidence');
  if (b.protocol !== h.protocol) changed.push('protocol');
  const reqDiff = diffSchema(b.request, h.request);
  const resDiff = diffSchema(b.response, h.response);
  if (reqDiff.length) changed.push('request_schema');
  if (resDiff.length) changed.push('response_schema');
  const schema_diff = [...reqDiff, ...resDiff];
  return { changed, schema_diff };
}

function compareDependency(b: OutboundDependency, h: OutboundDependency): { changed: string[] } {
  const changed: string[] = [];
  // detection is part of the identity key, so it can never differ for a matched pair.
  if (b.confidence !== h.confidence) changed.push('confidence');
  if ((b.url ?? '') !== (h.url ?? '')) changed.push('url');
  if (Boolean(b.resolved) !== Boolean(h.resolved)) changed.push('resolved');
  return { changed };
}

function compareKafka(
  b: KafkaEdge,
  h: KafkaEdge,
): {
  changed: string[];
  schema_diff?: SchemaFieldDiff[];
} {
  const changed: string[] = [];
  if (b.confidence !== h.confidence) changed.push('confidence');
  if (Boolean(b.resolved) !== Boolean(h.resolved)) changed.push('resolved');
  const schema_diff = diffSchema(b.schema, h.schema);
  if (schema_diff.length) changed.push('schema');
  return { changed, schema_diff };
}

function count(c: CategoryDiff<unknown>): { added: number; removed: number; changed: number } {
  return {
    added: c.added?.length ?? 0,
    removed: c.removed?.length ?? 0,
    changed: c.changed?.length ?? 0,
  };
}

/** Diff `head` against `base`. `target_resolutions` is filled by the caller (fleet-dependent). */
export function diffGraph(base: ServiceBody, head: ServiceBody): GraphDiff {
  const endpoints = diffCategory(base.endpoints, head.endpoints, endpointKey, compareEndpoint);
  const outbound_dependencies = diffCategory(
    base.outbound_dependencies,
    head.outbound_dependencies,
    dependencyKey,
    compareDependency,
  );
  const kafka_producers = diffCategory(
    base.kafka_producers,
    head.kafka_producers,
    (k) => kafkaKey(k, 'producer'),
    compareKafka,
  );
  const kafka_consumers = diffCategory(
    base.kafka_consumers,
    head.kafka_consumers,
    (k) => kafkaKey(k, 'consumer'),
    compareKafka,
  );

  const categories: CategoryDiff<unknown>[] = [
    endpoints,
    outbound_dependencies,
    kafka_producers,
    kafka_consumers,
  ];
  const summary = categories.reduce(
    (acc, c) => {
      const n = count(c);
      return {
        added: acc.added + n.added,
        removed: acc.removed + n.removed,
        changed: acc.changed + n.changed,
      };
    },
    { added: 0, removed: 0, changed: 0 },
  );

  return {
    endpoints,
    outbound_dependencies,
    kafka_producers,
    kafka_consumers,
    service_id: head.service_id,
    summary,
    target_resolutions: {},
  };
}
