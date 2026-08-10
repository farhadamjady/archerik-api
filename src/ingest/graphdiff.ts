// Semantic diff over two Service bodies (INGEST-CONTRACT.md §5). Pure function of (baseline, head).
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
  Schema,
  SchemaFieldDiff,
  ServiceBody,
} from './model';

export const endpointKey = (e: Endpoint): string => `${e.method} ${e.path}`;
export const dependencyKey = (d: OutboundDependency): string => `${d.target_name}|${d.detection}`;
export const kafkaKey = (k: KafkaEdge, direction: 'producer' | 'consumer'): string =>
  `${k.topic}|${direction}`;

/**
 * The type facet of a schema node — what a "type change" is judged on (INGEST-CONTRACT.md §5):
 * arrays fold in their element type, maps their key/value types, so `array<Line>`→`array<Item>` or
 * `map<String,A>`→`map<String,B>` register as changes even though `type` ("array"/"map") is unchanged.
 */
function typeFacet(f: Schema): string {
  if (f.type === 'array') return `array<${f.items ?? '?'}>`;
  if (f.type === 'map') return `map<${f.key_type ?? '?'},${f.value_type ?? '?'}>`;
  return f.type;
}

const canonConstraints = (c?: Record<string, string>): string =>
  c ? JSON.stringify(Object.fromEntries(Object.entries(c).sort())) : '';

/** Attribute axes that differ between two same-path, same-type nodes (order stable for byte-equality). */
function changedAttrs(b: Schema, h: Schema): string[] {
  const attrs: string[] = [];
  if (Boolean(b.nullable) !== Boolean(h.nullable)) attrs.push('nullable');
  if ((b.required ?? 'unknown') !== (h.required ?? 'unknown')) attrs.push('required');
  // enum order is significant (declaration order) — compare positionally, never sorted.
  if (JSON.stringify(b.enum ?? null) !== JSON.stringify(h.enum ?? null)) attrs.push('enum');
  if (canonConstraints(b.constraints) !== canonConstraints(h.constraints))
    attrs.push('constraints');
  if ((b.confidence ?? '') !== (h.confidence ?? '')) attrs.push('confidence');
  if (Boolean(b.truncated) !== Boolean(h.truncated)) attrs.push('truncated');
  return attrs;
}

/**
 * Field-path diff of two schemas (INGEST-CONTRACT.md §5/§4a). Recurses to the truncation boundary;
 * each node is keyed by its wire-name path from the edge root (`""` = root). A path on one side only
 * is add/remove; a differing type facet is a type change; a same-type node with a differing attribute
 * is an attribute change. Wire names are unique within a `nested` list, so name is a safe key.
 */
function diffSchema(base?: Schema, head?: Schema): SchemaFieldDiff[] {
  const diffs: SchemaFieldDiff[] = [];

  // Root node itself (the request/response/message type). A present↔absent whole schema surfaces via
  // the field-level add/removes below, so only compare the root when BOTH sides have one.
  if (base && head) {
    const from = typeFacet(base);
    const to = typeFacet(head);
    if (from !== to) diffs.push({ op: 'change', path: '', from, to });
    else {
      const attrs = changedAttrs(base, head);
      if (attrs.length) diffs.push({ op: 'change', path: '', attrs });
    }
  }

  const byName = (fs: Schema[]): Map<string, Schema> => new Map(fs.map((f) => [f.name ?? '', f]));
  const walk = (prefix: string, b: Schema[] = [], h: Schema[] = []): void => {
    const bm = byName(b);
    const hm = byName(h);
    for (const [name, hf] of hm) {
      const path = prefix + name;
      const bf = bm.get(name);
      if (!bf) {
        diffs.push({ op: 'add', path, type: typeFacet(hf) });
        continue;
      }
      const from = typeFacet(bf);
      const to = typeFacet(hf);
      if (from !== to) diffs.push({ op: 'change', path, from, to });
      else {
        const attrs = changedAttrs(bf, hf);
        if (attrs.length) diffs.push({ op: 'change', path, attrs });
      }
      // Descend into object children AND hoisted array-of-object element fields.
      const childPrefix = `${path}${hf.type === 'array' ? '[]' : ''}.`;
      walk(childPrefix, bf.nested, hf.nested);
    }
    for (const [name, bf] of bm) {
      if (!hm.has(name)) diffs.push({ op: 'remove', path: prefix + name, type: typeFacet(bf) });
    }
  };
  walk('', base?.nested, head?.nested);
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
