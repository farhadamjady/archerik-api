import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { ContractsResponse } from '../common/types';
import { ContractsQueryDto } from './dto/contracts-query.dto';
import { ContractsService } from './contracts.service';

@Controller('contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  @Get()
  getContracts(
    @CurrentUser() user: AuthUser,
    @Query() query: ContractsQueryDto,
  ): Promise<ContractsResponse> {
    return this.contractsService.getContracts(user.accountId, query.branch, {
      repo: query.repo,
      service: query.service,
      at: query.at,
      protocol: query.protocol,
    });
  }
}
