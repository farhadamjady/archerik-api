/**
 * Canonical enum values from API-CONTRACT.md. The UI validates these strictly and fails loudly on
 * any unknown value, so these are the single source of truth for what the backend may emit.
 */

export const CONFIDENCE = ['confirmed', 'likely', 'uncertain'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

// `grpc`/`websocket` are extra transports the extractor may report; `unknown` is legitimate — the
// transport was undetermined. The UI validates PROTOCOL strictly against exactly this set.
export const PROTOCOL = ['rest', 'kafka', 'grpc', 'websocket', 'unknown'] as const;
export type Protocol = (typeof PROTOCOL)[number];

// `service` = a scanned code service · `external` = a resolvable third-party host (api.stripe.com)
// · `unknown` = a call target that could not be tied to either. An `unknown` node is never dropped:
// it is emitted with a `note` explaining why it stayed unresolved (CLAUDE.md §6).
export const NODE_TYPE = ['service', 'external', 'unknown'] as const;
export type NodeType = (typeof NODE_TYPE)[number];

/**
 * Canonical display strings for the detection method. NOTE: `method` is a FREE display string on the
 * wire — the UI does NOT validate it (it renders whatever we send, e.g. `HttpExchange`, `CloudStream`).
 * This list is only the canonical-casing vocabulary the projector maps known detections onto; an
 * unrecognized detection is passed through verbatim rather than coerced. REST: FeignClient | WebClient
 * | RestTemplate | route. Kafka: @KafkaListener | KafkaTemplate.
 */
export const EDGE_METHOD = [
  'FeignClient',
  'WebClient',
  'RestTemplate',
  'route',
  '@KafkaListener',
  'KafkaTemplate',
] as const;
export type EdgeMethod = (typeof EDGE_METHOD)[number];

export const CHANGE_OP = ['add', 'remove', 'change', 'confidence'] as const;
export type ChangeOp = (typeof CHANGE_OP)[number];

export const CHANGE_KIND = ['dependency', 'endpoint', 'topic', 'schema', 'confidence'] as const;
export type ChangeKind = (typeof CHANGE_KIND)[number];

export const CONTRACT_KIND = ['rest', 'kafka'] as const;
export type ContractKind = (typeof CONTRACT_KIND)[number];
