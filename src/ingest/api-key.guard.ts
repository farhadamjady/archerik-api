import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Account } from '@prisma/client';
import { Request } from 'express';
import { extractBearer } from '../auth/auth.guard';
import { IngestAuthService } from './ingest-auth.service';

export type RequestWithAccount = Request & { account: Account };

/**
 * Guards the extractor's /v1/* routes. A valid Bearer API key is the 401 gate on BOTH
 * /v1/auth/validate and /v1/ingest (BACKEND_CONTRACT.md §2/§3 — re-validate at submit). Attaches
 * the resolved Account to the request. Applied per-controller with @UseGuards; these routes are also
 * @Public() so the global session guard skips them.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly ingestAuth: IngestAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const account = await this.ingestAuth.authenticate(extractBearer(req));
    if (!account) throw new UnauthorizedException('Invalid API key');
    (req as RequestWithAccount).account = account;
    return true;
  }
}
