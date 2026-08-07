import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { StoredGraphData } from '../common/graph-filter';
import { GraphLookupService } from '../common/graph-lookup.service';
import { EndpointContractDto, TopicContractDto } from '../common/types';
import { describeForLog, toHttpException } from '../llm/llm-errors';
import { LlmClientFactory } from '../llm/llm-client.factory';
import { resolveModel } from '../llm/model-registry';
import { LlmProviderError, LlmTurn, ToolResult } from '../llm/provider.types';
import { PrismaService } from '../prisma/prisma.service';
import { LlmKeysService } from '../settings/llm-keys.service';
import { buildSystemPrompt, extractEvidenceIds, stripEvidenceMarkup } from './ask-prompt';
import { Catalog, CATALOG_TOOLS, executeCatalogTool } from './catalog-tools';
import { AskCite, buildNote, EvidenceLedger } from './evidence';

export { AskCite };

export interface AskResponse {
  text: string;
  cites: AskCite[];
  note: string | null;
  model: string;
}

/**
 * Caps one question's tool loop. Enough for discovery plus a couple of follow-ups; low enough that
 * a model stuck in a loop can't run up the customer's bill or hold a request open indefinitely.
 */
const MAX_ITERATIONS = 6;

/**
 * Bounds thinking AND response text together on reasoning models. The answer is a short paragraph,
 * but sizing this for the prose alone truncates it mid-sentence once thinking is counted.
 */
const MAX_TOKENS = 8000;

/**
 * POST /api/v1/ask — grounded Q&A over the account catalog.
 *
 * The model reaches the graph only through the catalog tools, and it never authors a citation:
 * tools record every relationship they return in an evidence ledger, the model names the ids it
 * used, and the backend renders `cites` from the recorded rows (see evidence.ts). So "never
 * invents" (CLAUDE.md §6) holds structurally rather than by the model's cooperation.
 *
 * Field ownership in the response: `text` comes from the model; `cites` and `note` are computed
 * here from the ledger; `model` comes from the registry. Nothing the model writes is echoed
 * unexamined.
 *
 * Failures never become answers. Every provider problem surfaces as a 4xx/5xx with an `error`
 * string the UI renders in its "no answer" bubble (BACKEND-LLM-KEYS.md §4).
 */
@Injectable()
export class AskService {
  private readonly logger = new Logger(AskService.name);

  constructor(
    private readonly lookup: GraphLookupService,
    private readonly prisma: PrismaService,
    private readonly llmKeys: LlmKeysService,
    private readonly clients: LlmClientFactory,
  ) {}

  async ask(
    accountId: string,
    branch: string,
    question: string,
    modelId?: string,
  ): Promise<AskResponse> {
    const model = resolveModel(modelId);

    const apiKey = await this.llmKeys.getKey(accountId, model.provider);
    if (!apiKey) {
      // Spec-exact wording — the UI shows this and points the user at Settings → LLM.
      throw new ConflictException({ error: `no API key configured for ${model.provider}` });
    }

    const catalog = await this.loadCatalog(accountId, branch);
    if (catalog.nodes.length === 0) {
      // Nothing to ground an answer in. Saying so costs no tokens and is the honest answer.
      return {
        text: 'I answer from the current catalog, but no repositories have been scanned for this account yet.',
        cites: [],
        note: null,
        model: model.wireModel,
      };
    }

    const ledger = new EvidenceLedger();
    const client = this.clients.create(model.provider, apiKey);
    const turns: LlmTurn[] = [{ role: 'user', text: question }];

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const completion = await client.complete({
          model: model.wireModel,
          fallbackModel: model.fallbackModel,
          system: buildSystemPrompt(catalog),
          tools: CATALOG_TOOLS,
          turns,
          maxTokens: MAX_TOKENS,
        });

        if (completion.toolCalls.length === 0) {
          return this.assemble(completion.text, ledger, model.wireModel);
        }

        turns.push({
          role: 'assistant',
          text: completion.text,
          toolCalls: completion.toolCalls,
        });

        // All results for one assistant turn go back together — splitting them across messages
        // trains the model out of asking for tools in parallel.
        const results: ToolResult[] = completion.toolCalls.map((call) => ({
          id: call.id,
          content: JSON.stringify(executeCatalogTool(call.name, call.input, { catalog, ledger })),
        }));
        turns.push({ role: 'tool', results });
      }

      // Out of iterations with no final answer. The evidence gathered so far is real, so the
      // honest move is to say we couldn't finish rather than to synthesise a conclusion.
      this.logger.warn(`ask: hit the ${MAX_ITERATIONS}-iteration cap without a final answer`);
      return this.assemble(
        'I could not narrow that down from the catalog. Try naming a single service or Kafka topic.',
        ledger,
        model.wireModel,
      );
    } catch (err) {
      if (err instanceof LlmProviderError) {
        this.logger.warn(`ask: ${model.provider} call failed: ${describeForLog(err)}`);
        throw toHttpException(err);
      }
      throw err;
    }
  }

  /**
   * Builds the response from the model's prose plus the backend-owned evidence. The citation
   * bookkeeping is stripped from the text — the UI renders cites as its own affordance, so leaving
   * `EVIDENCE: ev1` in the bubble would expose the plumbing.
   */
  private assemble(text: string, ledger: EvidenceLedger, wireModel: string): AskResponse {
    const cites = ledger.resolveCites(extractEvidenceIds(text));
    return {
      text: stripEvidenceMarkup(text),
      cites,
      note: buildNote(cites),
      model: wireModel,
    };
  }

  /** The account's graph plus its contracts — the only data the tools can see. */
  private async loadCatalog(accountId: string, branch: string): Promise<Catalog> {
    const graph = await this.lookup.findGraph(accountId, branch);
    if (!graph) return { nodes: [], edges: [], topics: [], endpoints: [] };

    const data = graph.data as unknown as StoredGraphData;
    const contracts = await this.prisma.contract.findMany({ where: { graphId: graph.id } });

    return {
      nodes: data.nodes ?? [],
      edges: data.edges ?? [],
      topics: contracts
        .filter((c) => c.kind === 'kafka')
        .map((c) => c.data as unknown as TopicContractDto),
      endpoints: contracts
        .filter((c) => c.kind === 'rest')
        .map((c) => c.data as unknown as EndpointContractDto),
    };
  }
}
