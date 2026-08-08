import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MeController } from './me.controller';
import { SsoClientRegistry } from './sso/sso-client-registry.service';
import { SsoService } from './sso/sso.service';

@Module({
  imports: [
    // Not registered as APP_GUARD — only POST /auth/sso/start opts in via @UseGuards(ThrottlerGuard),
    // so this doesn't touch the separate /v1/* extractor quota system. Limit is generous enough for
    // a legitimate user retrying a typo'd email a few times, while still blunting bulk domain probing.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 20 }],
      // Default is "ThrottlerException: Too many requests" — a class name the UI would render
      // verbatim into a user-facing bubble. /ask shares this limiter, so it is reachable.
      errorMessage: 'Too many requests — wait a moment and try again.',
    }),
  ],
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    SsoService,
    SsoClientRegistry,
    // Registered globally: every route is protected unless marked @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
