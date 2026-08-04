import { Controller, Get } from '@nestjs/common';

/** One selectable Ask model (BACKEND-HANDOFF.md §6). `id` is echoed back in POST /ask as `model`. */
export interface ModelDto {
  id: string;
  label: string;
  vendor: string;
}

/**
 * GET /api/v1/models — feeds the Ask model selector. Static for now: the answer engine is a
 * deterministic grounded resolver (see AskService), so the choice is cosmetic — `id` is echoed into
 * the "grounded in catalog · <model>" header. Non-fatal on the UI (it has a built-in fallback list),
 * but we serve it so the header reflects a real, backend-owned list. Ids mirror the executable
 * reference (dev-server.mjs / the DC file) so the /ask echo stays consistent.
 */
@Controller('models')
export class ModelsController {
  private static readonly MODELS: ModelDto[] = [
    { id: 'claude', label: 'Claude Sonnet 4.5', vendor: 'Anthropic API' },
    { id: 'gpt', label: 'GPT-4o', vendor: 'OpenAI API' },
    { id: 'llama', label: 'Llama 3.1 70B', vendor: 'self-hosted · in-cluster' },
  ];

  @Get()
  getModels(): ModelDto[] {
    return ModelsController.MODELS;
  }
}
