import { Module } from '@nestjs/common';
import { LlmClientFactory } from './llm-client.factory';

/**
 * Provider clients for the Ask tab. Consumed by SettingsModule (key verification at save time) and
 * AskModule (the grounded answer loop).
 */
@Module({
  providers: [LlmClientFactory],
  exports: [LlmClientFactory],
})
export class LlmModule {}
