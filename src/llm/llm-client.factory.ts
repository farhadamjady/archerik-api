import { Injectable } from '@nestjs/common';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';
import { LlmProvider } from './provider.types';
import { LlmProviderId } from './providers';

/** Interactive endpoint — a caller is watching a spinner, so fail well before a proxy would. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Builds a provider client bound to one account's key.
 *
 * Deliberately constructs a fresh client per call and holds no cache. Caching by account would keep
 * plaintext customer keys resident in a long-lived map for the sake of saving an object
 * construction — the wrong trade for a credential we otherwise keep encrypted at rest and decrypt
 * only for the duration of a single request.
 *
 * Injectable so tests can override it with a stub and exercise the Ask loop without network access.
 */
@Injectable()
export class LlmClientFactory {
  create(provider: LlmProviderId, apiKey: string): LlmProvider {
    const timeout = timeoutMs();
    switch (provider) {
      case 'anthropic':
        return new AnthropicProvider(apiKey, timeout);
      case 'openai':
        return new OpenAiProvider(apiKey, timeout);
    }
  }
}

function timeoutMs(): number {
  const raw = Number(process.env.LLM_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}
