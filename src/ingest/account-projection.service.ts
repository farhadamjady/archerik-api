import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ServiceBody } from './model';
import { ParsedService, projectReadModel } from './project';

/**
 * Rebuilds the account-wide read model (Graph + Contracts) for an (account, branch) from the union of
 * every service baseline the account owns. Triggered by a normal /v1/ingest whenever a baseline
 * changes, so /api/v1/graph and /api/v1/contracts reflect the whole fleet.
 *
 * Always runs inside the caller's transaction (takes a Prisma.TransactionClient), so the reprojection
 * commits atomically with the write that triggered it. Overwrites in place — no history.
 */
@Injectable()
export class AccountProjectionService {
  async reproject(
    tx: Prisma.TransactionClient,
    accountId: string,
    branch: string,
    headSha: string | null,
  ): Promise<void> {
    // Serialize reprojections of the SAME (account, branch): the read model is rebuilt by
    // delete-then-create, so two concurrent reprojections (e.g. two service ingests touching `main`)
    // would otherwise race on the Graph row — a unique-constraint or serialization failure that 500s
    // one of them. A transaction-scoped advisory lock makes the second wait for the first to commit;
    // it's released automatically at end of transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${accountId}:${branch}`}), 0)`;

    const rows = await tx.serviceBaseline.findMany({
      where: { accountId, defaultBranch: branch },
      select: { serviceId: true, serviceName: true, language: true, body: true },
    });

    const services: ParsedService[] = [];
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
    }

    const { graph, contracts } = projectReadModel(services);

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
}
