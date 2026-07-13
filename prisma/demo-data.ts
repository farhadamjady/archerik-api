/**
 * The seeded demo dataset for `acme/shop-platform@main`.
 *
 * Coherent, fully valid (referential integrity holds), and exercises every enum value the UI can
 * receive: all three node types, all three confidence levels, both protocols, and each change op.
 * The PaymentService / StripeAPI / legacy-oms / OrderCreated / a3f19c2 examples mirror
 * API-CONTRACT.md verbatim so this reads as a faithful stand-in for a real scan.
 */

import {
  CommitDto,
  ContractsResponse,
  EdgeDto,
  GraphResponse,
  NodeDto,
  TeamDto,
} from '../src/common/types';

export const REPO = 'acme/shop-platform';
export const BRANCH = 'main';
export const COMMIT_SHA = 'a3f19c2';
export const SCANNED_AT = '2026-07-13T14:02:11Z';

const teams: TeamDto[] = [
  { id: 'gateway', name: 'Gateway', tier: 0, hue: 210 },
  { id: 'checkout', name: 'Checkout', tier: 1, hue: 30 },
  { id: 'payments', name: 'Payments', tier: 2, hue: 150 },
  { id: 'catalog', name: 'Catalog', tier: 2, hue: 90 },
  { id: 'orders', name: 'Orders', tier: 2, hue: 270 },
  { id: 'promotions', name: 'Promotions', tier: 2, hue: 330 },
  { id: 'inventory', name: 'Inventory', tier: 3, hue: 190 },
  { id: 'notifications', name: 'Notifications', tier: 3, hue: 50 },
  { id: 'analytics', name: 'Analytics', tier: 3, hue: 120 },
  // Buckets for non-service nodes so every node.team resolves to a team id.
  { id: 'external', name: 'External', tier: 3, hue: 0 },
  { id: 'unknown', name: 'Unknown', tier: 3, hue: 0 },
];

const service = (id: string, team: string): NodeDto => ({ id, name: id, team, type: 'service', note: null });
const external = (id: string): NodeDto => ({ id, name: id, team: 'external', type: 'external', note: null });

const nodes: NodeDto[] = [
  service('ApiGateway', 'gateway'),
  service('CheckoutOrchestrator', 'checkout'),
  service('PaymentService', 'payments'),
  service('RefundService', 'payments'),
  service('FraudCheckService', 'payments'),
  service('CatalogService', 'catalog'),
  service('PricingService', 'catalog'),
  service('OrderService', 'orders'),
  service('PromotionService', 'promotions'),
  service('InventoryService', 'inventory'),
  service('StockReservationService', 'inventory'),
  service('NotificationService', 'notifications'),
  service('AnalyticsIngestService', 'analytics'),
  external('StripeAPI'),
  external('TwilioAPI'),
  {
    id: 'legacy-oms (unresolved)',
    name: 'legacy-oms (unresolved)',
    team: 'unknown',
    type: 'unknown',
    note: 'RestTemplate call to a hostname with no matching Spring Boot service in scan scope.',
  },
  {
    id: 'http://pricing-svc:8080/{?}',
    name: 'http://pricing-svc:8080/{?}',
    team: 'unknown',
    type: 'unknown',
    note: 'Target host resolved from a variable at runtime — path shape is known, service identity is not.',
  },
];

const edges: EdgeDto[] = [
  { id: 'e0', from: 'ApiGateway', to: 'CheckoutOrchestrator', protocol: 'rest', method: 'route', confidence: 'confirmed', label: 'POST /checkout' },
  { id: 'e1', from: 'CheckoutOrchestrator', to: 'PaymentService', protocol: 'rest', method: 'FeignClient', confidence: 'confirmed', label: 'POST /payments' },
  { id: 'e2', from: 'CheckoutOrchestrator', to: 'CatalogService', protocol: 'rest', method: 'FeignClient', confidence: 'confirmed', label: 'GET /catalog/items/{id}' },
  { id: 'e3', from: 'CheckoutOrchestrator', to: 'PricingService', protocol: 'rest', method: 'WebClient', confidence: 'likely', label: 'POST /pricing/quote' },
  { id: 'e4', from: 'CheckoutOrchestrator', to: 'PromotionService', protocol: 'rest', method: 'WebClient', confidence: 'likely', label: 'POST /promotions/apply' },
  { id: 'e5', from: 'RefundService', to: 'PaymentService', protocol: 'rest', method: 'FeignClient', confidence: 'confirmed', label: 'POST /payments/{id}/refund' },
  { id: 'e6', from: 'PaymentService', to: 'FraudCheckService', protocol: 'rest', method: 'FeignClient', confidence: 'confirmed', label: 'POST /fraud/check' },
  { id: 'e7', from: 'PaymentService', to: 'StripeAPI', protocol: 'rest', method: 'WebClient', confidence: 'likely', label: 'POST /v1/charges' },
  { id: 'e8', from: 'OrderService', to: 'legacy-oms (unresolved)', protocol: 'rest', method: 'RestTemplate', confidence: 'uncertain', label: 'POST /legacy/orders' },
  { id: 'e9', from: 'PricingService', to: 'http://pricing-svc:8080/{?}', protocol: 'rest', method: 'RestTemplate', confidence: 'uncertain', label: 'GET /{?}' },
  { id: 'e10', from: 'NotificationService', to: 'TwilioAPI', protocol: 'rest', method: 'WebClient', confidence: 'likely', label: 'POST /2010-04-01/Messages' },
  // Kafka: producer → consumer, one edge per consumer, label = topic.
  { id: 'e11', from: 'OrderService', to: 'StockReservationService', protocol: 'kafka', method: '@KafkaListener', confidence: 'confirmed', label: 'OrderCreated' },
  { id: 'e12', from: 'OrderService', to: 'NotificationService', protocol: 'kafka', method: '@KafkaListener', confidence: 'confirmed', label: 'OrderCreated' },
  { id: 'e13', from: 'OrderService', to: 'InventoryService', protocol: 'kafka', method: '@KafkaListener', confidence: 'confirmed', label: 'OrderCreated' },
  { id: 'e14', from: 'OrderService', to: 'AnalyticsIngestService', protocol: 'kafka', method: '@KafkaListener', confidence: 'confirmed', label: 'OrderCreated' },
  { id: 'e15', from: 'PaymentService', to: 'NotificationService', protocol: 'kafka', method: '@KafkaListener', confidence: 'confirmed', label: 'PaymentAuthorized' },
  { id: 'e16', from: 'PaymentService', to: 'OrderService', protocol: 'kafka', method: '@KafkaListener', confidence: 'confirmed', label: 'PaymentAuthorized' },
  { id: 'e17', from: 'PaymentService', to: 'AnalyticsIngestService', protocol: 'kafka', method: '@KafkaListener', confidence: 'likely', label: 'PaymentCaptured' },
];

export const graph: GraphResponse = {
  repo: REPO,
  branch: BRANCH,
  scannedAt: SCANNED_AT,
  teams,
  nodes,
  edges,
};

export const contracts: ContractsResponse = {
  endpoints: [
    {
      id: 'ep0',
      kind: 'rest',
      service: 'PaymentService',
      verb: 'POST',
      path: '/payments',
      source: 'in-code DTO (Feign)',
      confidence: 'confirmed',
      method: 'FeignClient',
      unresolved: false,
      callers: ['CheckoutOrchestrator', 'RefundService'],
      request: [
        { name: 'orderId', type: 'UUID', nullable: false, note: null },
        { name: 'amount', type: 'decimal', nullable: false, note: null },
        { name: 'currency', type: 'string(3)', nullable: false, note: null },
        { name: 'method', type: 'enum(CARD,WALLET,GIFT_CARD)', nullable: false, note: null },
        { name: 'idempotencyKey', type: 'string', nullable: false, note: null },
      ],
      response: [
        { name: 'paymentId', type: 'UUID', nullable: false, note: null },
        { name: 'status', type: 'enum(AUTHORIZED,CAPTURED,FAILED)', nullable: false, note: null },
        { name: 'authorizedAt', type: 'timestamp', nullable: true, note: null },
        { name: 'gatewayRef', type: 'string', nullable: true, note: null },
      ],
    },
    {
      id: 'ep1',
      kind: 'rest',
      service: 'PaymentService',
      verb: 'POST',
      path: '/payments/{id}/refund',
      source: 'in-code DTO (Feign)',
      confidence: 'confirmed',
      method: 'FeignClient',
      unresolved: false,
      callers: ['RefundService'],
      request: [
        { name: 'amount', type: 'decimal', nullable: false, note: null },
        { name: 'reason', type: 'string', nullable: true, note: null },
      ],
      response: [
        { name: 'refundId', type: 'UUID', nullable: false, note: null },
        { name: 'status', type: 'enum(PENDING,REFUNDED,FAILED)', nullable: false, note: null },
      ],
    },
    {
      id: 'ep2',
      kind: 'rest',
      service: 'CatalogService',
      verb: 'GET',
      path: '/catalog/items/{id}',
      source: 'in-code DTO (Feign)',
      confidence: 'confirmed',
      method: 'FeignClient',
      unresolved: false,
      callers: ['CheckoutOrchestrator'],
      request: [],
      response: [
        { name: 'itemId', type: 'UUID', nullable: false, note: null },
        { name: 'name', type: 'string', nullable: false, note: null },
        { name: 'priceMinor', type: 'int', nullable: false, note: null },
        { name: 'currency', type: 'string(3)', nullable: false, note: null },
        { name: 'inStock', type: 'boolean', nullable: false, note: null },
      ],
    },
    {
      id: 'ep3',
      kind: 'rest',
      service: 'PricingService',
      verb: 'POST',
      path: '/pricing/quote',
      source: 'in-code DTO (WebClient)',
      confidence: 'likely',
      method: 'WebClient',
      unresolved: false,
      callers: ['CheckoutOrchestrator'],
      request: [
        { name: 'items', type: 'array<LineItem>', nullable: false, note: null },
        { name: 'currency', type: 'string(3)', nullable: false, note: null },
      ],
      response: [
        { name: 'total', type: 'decimal', nullable: false, note: null },
        { name: 'breakdown', type: 'array<PriceComponent>', nullable: false, note: null },
      ],
    },
    {
      id: 'ep4',
      kind: 'rest',
      service: 'PromotionService',
      verb: 'POST',
      path: '/promotions/apply',
      source: 'in-code DTO (WebClient)',
      confidence: 'likely',
      method: 'WebClient',
      unresolved: false,
      callers: ['CheckoutOrchestrator'],
      request: [
        { name: 'basketId', type: 'UUID', nullable: false, note: null },
        { name: 'couponCode', type: 'string', nullable: true, note: 'added in c98d0aa' },
      ],
      response: [
        { name: 'discountMinor', type: 'int', nullable: false, note: null },
        { name: 'applied', type: 'boolean', nullable: false, note: null },
      ],
    },
    {
      id: 'ep5',
      kind: 'rest',
      service: 'FraudCheckService',
      verb: 'POST',
      path: '/fraud/check',
      source: 'in-code DTO (Feign)',
      confidence: 'confirmed',
      method: 'FeignClient',
      unresolved: false,
      callers: ['PaymentService'],
      request: [
        { name: 'paymentId', type: 'UUID', nullable: false, note: null },
        { name: 'amount', type: 'decimal', nullable: false, note: null },
        { name: 'customerId', type: 'UUID', nullable: false, note: null },
      ],
      response: [
        { name: 'decision', type: 'enum(ALLOW,REVIEW,DENY)', nullable: false, note: null },
        { name: 'score', type: 'decimal', nullable: false, note: null },
      ],
    },
    {
      id: 'ep6',
      kind: 'rest',
      service: 'CheckoutOrchestrator',
      verb: 'POST',
      path: '/checkout',
      source: 'OpenAPI spec',
      confidence: 'confirmed',
      method: 'route',
      unresolved: false,
      callers: ['ApiGateway'],
      request: [
        { name: 'basketId', type: 'UUID', nullable: false, note: null },
        { name: 'customerId', type: 'UUID', nullable: false, note: null },
      ],
      response: [
        { name: 'orderId', type: 'UUID', nullable: false, note: null },
        { name: 'status', type: 'enum(PLACED,REJECTED)', nullable: false, note: null },
      ],
    },
    {
      id: 'ep7',
      kind: 'rest',
      service: 'legacy-oms (unresolved)',
      verb: 'POST',
      path: '/legacy/orders',
      source: 'in-code (shape unresolved)',
      confidence: 'uncertain',
      method: 'RestTemplate',
      unresolved: true,
      callers: ['OrderService'],
      request: [
        { name: 'payload', type: 'object', nullable: false, note: 'shape best-effort — target unresolved' },
      ],
      response: [],
    },
  ],
  topics: [
    {
      id: 'tp0',
      kind: 'kafka',
      topic: 'OrderCreated',
      producer: 'OrderService',
      source: 'Schema Registry (Avro)',
      confidence: 'confirmed',
      consumers: ['StockReservationService', 'NotificationService', 'InventoryService', 'AnalyticsIngestService'],
      message: [
        { name: 'orderId', type: 'UUID', nullable: false, note: null },
        { name: 'customerId', type: 'UUID', nullable: false, note: null },
        { name: 'total', type: 'decimal', nullable: false, note: null },
        { name: 'couponCode', type: 'string', nullable: true, note: 'added in c98d0aa' },
      ],
    },
    {
      id: 'tp1',
      kind: 'kafka',
      topic: 'PaymentAuthorized',
      producer: 'PaymentService',
      source: 'Schema Registry (Avro)',
      confidence: 'confirmed',
      consumers: ['NotificationService', 'OrderService'],
      message: [
        { name: 'paymentId', type: 'UUID', nullable: false, note: null },
        { name: 'orderId', type: 'UUID', nullable: false, note: null },
        { name: 'authorizedAt', type: 'timestamp', nullable: false, note: null },
      ],
    },
    {
      id: 'tp2',
      kind: 'kafka',
      topic: 'PaymentCaptured',
      producer: 'PaymentService',
      source: 'no registered schema',
      confidence: 'likely',
      consumers: ['AnalyticsIngestService'],
      message: [
        { name: 'paymentId', type: 'UUID', nullable: false, note: null },
        { name: 'amountMinor', type: 'int', nullable: false, note: null },
        { name: 'capturedAt', type: 'timestamp', nullable: false, note: null },
      ],
    },
    {
      id: 'tp3',
      kind: 'kafka',
      topic: 'InventoryLow',
      producer: null,
      source: 'no registered schema',
      confidence: 'uncertain',
      consumers: ['NotificationService'],
      message: [],
    },
  ],
};

export const commits: CommitDto[] = [
  {
    sha: 'a3f19c2',
    author: { name: 'Priya Nair', handle: 'priyan' },
    message: 'checkout: apply basket-level promotions',
    when: '2026-07-13T12:00:00Z',
    pr: '#1847',
    branch: 'feat/basket-promos',
    changes: [
      {
        op: 'add',
        kind: 'dependency',
        from: 'CheckoutOrchestrator',
        to: 'PromotionService',
        protocol: 'rest',
        confidence: 'likely',
        contract: 'POST /promotions/apply',
        detail: 'New WebClient call — target resolved from a base-URL property, so recorded as likely.',
      },
      {
        op: 'add',
        kind: 'endpoint',
        from: 'PromotionService',
        to: null,
        protocol: 'rest',
        confidence: 'likely',
        contract: 'POST /promotions/apply',
        detail: 'Endpoint first seen this commit.',
      },
    ],
  },
  {
    sha: 'c98d0aa',
    author: { name: 'Marco Silva', handle: 'marcos' },
    message: 'orders: add couponCode to OrderCreated and promotions apply',
    when: '2026-07-12T09:15:00Z',
    pr: '#1834',
    branch: 'feat/coupon-code',
    changes: [
      {
        op: 'change',
        kind: 'schema',
        from: 'OrderService',
        to: null,
        protocol: 'kafka',
        confidence: 'confirmed',
        contract: 'OrderCreated',
        detail: 'Field added: couponCode : string (nullable).',
      },
      {
        op: 'change',
        kind: 'schema',
        from: 'PromotionService',
        to: null,
        protocol: 'rest',
        confidence: 'likely',
        contract: 'POST /promotions/apply',
        detail: 'Field added: couponCode : string (nullable).',
      },
    ],
  },
  {
    sha: 'b2c3d4e',
    author: { name: 'Aisha Khan', handle: 'aishak' },
    message: 'payments: register PaymentAuthorized Avro schema',
    when: '2026-07-11T16:40:00Z',
    pr: '#1820',
    branch: 'feat/avro-payauth',
    changes: [
      {
        op: 'confidence',
        kind: 'confidence',
        from: 'PaymentService',
        to: 'NotificationService',
        protocol: 'kafka',
        confidence: 'confirmed',
        contract: 'PaymentAuthorized',
        detail: 'Confidence raised likely → confirmed after the Avro schema was registered.',
      },
    ],
  },
  {
    sha: 'a1b2c3d',
    author: { name: 'Priya Nair', handle: 'priyan' },
    message: 'payments: route fraud check through PaymentService',
    when: '2026-07-10T08:00:00Z',
    pr: '#1799',
    branch: 'feat/fraud-routing',
    changes: [
      {
        op: 'add',
        kind: 'dependency',
        from: 'PaymentService',
        to: 'FraudCheckService',
        protocol: 'rest',
        confidence: 'confirmed',
        contract: 'POST /fraud/check',
        detail: 'New @FeignClient interface with a declared target.',
      },
      {
        op: 'remove',
        kind: 'dependency',
        from: 'CheckoutOrchestrator',
        to: 'FraudCheckService',
        protocol: 'rest',
        confidence: 'uncertain',
        contract: 'POST /fraud/check',
        detail: 'Direct RestTemplate call removed; fraud check now goes through PaymentService.',
      },
    ],
  },
];
