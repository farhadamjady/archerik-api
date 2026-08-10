import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Account } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard } from './api-key.guard';
import { CurrentAccount } from './decorators/current-account.decorator';
import { Entitlement } from './model';
import { IngestService } from './ingest.service';

/**
 * POST /v1/auth/validate — the extractor's startup entitlement gate (INGEST-CONTRACT.md §2).
 * Empty body, Bearer API key. Status codes drive the CLI's exit codes:
 *   200 valid · 401 bad key (ApiKeyGuard) · 403 not entitled · 429 quota exceeded.
 * @Public() so the global session guard skips; ApiKeyGuard is the real gate.
 */
@Public()
@UseGuards(ApiKeyGuard)
@Controller('v1/auth')
export class AuthValidateController {
  constructor(private readonly ingest: IngestService) {}

  @Post('validate')
  @HttpCode(200)
  validate(@CurrentAccount() account: Account): Entitlement {
    return this.ingest.assertEntitled(account);
  }
}
