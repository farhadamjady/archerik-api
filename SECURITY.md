# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than in a public issue.

Use GitHub's [private vulnerability reporting](https://github.com/farhadamjady/service-discovery-backend-chore/security/advisories/new)
on this repository. Include what you found, how to reproduce it, and what an attacker could do with
it. You'll get an acknowledgement, and I'll let you know the fix timeline once I've reproduced it.

Please don't disclose publicly until a fix is available.

This is an early-stage project maintained in spare time — expect a best-effort response, not an
enterprise SLA.

## Supported versions

The `main` branch only. There are no maintained release branches yet.

## Security model

Some context on how the service is meant to behave, so you can tell a bug from a design decision.

**Two credential types that don't cross.** Long-lived API keys authenticate CI at `/v1/*`;
short-lived session tokens authenticate humans at `/api/v1/*`. A session token is rejected at `/v1`
and an API key at `/api/v1`. A leaked CI key must not read a user's catalog, and a stolen session
must not forge scan data. **A crossover is a vulnerability — please report it.**

**Hashed vs. encrypted is intentional.** Credentials presented *to* this service (API keys, session
tokens) are stored as SHA-256 hashes — we only ever compare them, and a database dump can't be
replayed. Credentials this service presents *onward* (OIDC client secrets, LLM provider keys) are
AES-256-GCM encrypted, because they must be recoverable. Passwords are bcrypt-hashed.

**Encryption keys fail closed.** `SSO_ENCRYPTION_KEY` and `LLM_ENCRYPTION_KEY` have no defaults; the
application refuses to start without them, rather than falling back to a value published in this
repository. They're deliberately separate variables so one leak doesn't unlock both classes of
secret.

**Tenant isolation.** All read data is scoped to the account derived from the session token, never
from a client-supplied parameter. **Any path that lets one account observe another's data is a
vulnerability**, including through error messages, timing, or the Ask tool loop.

**Provider keys are never returned.** No endpoint echoes a stored LLM key. Status reads serve a
denormalised `last4` specifically so that path never decrypts.

**No account enumeration.** `POST /auth/sso/start` returns the same shape whether a domain has SSO
configured, disabled, or absent, and login failures are generic. A response that distinguishes these
is a bug.

**Ask cannot cite what doesn't exist.** Citations are rendered from a server-side evidence ledger,
not from model output. A path that gets unverified model text into `cites`, or that lets the tool
loop read outside the requesting account, is a vulnerability.

## Known limitations

Not vulnerabilities — documented gaps:

- **No role model.** Every member of an account can read and write that account's LLM provider keys.
- **The seed creates known credentials** (`demo@acme.com` / `demo1234`, API key
  `ekg_dev_local_demokey`). It is for local development only. Never run it against a deployment.
- **Plain HTTP.** The service expects TLS termination in front of it; bearer credentials cross the
  wire on every request.
- **`CORS_ORIGINS` defaults to `*`** as a development convenience. Set it in production.
- **Quota is a placeholder integer** with no billing enforcement behind it.
