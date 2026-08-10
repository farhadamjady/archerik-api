# Contributing

Thanks for taking an interest. This document covers getting a working environment, the conventions
this codebase follows, and what makes a pull request easy to merge.

## Getting set up

```bash
npm install
cp .env.example .env
echo "SSO_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "LLM_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "LLM_VERIFY_KEYS=false" >> .env      # no egress needed for development or tests

docker compose up -d db
npx prisma migrate dev
npx prisma db seed
npm run start:dev
```

Before pushing:

```bash
npm run typecheck
npm run lint
npm run test:e2e
```

The e2e suite needs Postgres running and the seed loaded — it boots the real app against a real
database. It needs no live credentials of any kind: SSO runs against a mock IdP, and Ask runs
against a stub provider.

## Read this first

[`CLAUDE.md`](./CLAUDE.md) is the architectural orientation — what the service is, how a request
flows through it, and **§6, the ten invariants that must not break.** Those aren't style preferences;
several of them are enforced at runtime by `src/common/integrity.ts` and a violation fails a client's
whole page load. Read them before touching `src/ingest/` or `src/common/`.

The two contract documents are authoritative for wire shapes and win over any other doc:

- [`API-CONTRACT.md`](./API-CONTRACT.md) — the read API (`/api/v1`)
- [`INGEST-CONTRACT.md`](./INGEST-CONTRACT.md) — the ingest API (`/v1`)

**A wire-shape change is a contract change.** Update the contract document in the same pull request,
and say so in the description. Clients validate strictly and fail loudly, which is a feature — it
means a silent shape drift becomes an obvious outage rather than a subtly wrong diagram.

## Conventions

**Formatting is not a discussion.** Prettier (single quotes, trailing commas, 100 columns) and
ESLint. Run `npm run lint` and let the tools decide.

**Comments explain *why*, not *what*.** The existing code leans heavily on this — you'll find
comments explaining why a baseline key includes `repository`, why `last4` is stored in the clear, why
the advisory lock exists. That's the house style: if a decision would look arbitrary or wrong to
someone reading it cold, write down the constraint that forced it. Don't narrate what the next line
obviously does.

**Keep pure things pure.** `src/ingest/graphdiff.ts` and `src/ingest/project.ts` take data and return
data — no database, no clock, no I/O. That's why the core is testable without infrastructure. If you
need to reach the database from one of them, the design is telling you the call belongs in the
service layer.

**Errors are user-facing strings.** Every non-2xx body is `{ "error": "<string>" }`, rendered
verbatim by clients. Write the message for the person who'll read it, and keep stack traces and
internal identifiers in the log where they belong.

**Stay factual.** No severity ratings, no "breaking change" labels, no advice — in API text, in the
PR-comment markdown, anywhere. The tool reports what it found; humans judge it. This is the project's
central design commitment and pull requests that erode it won't be merged.

**Uncertainty is data.** If detection fails, record that honestly — an `unknown` node with a note, a
lower confidence level, a `truncated: true`. Never drop the finding, and never round a guess up to a
fact to make output look tidier.

## Database changes

Schema changes need a migration, committed together:

```bash
npx prisma migrate dev --name what_changed
```

Migrations are ordered and shared, so never edit one that's already been committed — add a new one.

## Adding an LLM provider

Deliberately small: write an adapter implementing the interface in `src/llm/provider.types.ts`, add
an entry to `src/llm/model-registry.ts`, and add the provider id to the settings DTO enum. The
registry is the single source of truth for `GET /models`, so the id a user picks, the key that gets
loaded, and the model string sent upstream can't drift apart.

Pin the adapter's wire shape with a test in the style of `test/llm-providers.e2e-spec.ts`, which
points the real SDK at a local server rather than mocking the SDK itself.

## Pull requests

- One concern per PR. A refactor and a behaviour change in the same diff is two PRs.
- Say **why** in the description, not just what. The what is in the diff.
- Include tests for behaviour changes. Bug fixes should include the test that would have caught it.
- Call out anything that touches an invariant, a wire shape, or a stored-secret path explicitly.
- Green CI: typecheck, lint, and the e2e suite all pass.

## Reporting bugs

Include what you did, what you expected, what happened, and the smallest repro you can manage. For
ingest problems the service JSON that triggered it is worth more than any description — scrub it
first if it comes from a private codebase.

For security issues, please use the process in [`SECURITY.md`](./SECURITY.md) instead of a public
issue.
