import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { LlmKeysController } from './llm-keys.controller';
import { LlmKeysService } from './llm-keys.service';

/**
 * The /settings/* surface. Currently just the LLM provider-key store; the other settings endpoints
 * sketched in API-CONTRACT.md (scan-scope, repositories, ownership, pr-comments) would land here.
 *
 * LlmKeysService is exported because AskService needs it to resolve the account's key for the
 * chosen model (and to answer 409 when there isn't one).
 */
@Module({
  imports: [LlmModule],
  controllers: [LlmKeysController],
  providers: [LlmKeysService],
  exports: [LlmKeysService],
})
export class SettingsModule {}
