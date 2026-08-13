import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthUser, PublicUser } from './auth.types';

/** GET /api/v1/me — session restore on app boot; 401 (via the global guard) if token is invalid. */
@Controller('me')
export class MeController {
  @Get()
  me(@CurrentUser() user: AuthUser): PublicUser {
    return { name: user.name, handle: user.handle, team: user.team };
  }
}
