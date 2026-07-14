/**
 * Seeds the demo dataset for acme/shop-platform@main.
 *
 * Runs the same integrity checks the UI enforces BEFORE touching the DB — if the demo data has a
 * dangling edge or a bad enum, the seed fails loudly instead of shipping a payload that would break
 * the UI. Idempotent: re-running replaces the graph (and its cascaded contracts/commits).
 */

import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import {
  validateCommits,
  validateContracts,
  validateGraph,
} from '../src/common/integrity';
import { BRANCH, COMMIT_SHA, REPO, SCANNED_AT, commits, contracts, graph } from './demo-data';

const prisma = new PrismaClient();

// Demo login for local dev — email/password shown in the seed output and README.
const DEMO_USER = {
  email: 'demo@acme.com',
  password: 'demo1234',
  name: 'Priya Nair',
  handle: 'priyan',
  team: 'payments',
};

async function seedDemoUser(): Promise<void> {
  const passwordHash = await bcrypt.hash(DEMO_USER.password, 10);
  await prisma.user.upsert({
    where: { email: DEMO_USER.email },
    update: { passwordHash, name: DEMO_USER.name, handle: DEMO_USER.handle, team: DEMO_USER.team },
    create: {
      email: DEMO_USER.email,
      passwordHash,
      name: DEMO_USER.name,
      handle: DEMO_USER.handle,
      team: DEMO_USER.team,
    },
  });
}

// Demo extractor credentials for local dev — a fixed API key so the CLI can hit /v1/* out of the box.
const DEMO_ACCOUNT = { name: 'Acme (demo)', plan: 'mvp', quotaRemaining: 1000000 };
const DEMO_API_KEY = 'ekg_dev_local_demokey';

async function seedExtractorAccount(): Promise<void> {
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
}

function assertValid(): void {
  const errors = [
    ...validateGraph(graph),
    ...validateContracts(contracts),
    ...validateCommits(commits),
  ];
  if (errors.length > 0) {
    throw new Error(`Demo dataset failed integrity checks:\n  - ${errors.join('\n  - ')}`);
  }
}

async function main(): Promise<void> {
  assertValid();

  await seedDemoUser();
  await seedExtractorAccount();

  // Idempotent: wipe any existing graph for this (repo, branch, commit); cascades to contracts/commits.
  await prisma.graph.deleteMany({ where: { repo: REPO, branch: BRANCH, commitSha: COMMIT_SHA } });

  const created = await prisma.graph.create({
    data: {
      repo: REPO,
      branch: BRANCH,
      commitSha: COMMIT_SHA,
      scannedAt: new Date(SCANNED_AT),
      // Graph payload holds only teams/nodes/edges; repo/branch/scannedAt live on the row.
      data: { teams: graph.teams, nodes: graph.nodes, edges: graph.edges } as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.contract.createMany({
    data: [
      ...contracts.endpoints.map((ep) => ({
        graphId: created.id,
        kind: 'rest',
        data: ep as unknown as Prisma.InputJsonValue,
      })),
      ...contracts.topics.map((tp) => ({
        graphId: created.id,
        kind: 'kafka',
        data: tp as unknown as Prisma.InputJsonValue,
      })),
    ],
  });

  await prisma.commit.createMany({
    data: commits.map((c) => ({
      graphId: created.id,
      commitSha: c.sha,
      authorName: c.author.name,
      authorHandle: c.author.handle ?? null,
      authorEmail: null,
      message: c.message,
      pr: c.pr,
      branch: c.branch,
      when: new Date(c.when),
      changes: c.changes as unknown as Prisma.InputJsonValue,
    })),
  });

  const counts = {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    endpoints: contracts.endpoints.length,
    topics: contracts.topics.length,
    commits: commits.length,
  };
  // eslint-disable-next-line no-console
  console.log(`Seeded ${REPO}@${BRANCH} (${COMMIT_SHA}):`, counts);
  // eslint-disable-next-line no-console
  console.log(`Demo login: ${DEMO_USER.email} / ${DEMO_USER.password}`);
  // eslint-disable-next-line no-console
  console.log(`Extractor API key (Bearer): ${DEMO_API_KEY}`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
