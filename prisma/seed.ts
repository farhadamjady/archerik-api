/**
 * Seeds ONLY the auth fixtures needed for local dev:
 *   - a demo login (email/password), and
 *   - the extractor's API key + entitled account,
 * so the CLI can authenticate against /v1/* out of the box.
 *
 * No graph/contract/commit data is seeded — the read model is built entirely from what the
 * extractor sends to /v1/ingest. Idempotent: re-running refreshes credentials in place.
 */

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';

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
const DEMO_ACCOUNT = { name: 'Acme (demo)', plan: 'mvp', quotaRemaining: 1000000 };
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

async function main(): Promise<void> {
  // The account (company) is the read-model scope. Create it first, then bind the demo dev to it —
  // the same account the extractor ingests under, so the dev sees exactly what was scanned.
  const accountId = await seedExtractorAccount();
  await seedDemoUser(accountId);

  // eslint-disable-next-line no-console
  console.log(`Demo login: ${DEMO_USER.email} / ${DEMO_USER.password}`);
  // eslint-disable-next-line no-console
  console.log(`Extractor API key (Bearer): ${DEMO_API_KEY}`);
  // eslint-disable-next-line no-console
  console.log('No graph seeded — POST a service to /v1/ingest to populate the read model.');
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
