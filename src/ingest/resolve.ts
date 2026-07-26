// Name -> service_id resolution (BACKEND_CONTRACT.md §6). The extractor emits a raw `target_name`
// and never guesses the service_id — that mapping is ours to own, as a function of the fleet
// registry (every service that has scanned its default branch is "known").
//
// Matching (reference `backend.go` -> resolveTarget), minimal per spec:
//   1. the raw target_name (lowercased), if not a URL
//   2. the URL hostname
//   3. the hostname's first DNS label (k8s: payment-service.prod.svc -> payment-service)
// Otherwise -> "external".

import { OutboundDependency } from './model';
import { dependencyKey } from './graphdiff';

function hostnameOf(url: string): string | undefined {
  try {
    // URL.hostname drops the port AND lowercases the host, collapsing http://AUTH-SERVICE:8088
    // and http://auth-service onto one label.
    return new URL(url).hostname;
  } catch {
    // Not an absolute URL (e.g. "inventory-service/api"): take the leading authority segment.
    // [^/:] stops at the first ':' so the port is dropped here too; the caller lowercases.
    const m = /^(?:[a-z]+:\/\/)?([^/:]+)/i.exec(url);
    return m?.[1];
  }
}

const isUrl = (s: string): boolean => /:\/\//.test(s) || s.includes('/');

/** Match candidates for one raw target string: the raw name if it's a bare service name, else the
 *  URL's hostname and its first DNS label (k8s: payment-service.prod.svc -> payment-service). */
function candidatesFor(raw: string): string[] {
  if (!raw) return [];
  if (!isUrl(raw)) return [raw];
  const host = hostnameOf(raw);
  if (!host) return [];
  return [host, host.split('.')[0]];
}

/** Resolve one dependency to a known target (registry value), or "external". `known` maps a
 *  lowercased matchable name -> the target's node id. Resolution keys ONLY on `target_name`: the
 *  extractor emits it host-only (a Feign logical name or a URL's authority), and `url` is a label
 *  only — for a bare-path call `target_name` is empty and `url` carries just a path (no host), so
 *  deriving a host from `url` would invent a junk target. Matching is case-insensitive (service
 *  names are DNS-style, so this is always safe). */
export function resolveTarget(dep: OutboundDependency, known: Map<string, string>): string {
  for (const c of candidatesFor(dep.target_name)) {
    const hit = known.get(c.toLowerCase());
    if (hit) return hit;
  }
  return 'external';
}

/** Normalized node identity for a target that did NOT resolve to a scanned service. Keyed ONLY on
 *  `target_name` (the lowercased, port-stripped host when it is a URL, else the raw name lowercased),
 *  collapsing host-only / host+path / port / case variants onto one node. An EMPTY `target_name`
 *  buckets to a single `unknown-target` node regardless of `url`: the extractor emits `target_name:""`
 *  for a bare-path call whose host is a runtime baseUrl bean, so `url` (just a path) is a label, not
 *  an identity — using it would mint junk `/orders`-style nodes. */
export function externalKey(dep: OutboundDependency): string {
  const name = dep.target_name?.trim();
  if (!name) return 'unknown-target';
  const host = isUrl(name) ? hostnameOf(name) : undefined;
  return (host || name).toLowerCase();
}

/** Build target_resolutions for every outbound dependency in the head graph. */
export function resolveAll(
  deps: OutboundDependency[],
  known: Map<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dep of deps) {
    out[dependencyKey(dep)] = resolveTarget(dep, known);
  }
  return out;
}
