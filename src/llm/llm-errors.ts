import { HttpException, HttpStatus } from '@nestjs/common';
import { LlmFailureKind, LlmProviderError } from './provider.types';
import { LlmProviderId, PROVIDER_LABELS } from './providers';

/**
 * Translating provider failures into HTTP, without leaking anything.
 *
 * Two rules:
 *
 * 1. **Never echo the upstream body.** Provider error payloads can quote the offending request,
 *    and every string here is rendered verbatim in the user's Ask bubble. The messages below are
 *    written by us; the SDK's own message is logged server-side and never returned.
 * 2. **Never fabricate an answer.** Every failure becomes a 4xx/5xx with an `error` string
 *   , never a plausible-looking response.
 */

/**
 * Classifies an unknown SDK error by HTTP status rather than by exception class. Both SDKs expose
 * `status` on their error types, and matching on that avoids depending on two separate sets of
 * class names that version independently.
 */
export function classifyProviderError(err: unknown, provider: LlmProviderId): LlmProviderError {
  if (err instanceof LlmProviderError) return err;

  const label = PROVIDER_LABELS[provider];
  const status = extractStatus(err);

  if (status === 401 || status === 403) {
    return new LlmProviderError(
      'rejected',
      provider,
      `the stored ${label} key was rejected — update it in Settings → LLM`,
    );
  }
  if (status === 429) {
    return new LlmProviderError(
      'rate_limited',
      provider,
      `${label} rate-limited this request — try again shortly`,
    );
  }
  if (isTimeout(err)) {
    return new LlmProviderError('timeout', provider, `the request to ${label} timed out`);
  }
  if (status !== undefined && status >= 500) {
    return new LlmProviderError('unavailable', provider, `${label} is unavailable right now`);
  }
  return new LlmProviderError('unavailable', provider, `the request to ${label} failed`);
}

/** Maps a classified failure onto the status code the UI expects for it. */
export function toHttpException(err: LlmProviderError): HttpException {
  const body = { error: err.message };
  const status: Record<LlmFailureKind, HttpStatus> = {
    // 502, not 409: 409 is reserved for "no key configured at all", so the UI can tell the two
    // apart. Both messages point at Settings → LLM, which is the fix in either case.
    rejected: HttpStatus.BAD_GATEWAY,
    rate_limited: HttpStatus.TOO_MANY_REQUESTS,
    unavailable: HttpStatus.SERVICE_UNAVAILABLE,
    timeout: HttpStatus.GATEWAY_TIMEOUT,
    refused: HttpStatus.BAD_GATEWAY,
  };
  return new HttpException(body, status[err.kind]);
}

/** A concise, key-free description for server logs. Never returned to the client. */
export function describeForLog(err: unknown): string {
  const status = extractStatus(err);
  const name = err instanceof Error ? err.name : typeof err;
  return status === undefined ? name : `${name} (HTTP ${status})`;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function isTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' && /timeout/i.test(name);
}
