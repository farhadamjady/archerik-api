import { Controller, Get } from '@nestjs/common';
import { listModels, ModelDto } from '../llm/model-registry';

/**
 * GET /api/v1/models — feeds the Ask model selector.
 *
 * The list itself lives in src/llm/model-registry.ts, shared with AskService so the id the user
 * picks, the provider key that gets loaded, and the model string sent upstream can't drift apart.
 *
 * Each entry carries `provider` so the UI can cross-reference
 * GET /settings/llm-keys and flag models whose provider has no key. The picker still shows them.
 * Non-fatal on the UI — it falls back to a built-in list if this fails.
 */
@Controller('models')
export class ModelsController {
  @Get()
  getModels(): ModelDto[] {
    return listModels();
  }
}
