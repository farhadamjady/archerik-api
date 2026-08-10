import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Account } from '@prisma/client';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard } from './api-key.guard';
import { CurrentAccount } from './decorators/current-account.decorator';
import { IngestResponse } from './model';
import { IngestService } from './ingest.service';

/**
 * POST /v1/ingest — the robust gate + per-commit diff engine.
 * Commit metadata rides in X-EKG-* headers so the body stays the pure, byte-stable graph. We read
 * req.rawBody (enabled in main.ts) so the "unchanged" fast path is a raw byte comparison.
 * @Public() skips the session guard; ApiKeyGuard re-validates the key (401) at submit.
 */
@Public()
@UseGuards(ApiKeyGuard)
@Controller('v1/ingest')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post()
  @HttpCode(200)
  async submit(
    @CurrentAccount() account: Account,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-ekg-sha') sha?: string,
    @Headers('x-ekg-branch') branch?: string,
    @Headers('x-ekg-pr') pr?: string,
    @Headers('x-ekg-default-branch') defaultBranch?: string,
  ): Promise<IngestResponse> {
    const raw = req.rawBody;
    if (!raw || raw.length === 0) {
      throw new BadRequestException('Empty body');
    }
    return this.ingest.ingest(account, raw, { sha, branch, pr, defaultBranch });
  }
}
