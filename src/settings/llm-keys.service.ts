import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { decryptSecret, encryptSecret } from '../common/secret-box';
import { LlmClientFactory } from '../llm/llm-client.factory';
import { describeForLog } from '../llm/llm-errors';
import { LlmProviderError } from '../llm/provider.types';
import { isLlmProvider, LLM_PROVIDERS, LlmProviderId, PROVIDER_LABELS } from '../llm/providers';
import { PrismaService } from '../prisma/prisma.service';

/** Env var holding the 32-byte base64 key that encrypts provider keys at rest. */
export const LLM_KEY_ENV_VAR = 'LLM_ENCRYPTION_KEY';

/** A provider's configuration status. The raw key is NEVER part of this shape. */
export interface LlmKeyStatus {
  provider: LlmProviderId;
  configured: boolean;
  /** Last 4 characters, for recognition only. Present only when `configured`. */
  last4?: string;
  /** ISO-8601. Present only when `configured`. */
  updatedAt?: string;
}

/** Longest key we'll accept. Real provider keys are ~100-200 chars; this just blunts abuse. */
const MAX_KEY_LENGTH = 500;

/**
 * Account-scoped store for customer-supplied LLM provider keys (bring-your-own-key for the Ask tab).
 *
 * Two rules govern everything here:
 *
 * 1. **The raw key never leaves.** No method returns it, and the read path (`list`) is deliberately
 *    decrypt-free — it reads the denormalised `last4` column, so rendering the Settings tab never
 *    loads the encryption key or holds a plaintext key in memory.
 * 2. **Errors are user-facing.** Every rejection carries an `{ error }` body, because the UI renders
 *    that string verbatim on the provider card.
 */
@Injectable()
export class LlmKeysService {
  private readonly logger = new Logger(LlmKeysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: LlmClientFactory,
  ) {}

  /** Status for every known provider — configured or not. Never decrypts. */
  async list(accountId: string): Promise<LlmKeyStatus[]> {
    const rows = await this.prisma.llmProviderKey.findMany({
      where: { accountId },
      select: { provider: true, last4: true, updatedAt: true },
    });
    const byProvider = new Map(rows.map((r) => [r.provider, r]));

    return LLM_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      return row
        ? {
            provider,
            configured: true,
            last4: row.last4,
            updatedAt: row.updatedAt.toISOString(),
          }
        : { provider, configured: false };
    });
  }

  /**
   * Sets or replaces one provider's key. Returns the same status shape as `list`, so the UI can
   * update the card straight from the response without a refetch.
   */
  async put(accountId: string, provider: string, apiKey: string): Promise<LlmKeyStatus> {
    if (!isLlmProvider(provider)) {
      // 422 (not 400): the request was well-formed, but `provider` isn't in the enum.
      throw new UnprocessableEntityException({ error: 'unknown provider' });
    }

    const key = apiKey.trim();
    if (!key) {
      throw new BadRequestException({ error: 'apiKey is required' });
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new BadRequestException({
        error: `apiKey is too long (max ${MAX_KEY_LENGTH} characters)`,
      });
    }

    await this.verify(provider, key);

    const keyEnc = encryptSecret(key, LLM_KEY_ENV_VAR);
    const last4 = key.slice(-4);

    const row = await this.prisma.llmProviderKey.upsert({
      where: { accountId_provider: { accountId, provider } },
      create: { accountId, provider, keyEnc, last4 },
      update: { keyEnc, last4 },
      select: { updatedAt: true },
    });

    return { provider, configured: true, last4, updatedAt: row.updatedAt.toISOString() };
  }

  /**
   * Decrypts the account's key for one provider, or null when none is configured.
   *
   * The ONLY method that returns key material. It exists for AskService, which must present the
   * key to the provider on every question; `list` deliberately can't reach it. Callers must not
   * cache or log the result — it is decrypted per request and discarded with it.
   */
  async getKey(accountId: string, provider: LlmProviderId): Promise<string | null> {
    const row = await this.prisma.llmProviderKey.findUnique({
      where: { accountId_provider: { accountId, provider } },
      select: { keyEnc: true },
    });
    return row ? decryptSecret(Buffer.from(row.keyEnc), LLM_KEY_ENV_VAR) : null;
  }

  /**
   * Disconnects a provider. Idempotent by construction — `deleteMany` matches zero rows rather than
   * throwing, so removing an unconfigured (or unknown) provider is still a 204.
   */
  async remove(accountId: string, provider: string): Promise<void> {
    await this.prisma.llmProviderKey.deleteMany({ where: { accountId, provider } });
  }

  /**
   * Checks the key against the provider before storing it (API-CONTRACT.md §7, "optional but
   * preferred"). Uses an auth-only endpoint, so verification costs no tokens.
   *
   * Fails closed on every error, including transient ones. Storing a key we couldn't verify just
   * moves the failure to Ask time, where it surfaces as a confusing upstream error long after the
   * user left Settings — a typo is far cheaper to report here, next to the input that caused it.
   *
   * Set LLM_VERIFY_KEYS=false for offline development and CI, where there is no egress.
   */
  private async verify(provider: LlmProviderId, apiKey: string): Promise<void> {
    if (process.env.LLM_VERIFY_KEYS === 'false') return;

    const label = PROVIDER_LABELS[provider];
    try {
      await this.clients.create(provider, apiKey).verifyKey();
    } catch (err) {
      // Logged without the key or the upstream body — both can carry secrets.
      this.logger.warn(`${provider} key verification failed: ${describeForLog(err)}`);

      if (err instanceof LlmProviderError && err.kind === 'rejected') {
        throw new BadRequestException({
          error: `${label} rejected this key. Check it and try again.`,
        });
      }
      throw new ServiceUnavailableException({
        error: `Couldn't reach ${label} to verify this key — try again in a moment.`,
      });
    }
  }
}
