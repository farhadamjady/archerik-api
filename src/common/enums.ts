/**
 * Canonical enum values from API-CONTRACT.md. The UI validates these strictly and fails loudly on
 * any unknown value, so these are the single source of truth for what the backend may emit.
 */

export const CONFIDENCE = ['confirmed', 'likely', 'uncertain'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const PROTOCOL = ['rest', 'kafka'] as const;
export type Protocol = (typeof PROTOCOL)[number];

export const NODE_TYPE = ['service', 'external', 'unknown'] as const;
export type NodeType = (typeof NODE_TYPE)[number];

/** REST: FeignClient | WebClient | RestTemplate | route. Kafka: @KafkaListener | KafkaTemplate. */
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
