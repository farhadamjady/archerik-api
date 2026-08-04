import { Body, Controller, Post } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AskRequestDto } from './dto/ask-request.dto';
import { AskResponse, AskService } from './ask.service';

@Controller('ask')
export class AskController {
  constructor(private readonly askService: AskService) {}

  @Post()
  ask(@CurrentUser() user: AuthUser, @Body() body: AskRequestDto): Promise<AskResponse> {
    // Account-scoped, like every read. Branch defaults to main — /ask has no branch selector.
    return this.askService.ask(user.accountId, 'main', body.question, body.model);
  }
}
