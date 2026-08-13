import { IsString } from 'class-validator';

/**
 * PUT /api/v1/settings/llm-keys body.
 *
 * Only *structural* validation lives here. The semantic checks — unknown provider (422) and
 * empty/oversized key (400) — are done in LlmKeysService so they can throw the exact
 * `{ "error": "..." }` body the UI renders verbatim on the provider card; class-validator's default
 * failure shape (`{ message: [...], error: 'Bad Request' }`) has no `error` string the UI can show.
 *
 * `@IsString()` is still needed on both fields: the global ValidationPipe runs with
 * `whitelist: true`, which strips any property that carries no validation decorator.
 */
export class PutLlmKeyDto {
  /** Provider id — validated against the LLM_PROVIDERS enum in the service (422 if unknown). */
  @IsString()
  provider!: string;

  /** The raw provider API key. Trimmed, then encrypted at rest; never returned by any endpoint. */
  @IsString()
  apiKey!: string;
}
