import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Account, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { diffGraph } from './graphdiff';
import { renderMarkdown } from './markdown';
import { EMPTY_SERVICE, Entitlement, IngestResponse, ServiceBody } from './model';
import { ParsedService, projectReadModel } from './project';
import { resolveAll } from './resolve';

/** Commit metadata the extractor sends in headers (body stays the pure graph). */
export interface IngestHeaders {
  sha?: string;
  branch?: string;
  pr?: string;
  defaultBranch?: string;
}

@Injectable()
export class IngestService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Entitlement gate shared by /v1/auth/validate and /v1/ingest. Maps to the contract's status
   * codes: expired entitlement -> 403 (not entitled); no quota left -> 429 (quota exceeded).
   * A bad/absent key is already a 401 from ApiKeyGuard before we get here.
   */
  assertEntitled(account: Account): Entitlement {
    if (account.expiresAt.getTime() <= Date.now()) {
      throw new ForbiddenException('Entitlement expired');
    }
    if (account.quotaRemaining <= 0) {
      throw new HttpException('Quota exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    return {
      plan: account.plan,
      quota_remaining: account.quotaRemaining,
      expires_at: account.expiresAt.toISOString(),
    };
  }

  private parseBody(raw: Buffer): ServiceBody {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('Body is not valid JSON');
    }
    const body = parsed as Partial<ServiceBody>;
    if (!body || typeof body.service_id !== 'string' || body.service_id.length === 0) {
      // Reference stub returns 400 for a body that isn't a service graph (missing service_id).
      throw new BadRequestException('Body is not a service graph (missing service_id)');
    }
    // Slices are always emitted per spec, but be defensive against a partial fixture.
    return {
      databases_used: [],
      config_dependencies: [],
      endpoints: [],
      outbound_dependencies: [],
      kafka_producers: [],
      kafka_consumers: [],
      ...body,
    } as ServiceBody;
  }

  /** Fleet registry: lowercased matchable name -> canonical service_id (BACKEND_CONTRACT.md §6). */
  private async knownServices(accountId: string, selfId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.serviceBaseline.findMany({
      where: { accountId },
      select: { serviceId: true, serviceName: true },
    });
    const known = new Map<string, string>();
    known.set(selfId.toLowerCase(), selfId);
    for (const r of rows) {
      known.set(r.serviceId.toLowerCase(), r.serviceId);
      if (r.serviceName) known.set(r.serviceName.toLowerCase(), r.serviceId);
    }
    return known;
  }

  async ingest(account: Account, raw: Buffer, headers: IngestHeaders): Promise<IngestResponse> {
    this.assertEntitled(account);

    const head = this.parseBody(raw);
    const serviceId = head.service_id;
    const defaultBranch = headers.defaultBranch?.trim() || 'main';
    // Absent branch => baseline branch; otherwise a PR scan unless it equals the default branch.
    const isDefaultScan = !headers.branch || headers.branch === defaultBranch;

    const existing = await this.prisma.serviceBaseline.findUnique({
      where: {
        accountId_serviceId_defaultBranch: { accountId: account.id, serviceId, defaultBranch },
      },
    });

    // Fast path: byte-identical to the stored baseline => nothing changed, nothing to post.
    if (existing && Buffer.from(existing.body).equals(raw)) {
      await this.consumeQuota(account.id);
      return {
        service_id: serviceId,
        unchanged: true,
        first_scan: false,
        baseline_updated: false,
        markdown: '',
      };
    }

    const base: ServiceBody = existing
      ? (JSON.parse(Buffer.from(existing.body).toString('utf8')) as ServiceBody)
      : { ...EMPTY_SERVICE, service_id: serviceId };
    const firstScan = !existing;

    const diff = diffGraph(base, head);
    diff.target_resolutions = resolveAll(
      head.outbound_dependencies,
      await this.knownServices(account.id, serviceId),
    );
    const markdown = renderMarkdown(diff, firstScan);

    // Default-branch scan updates the baseline; a PR scan never writes it.
    const baselineUpdated = isDefaultScan;
    await this.prisma.$transaction(async (tx) => {
      if (baselineUpdated) {
        await tx.serviceBaseline.upsert({
          where: {
            accountId_serviceId_defaultBranch: { accountId: account.id, serviceId, defaultBranch },
          },
          create: {
            accountId: account.id,
            serviceId,
            serviceName: head.service_name ?? null,
            language: head.language ?? null,
            defaultBranch,
            sha: headers.sha ?? null,
            body: raw, // raw bytes, verbatim
          },
          update: {
            serviceName: head.service_name ?? null,
            language: head.language ?? null,
            sha: headers.sha ?? null,
            body: raw,
          },
        });

        // Rebuild the read model (graph + contracts) from every baseline the account owns, so a
        // single ingest call is all it takes for /api/v1/graph and /api/v1/contracts to reflect the
        // whole company's architecture. The UI queries by account (via session), not by repo.
        await this.reprojectAccount(tx, account.id, defaultBranch, headers.sha ?? null);
      }
      await tx.account.update({
        where: { id: account.id },
        data: { quotaRemaining: { decrement: 1 } },
      });
    });

    return {
      service_id: serviceId,
      unchanged: false,
      first_scan: firstScan,
      baseline_updated: baselineUpdated,
      diff,
      markdown,
    };
  }

  /**
   * Rebuilds the current-head Graph row (+ Contract rows) for an (account, branch) from the union
   * of EVERY service baseline the account owns — across all repos. Overwrites in place — no history
   * — since baselines hold one body per service, not a per-commit series. Runs inside the ingest
   * transaction. Nodes carry their `repo` so the read layer can offer repo/service as filters.
   */
  private async reprojectAccount(
    tx: Prisma.TransactionClient,
    accountId: string,
    branch: string,
    headSha: string | null,
  ): Promise<void> {
    const rows = await tx.serviceBaseline.findMany({
      where: { accountId, defaultBranch: branch },
      select: { serviceId: true, serviceName: true, language: true, body: true },
    });

    const services: ParsedService[] = [];
    const known = new Map<string, string>();
    for (const r of rows) {
      let body: ServiceBody;
      try {
        body = JSON.parse(Buffer.from(r.body).toString('utf8')) as ServiceBody;
      } catch {
        continue; // skip a corrupt baseline rather than fail the whole projection
      }
      services.push({
        serviceId: r.serviceId,
        serviceName: r.serviceName,
        language: r.language,
        repo: body.repository?.trim() || null,
        body,
      });
      known.set(r.serviceId.toLowerCase(), r.serviceId);
      if (r.serviceName) known.set(r.serviceName.toLowerCase(), r.serviceId);
    }

    const { graph, contracts } = projectReadModel(services, known);

    // Delete-then-create keeps exactly one row per (account, branch); cascades old contracts/commits.
    await tx.graph.deleteMany({ where: { accountId, branch } });
    const created = await tx.graph.create({
      data: {
        accountId,
        branch,
        commitSha: headSha ?? 'HEAD',
        scannedAt: new Date(),
        data: graph as unknown as Prisma.InputJsonValue,
      },
    });

    const contractRows = [
      ...contracts.endpoints.map((e) => ({
        graphId: created.id,
        kind: 'rest',
        data: e as unknown as Prisma.InputJsonValue,
      })),
      ...contracts.topics.map((t) => ({
        graphId: created.id,
        kind: 'kafka',
        data: t as unknown as Prisma.InputJsonValue,
      })),
    ];
    if (contractRows.length > 0) {
      await tx.contract.createMany({ data: contractRows });
    }
  }

  private async consumeQuota(accountId: string): Promise<void> {
    await this.prisma.account.update({
      where: { id: accountId },
      data: { quotaRemaining: { decrement: 1 } },
    });
  }
}
