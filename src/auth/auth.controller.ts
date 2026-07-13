import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { extractBearer } from './auth.guard';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { LoginResponse } from './auth.types';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
   * SSO redirect target — a full-page browser navigation, not a fetch. Mints a token and returns a
   * tiny page that writes it to sessionStorage['cartograph.token'] then redirects to APP_URL, so no
   * UI changes are needed (the contract's preferred option).
   */
  @Public()
  @Get('sso')
  async sso(@Res() res: Response): Promise<void> {
    const token = await this.authService.ssoLogin();
    const appUrl = process.env.APP_URL ?? 'http://localhost:5173';
    const payload = JSON.stringify(token);
    const target = JSON.stringify(appUrl);
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Signing in…</title><script>
try { sessionStorage.setItem('cartograph.token', ${payload}); } catch (e) {}
location.replace(${target});
</script>Signing you in…`,
    );
  }
}
