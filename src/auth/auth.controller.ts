import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { extractBearer } from './auth.guard';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { SsoStartDto } from './dto/sso-start.dto';
import { LoginResponse } from './auth.types';
import { SsoService } from './sso/sso.service';
import { SsoStartResponse } from './sso/sso.types';
import { ssoErrorHtml, ssoRedirectHtml } from './sso/sso-html';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly ssoService: SsoService,
  ) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto): Promise<LoginResponse> {
    // Invalid credentials → 401 (UnauthorizedException from the service).
    return this.authService.login(dto.email, dto.password);
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request): Promise<{ ok: true }> {
    // Best-effort, fire-and-forget from the UI; body is ignored client-side.
    await this.authService.logout(extractBearer(req));
    return { ok: true };
  }

  /**
   * Step 1 of SSO: resolves the account's IdP by email domain and returns a redirect URL. Rate
   * limited — this is the one route whose whole purpose is "tell me if this company uses SSO", so
   * it's the enumeration-risk surface.
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('sso/start')
  start(@Body() dto: SsoStartDto): Promise<SsoStartResponse> {
    return this.ssoService.start(dto.email);
  }

  /**
   * Step 2 of SSO: the IdP redirects the browser back here with `code`/`state`. Full-page browser
   * navigation, not a fetch — on success, returns a tiny page that writes the token to
   * sessionStorage['cartograph.token'] then redirects to APP_URL, so no UI changes are needed. Any
   * failure (bad/expired state, IdP error=, claim validation) renders a generic error page instead
   * — never a silent logged-in-anyway result.
   */
  @Public()
  @Get('sso/callback')
  async ssoCallback(
    // Deliberately untyped, unlike other @Query() routes' DTOs: this is a redirect target the IdP
    // controls, and some providers append extra params (e.g. session_state) the global
    // ValidationPipe's forbidNonWhitelisted would otherwise reject.
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const token = await this.ssoService.callback(query);
      res.type('html').send(ssoRedirectHtml(token));
    } catch {
      res.type('html').send(ssoErrorHtml());
    }
  }
}
