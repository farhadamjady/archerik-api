import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AskRequestDto } from './dto/ask-request.dto';
import { AskResponse, AskService } from './ask.service';

@Controller('ask')
export class AskController {
  constructor(private readonly askService: AskService) {}

  /**
   * Rate-limited because each call now spends the customer's own provider tokens. The account key
   * makes a runaway client expensive for them and invisible to us, so the ceiling lives here
   * alongside the tool-loop cap in AskService.
   */
  @Post()
  @UseGuards(ThrottlerGuard)
  ask(@CurrentUser() user: AuthUser, @Body() body: AskRequestDto): Promise<AskResponse> {
    // Account-scoped, like every read. Branch defaults to main — /ask has no branch selector.
    return this.askService.ask(user.accountId, 'main', body.question, body.model);
  }
}
