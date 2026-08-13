import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { SettingsModule } from '../settings/settings.module';
import { AskController } from './ask.controller';
import { AskService } from './ask.service';

/**
 * SettingsModule supplies the account's provider key (and the 409 when there isn't one);
 * LlmModule supplies the client that spends it.
 */
@Module({
  imports: [SettingsModule, LlmModule],
  controllers: [AskController],
  providers: [AskService],
})
export class AskModule {}
