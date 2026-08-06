import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { encryptSecret } from '../common/secret-box';
import { isLlmProvider, LLM_PROVIDERS, LlmProviderId } from '../llm/providers';
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
  constructor(private readonly prisma: PrismaService) {}

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
   * Disconnects a provider. Idempotent by construction — `deleteMany` matches zero rows rather than
   * throwing, so removing an unconfigured (or unknown) provider is still a 204.
   */
  async remove(accountId: string, provider: string): Promise<void> {
    await this.prisma.llmProviderKey.deleteMany({ where: { accountId, provider } });
  }
}
