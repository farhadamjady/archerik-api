import { Body, Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PutLlmKeyDto } from './dto/put-llm-key.dto';
import { LlmKeysService, LlmKeyStatus } from './llm-keys.service';

/**
 * Settings → LLM tab.
 *
 * Account-scoped: the account comes from the session, never the request, so every member of an
 * account shares one set of provider keys. Writes are not gated to admins — there is no role model
 * on User, and the spec leaves that call to the backend.
 */
@Controller('settings/llm-keys')
export class LlmKeysController {
  constructor(private readonly llmKeys: LlmKeysService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<LlmKeyStatus[]> {
    return this.llmKeys.list(user.accountId);
  }

  @Put()
  @HttpCode(200) // Nest defaults PUT to 200 already; pinned because the UI asserts on it.
  put(@CurrentUser() user: AuthUser, @Body() body: PutLlmKeyDto): Promise<LlmKeyStatus> {
    return this.llmKeys.put(user.accountId, body.provider, body.apiKey);
  }

  /** Idempotent: deleting an unconfigured provider is still a 204. */
  @Delete(':provider')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('provider') provider: string): Promise<void> {
    return this.llmKeys.remove(user.accountId, provider);
  }
}
