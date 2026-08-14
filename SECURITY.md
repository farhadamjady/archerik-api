# Security Policy — Archerik API

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue.

Use [GitHub's private vulnerability reporting][advisory] on this repository, or
email <farhadamjadytoosi@gmail.com> with the details.

[advisory]: https://github.com/farhadamjady/archerik-api/security/advisories/new

Please include what you did, what happened, and what you expected. A failing
`curl` against a locally seeded instance is the most useful thing you can send.
You can expect an initial response within a week.

## Supported versions

The latest release on the default branch is supported. Fixes are not
backported.

## What this service holds

This is the component of Archerik that stores data, so the trust boundary
matters:

- **Architecture metadata, not source code.** Baselines contain endpoint paths,
  dependency targets, topic names, and declared type structures — what the
  extractor derived, never the files it read. Note that a scanned repository's
  *config values* can themselves contain secrets, and resolved values may appear
  in a submitted graph. Treat the database with the same care as the
  repositories it describes.
- **Two classes of credential, stored two different ways.** Credentials
  presented *to* this service — extractor API keys, session tokens, user
  passwords — are hashed (SHA-256; bcrypt for passwords), because the server only
  ever compares them, so a database dump cannot be replayed. Credentials this
  service presents *onward* — OIDC client secrets, LLM provider keys — are
  encrypted with AES-256-GCM, because they must be recoverable to be sent
  upstream.
- **Two separate encryption keys.** `SSO_ENCRYPTION_KEY` and `LLM_ENCRYPTION_KEY`
  are deliberately distinct variables so one leaked key does not unlock both
  classes of secret. Neither has a default: the process refuses to start if
  either is missing or is not 32 bytes. A shipped default would mean every
  deployment that never set one shares a key published in this repository.
- **Provider keys are never returned.** `GET /settings/llm-keys` serves a
  denormalised `last4` and a configured flag, so that read path never loads the
  encryption key or holds a plaintext key in memory. No endpoint returns the key
  itself.
- **Errors do not echo upstream bodies.** LLM provider failures are classified
  by HTTP status and re-worded server-side (`src/llm/llm-errors.ts`); the SDK's
  own message is logged, never returned, because a provider error payload can
  quote the offending request.
- **The two API surfaces do not cross.** A session token is rejected at `/v1/*`
  and an extractor API key is rejected at `/api/v1/*`, so a leaked CI key cannot
  read a user's catalog and a stolen session cannot forge scan data.
- **SSO start does not enumerate tenants.** `POST /api/v1/auth/sso/start`
  returns the same response shape whether a domain has SSO configured, has it
  disabled, or is unknown.

## Deploying this safely

The defaults are tuned for a laptop, not the internet. Before exposing an
instance:

- **Set `CORS_ORIGINS`.** It defaults to `*`, which is a development
  convenience.
- **Terminate TLS in front of the service.** It speaks plain HTTP, and bearer
  credentials cross the wire on every request.
- **Generate fresh encryption keys** into a secret manager rather than a `.env`
  on disk. Losing them means re-entering every stored SSO client secret and
  provider key.
- **Do not run the seed.** `prisma db seed` creates a known password and a known
  API key for local development.
- **Change the database credentials.** The Compose file ships
  `archerik:archerik` for local use only.

## Known dependency advisories

`npm audit` currently reports advisories whose only available fix is a major
upgrade of NestJS (10 → 11) and its toolchain. Most are in development-only
tooling (`@nestjs/cli`, `webpack`, `inquirer`, `@angular-devkit/*`), which is not
installed by `npm ci --omit=dev` and never runs in production. The upgrade is
tracked as follow-up work rather than being applied blind during a release; if
you are deploying this, run `npm audit --omit=dev` yourself and make your own
call.

## Not vulnerabilities

- **The catalog being incomplete or wrong.** That is a correctness bug — please
  open a normal issue.
- **Quota not being enforced as a billing control.** `quota_remaining` is a
  placeholder integer with no billing integration behind it.
- **Any member of an account being able to write that account's provider keys.**
  There is no role model on `User` yet; this is a documented limitation, not a
  bypass.

Reports involving tenant isolation (reading another account's catalog),
authentication bypass, secret disclosure, or SQL/prompt injection through
ingested data are in scope and welcome.
