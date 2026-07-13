import { Module } from '@nestjs/common';
import { CommitsModule } from './commits/commits.module';
import { CommonModule } from './common/common.module';
import { ContractsModule } from './contracts/contracts.module';
import { GraphModule } from './graph/graph.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, CommonModule, GraphModule, ContractsModule, CommitsModule],
  controllers: [HealthController],
})
export class AppModule {}
