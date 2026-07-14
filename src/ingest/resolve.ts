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
    return new URL(url).hostname;
  } catch {
    // Not an absolute URL (e.g. "inventory-service/api"): take the leading authority segment.
    const m = /^(?:[a-z]+:\/\/)?([^/:]+)/i.exec(url);
    return m?.[1];
  }
}

const isUrl = (s: string): boolean => /:\/\//.test(s) || s.includes('/');

/** Resolve one dependency to a known service_id, or "external". `known` maps lowercased -> id. */
export function resolveTarget(dep: OutboundDependency, known: Map<string, string>): string {
  const candidates: string[] = [];
  if (!isUrl(dep.target_name)) candidates.push(dep.target_name);
  const host = dep.url ? hostnameOf(dep.url) : undefined;
  if (host) {
    candidates.push(host);
    candidates.push(host.split('.')[0]);
  }
  for (const c of candidates) {
    const hit = known.get(c.toLowerCase());
    if (hit) return hit;
  }
  return 'external';
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
