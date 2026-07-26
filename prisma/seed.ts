/**
 * Seeds the local-dev fixtures:
 *   - a demo login (email/password),
 *   - the extractor's API key + entitled account, and
 *   - a small demo read model (the `acme/shop-platform` fleet) for that account.
 *
 * The graph is seeded exactly the way a real ingest builds it — service baselines projected through
 * `projectReadModel` into one account-scoped Graph (+ Contract) row per branch — so the read
 * endpoints serve real data out of the box and stay faithful to the account-scoped model (repo is a
 * filter, not the scope). Idempotent: re-running refreshes credentials and rebuilds the demo graph.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { validateContracts, validateGraph } from '../src/common/integrity';
import { ServiceBody } from '../src/ingest/model';
import { ParsedService, projectReadModel } from '../src/ingest/project';

const prisma = new PrismaClient();

// Demo login for local dev — email/password shown in the seed output and README.
const DEMO_USER = {
  email: 'demo@acme.com',
  password: 'demo1234',
  name: 'Priya Nair',
  handle: 'priyan',
  team: 'payments',
};

async function seedDemoUser(accountId: string): Promise<void> {
  const passwordHash = await bcrypt.hash(DEMO_USER.password, 10);
  await prisma.user.upsert({
    where: { email: DEMO_USER.email },
    update: {
      passwordHash,
      name: DEMO_USER.name,
      handle: DEMO_USER.handle,
      team: DEMO_USER.team,
      accountId,
    },
    create: {
      accountId,
      email: DEMO_USER.email,
      passwordHash,
      name: DEMO_USER.name,
      handle: DEMO_USER.handle,
      team: DEMO_USER.team,
    },
  });
}

// Demo extractor credentials for local dev — a fixed API key so the CLI can hit /v1/* out of the box.
// maxServices is the pricing-tier service cap; the demo uses the higher (75) tier so local scans of
// a realistic fleet aren't blocked at the entry limit. An admin sets this per account in production.
const DEMO_ACCOUNT = { name: 'Acme (demo)', plan: 'mvp', quotaRemaining: 1000000, maxServices: 75 };
const DEMO_API_KEY = 'ekg_dev_local_demokey';

async function seedExtractorAccount(): Promise<string> {
  const keyHash = createHash('sha256').update(DEMO_API_KEY).digest('hex');
  // Entitlement good for a year from seed time.
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  // Account has no natural business key; resolve it via the (unique) API key hash. Re-seeding
  // refreshes the entitlement and un-revokes the key without creating duplicate accounts.
  const existing = await prisma.apiKey.findUnique({ where: { keyHash } });
  const account = existing
    ? await prisma.account.update({
        where: { id: existing.accountId },
        data: { ...DEMO_ACCOUNT, expiresAt },
      })
    : await prisma.account.create({ data: { ...DEMO_ACCOUNT, expiresAt } });

  await prisma.apiKey.upsert({
    where: { keyHash },
    update: { revokedAt: null, accountId: account.id },
    create: { keyHash, accountId: account.id, label: 'local dev' },
  });
  return account.id;
}

// --- Demo read model: the `acme/shop-platform` fleet on `main` ---------------------------------
// One Service body per module, in the exact shape the extractor POSTs to /v1/ingest. Kept small but
// representative: confirmed/likely/uncertain edges, an external target, a runtime-URL unknown, and
// two Kafka topics — enough to exercise every branch of the projection.

const DEMO_REPO = 'acme/shop-platform';
const DEMO_BRANCH = 'main';

const DEMO_FLEET: Array<{
  serviceId: string;
  serviceName: string;
  language: string;
  body: ServiceBody;
}> = [
  {
    serviceId: 'checkout-orchestrator',
    serviceName: 'CheckoutOrchestrator',
    language: 'Java',
    body: {
      service_id: 'checkout-orchestrator',
      service_name: 'CheckoutOrchestrator',
      repository: DEMO_REPO,
      endpoints: [
        {
          method: 'POST',
          path: '/checkout',
          protocol: 'rest',
          detection: 'FeignClient',
          confidence: 'confirmed',
        },
      ],
      outbound_dependencies: [
        // Declared Feign client → resolves to a scanned service, confirmed.
        {
          target_name: 'payment-service',
          protocol: 'rest',
          detection: 'FeignClient',
          confidence: 'confirmed',
        },
        // RestTemplate to a runtime host that isn't a scanned service → unknown node, uncertain.
        {
          target_name: 'http://pricing-svc:8080/quote',
          url: 'http://pricing-svc:8080/quote',
          protocol: 'rest',
          detection: 'RestTemplate',
          confidence: 'uncertain',
          resolved: false,
        },
      ],
      kafka_producers: [],
      kafka_consumers: [],
      databases_used: [],
      config_dependencies: [],
    },
  },
  {
    serviceId: 'payment-service',
    serviceName: 'PaymentService',
    language: 'Java',
    body: {
      service_id: 'payment-service',
      service_name: 'PaymentService',
      repository: DEMO_REPO,
      endpoints: [
        {
          method: 'POST',
          path: '/payments',
          protocol: 'rest',
          detection: 'FeignClient',
          confidence: 'confirmed',
          request: {
            type: 'object',
            nested: [
              { name: 'orderId', type: 'UUID', required: 'required' },
              { name: 'amount', type: 'decimal', required: 'required' },
              { name: 'currency', type: 'string(3)', required: 'required' },
            ],
          },
          response: {
            type: 'object',
            nested: [
              { name: 'paymentId', type: 'UUID', required: 'required' },
              { name: 'status', type: 'enum(AUTHORIZED,CAPTURED,FAILED)', required: 'required' },
              { name: 'gatewayRef', type: 'string', required: 'optional' },
            ],
          },
        },
      ],
      outbound_dependencies: [
        // WebClient to a third-party host → external node, likely (base URL from config).
        {
          target_name: 'https://api.stripe.com/v1/charges',
          url: 'https://api.stripe.com/v1/charges',
          protocol: 'rest',
          detection: 'WebClient',
          confidence: 'likely',
        },
      ],
      kafka_producers: [
        {
          topic: 'PaymentAuthorized',
          protocol: 'kafka',
          detection: 'KafkaTemplate',
          confidence: 'confirmed',
          schema: {
            type: 'object',
            nested: [
              { name: 'paymentId', type: 'UUID', required: 'required' },
              { name: 'orderId', type: 'UUID', required: 'required' },
            ],
          },
        },
      ],
      kafka_consumers: [],
      databases_used: [],
      config_dependencies: [],
    },
  },
  {
    serviceId: 'order-service',
    serviceName: 'OrderService',
    language: 'Kotlin',
    body: {
      service_id: 'order-service',
      service_name: 'OrderService',
      repository: DEMO_REPO,
      endpoints: [
        {
          method: 'GET',
          path: '/orders/{id}',
          protocol: 'rest',
          detection: 'FeignClient',
          confidence: 'confirmed',
        },
      ],
      outbound_dependencies: [
        {
          target_name: 'payment-service',
          protocol: 'rest',
          detection: 'FeignClient',
          confidence: 'confirmed',
        },
      ],
      kafka_producers: [
        {
          topic: 'OrderCreated',
          protocol: 'kafka',
          detection: 'KafkaTemplate',
          confidence: 'confirmed',
          schema: {
            type: 'object',
            nested: [
              { name: 'orderId', type: 'UUID', required: 'required' },
              { name: 'customerId', type: 'UUID', required: 'required' },
            ],
          },
        },
      ],
      kafka_consumers: [
        {
          topic: 'PaymentAuthorized',
          protocol: 'kafka',
          detection: '@KafkaListener',
          confidence: 'confirmed',
        },
      ],
      databases_used: [],
      config_dependencies: [],
    },
  },
];

/**
 * Seeds the demo read model the account-scoped way: store each Service body as a baseline, then
 * project the whole fleet into one Graph (+ Contract rows) for (account, branch) — the same code
 * path `reprojectAccount` runs on ingest. Idempotent: clears the demo repo's baselines and the
 * branch graph first. Validates the projection against the UI's integrity rules and throws on a
 * violation, so the seed can never ship a payload the UI would reject.
 */
async function seedDemoGraph(accountId: string): Promise<void> {
  await prisma.serviceBaseline.deleteMany({
    where: { accountId, repository: DEMO_REPO, defaultBranch: DEMO_BRANCH },
  });
  await prisma.graph.deleteMany({ where: { accountId, branch: DEMO_BRANCH } });

  const services: ParsedService[] = [];
  for (const svc of DEMO_FLEET) {
    await prisma.serviceBaseline.create({
      data: {
        accountId,
        repository: DEMO_REPO,
        serviceId: svc.serviceId,
        serviceName: svc.serviceName,
        language: svc.language,
        defaultBranch: DEMO_BRANCH,
        sha: 'seed0000',
        body: Buffer.from(JSON.stringify(svc.body)),
      },
    });
    services.push({
      serviceId: svc.serviceId,
      serviceName: svc.serviceName,
      language: svc.language,
      repo: DEMO_REPO,
      body: svc.body,
    });
  }

  const { graph, contracts } = projectReadModel(services);

  const graphErrors = validateGraph({
    repo: DEMO_REPO,
    branch: DEMO_BRANCH,
    scannedAt: null,
    ...graph,
  });
  const contractErrors = validateContracts(contracts);
  if (graphErrors.length || contractErrors.length) {
    throw new Error(
      `Seed projection failed integrity: ${[...graphErrors, ...contractErrors].join('; ')}`,
    );
  }

  const created = await prisma.graph.create({
    data: {
      accountId,
      branch: DEMO_BRANCH,
      commitSha: 'HEAD',
      scannedAt: new Date(),
      data: graph as unknown as Prisma.InputJsonValue,
    },
  });
  await prisma.contract.createMany({
    data: [
      ...contracts.endpoints.map((e) => ({
        graphId: created.id,
        kind: 'rest',
        data: e as unknown as Prisma.InputJsonValue,
      })),
      ...contracts.topics.map((t) => ({
        graphId: created.id,
        kind: 'kafka',
        data: t as unknown as Prisma.InputJsonValue,
      })),
    ],
  });
}

async function main(): Promise<void> {
  // The account (company) is the read-model scope. Create it first, then bind the demo dev to it —
  // the same account the extractor ingests under, so the dev sees exactly what was scanned.
  const accountId = await seedExtractorAccount();
  await seedDemoUser(accountId);
  await seedDemoGraph(accountId);

  // eslint-disable-next-line no-console
  console.log(`Demo login: ${DEMO_USER.email} / ${DEMO_USER.password}`);
  // eslint-disable-next-line no-console
  console.log(`Extractor API key (Bearer): ${DEMO_API_KEY}`);
  // eslint-disable-next-line no-console
  console.log(
    `Seeded demo graph: ${DEMO_FLEET.length} services in ${DEMO_REPO} on ${DEMO_BRANCH}.`,
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
