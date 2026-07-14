import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CommitsModule } from './commits/commits.module';
import { CommonModule } from './common/common.module';
import { ContractsModule } from './contracts/contracts.module';
import { GraphModule } from './graph/graph.module';
import { HealthController } from './health/health.controller';
import { IngestModule } from './ingest/ingest.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    AuthModule,
    GraphModule,
    ContractsModule,
    CommitsModule,
    IngestModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
