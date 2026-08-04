import { Module } from '@nestjs/common';
import { AccountProjectionService } from './account-projection.service';
import { ApiKeyGuard } from './api-key.guard';
import { AuthValidateController } from './auth-validate.controller';
import { IngestAuthService } from './ingest-auth.service';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

/**
 * The extractor-facing control plane (BACKEND_CONTRACT.md). /v1/* routes gated by an API key,
 * separate from the UI's session-token API. Routes are excluded from the api/v1 global prefix in
 * main.ts and marked @Public() so the global session guard defers to ApiKeyGuard.
 */
@Module({
  controllers: [AuthValidateController, IngestController],
  providers: [IngestAuthService, ApiKeyGuard, IngestService, AccountProjectionService],
})
export class IngestModule {}
