#!/usr/bin/env node
// Truncate the Cartograph backend's SCAN data while preserving AUTH, so the account is
// ready for a fresh scan/test without breaking the extractor key or the demo login.
//
// Deletes (in FK-safe order): Contract, Commit, Graph, ServiceBaseline, Scan.
// Keeps:                       Account, User, ApiKey, Session, LlmProviderKey.
//
// After a truncate the extractor key (`ekg_dev_local_demokey`), the demo login
// (demo@acme.com / demo1234), and the account's LLM provider keys still work; the read
// model is the empty state until the next ingest reprojects it.
//
// LlmProviderKey is account config, not scan data — the same category as the extractor
// key — so a reset must not force re-entering Anthropic/OpenAI keys in Settings → LLM.
// Under --scope=all it goes anyway, via the Account cascade.
//
// SAFETY: refuses to run unless --yes (or TRUNCATE_YES=1) is passed, since it is a
// destructive, irreversible delete of all scan data.
//
// No external deps beyond the project's own @prisma/client.
// Env overrides: none required. Flags: --yes (required), --scope=all (also wipe auth).

import { PrismaClient } from '@prisma/client';

const argv = new Set(process.argv.slice(2));
const confirmed = argv.has('--yes') || process.env.TRUNCATE_YES === '1';
const wipeAuth = argv.has('--scope=all');

if (!confirmed) {
  console.error(
    'Refusing to truncate without confirmation.\n' +
      '  node .claude/skills/truncate-cartograph-db/truncate.mjs --yes\n' +
      '  (add --scope=all to ALSO delete accounts/users/api keys/sessions)',
  );
  process.exit(2);
}

const prisma = new PrismaClient();

async function main() {
  // FK-safe order: Contract & Commit reference Graph; delete them before Graph.
  const contracts = await prisma.contract.deleteMany({});
  const commits = await prisma.commit.deleteMany({});
  const graphs = await prisma.graph.deleteMany({});
  const baselines = await prisma.serviceBaseline.deleteMany({});
  const scans = await prisma.scan.deleteMany({});

  const deleted = {
    contracts: contracts.count,
    commits: commits.count,
    graphs: graphs.count,
    baselines: baselines.count,
    scans: scans.count,
  };

  let auth = null;
  if (wipeAuth) {
    // Session -> User/Account, ApiKey -> Account: delete leaves before roots.
    const sessions = await prisma.session.deleteMany({});
    const apiKeys = await prisma.apiKey.deleteMany({});
    const users = await prisma.user.deleteMany({});
    const accounts = await prisma.account.deleteMany({});
    auth = {
      sessions: sessions.count,
      apiKeys: apiKeys.count,
      users: users.count,
      accounts: accounts.count,
    };
  }

  const kept = {
    accounts: await prisma.account.count(),
    users: await prisma.user.count(),
    apiKeys: await prisma.apiKey.count(),
    sessions: await prisma.session.count(),
    llmKeys: await prisma.llmProviderKey.count(),
  };

  console.log('deleted (scan data):', JSON.stringify(deleted));
  if (auth) console.log('deleted (auth):', JSON.stringify(auth));
  console.log('kept:', JSON.stringify(kept));
  if (!wipeAuth && kept.accounts > 0) {
    console.log('\nExtractor key, demo login + LLM provider keys preserved. Ready for a new scan.');
  }
}

main()
  .catch((e) => {
    console.error('TRUNCATE ERROR:', e?.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
