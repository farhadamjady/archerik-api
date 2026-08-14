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
 * Reads one piece of commit metadata, preferring the canonical `X-Archerik-*` name and falling back
 * to the `X-EKG-*` name earlier extractor builds send. Both are accepted indefinitely: the extractor
 * ships independently of this service, so dropping the legacy name would break every CI pipeline
 * still running an older binary.
 */
function commitHeader(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  return headers[`x-archerik-${name}`] ?? headers[`x-ekg-${name}`];
}

/**
 * POST /v1/ingest — the robust gate + per-commit diff engine.
 * Commit metadata rides in headers so the body stays the pure, byte-stable graph. We read
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
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<IngestResponse> {
    const raw = req.rawBody;
    if (!raw || raw.length === 0) {
      throw new BadRequestException('Empty body');
    }
    return this.ingest.ingest(account, raw, {
      sha: commitHeader(headers, 'sha'),
      branch: commitHeader(headers, 'branch'),
      pr: commitHeader(headers, 'pr'),
      defaultBranch: commitHeader(headers, 'default-branch'),
    });
  }
}
