import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Account } from '@prisma/client';
import { RequestWithAccount } from '../api-key.guard';

/** Injects the Account resolved by ApiKeyGuard. */
export const CurrentAccount = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Account =>
    ctx.switchToHttp().getRequest<RequestWithAccount>().account,
);
