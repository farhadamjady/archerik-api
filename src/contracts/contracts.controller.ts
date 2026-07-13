import { Controller, Get, Query } from '@nestjs/common';
import { ContractsResponse } from '../common/types';
import { ContractsQueryDto } from './dto/contracts-query.dto';
import { ContractsService } from './contracts.service';

@Controller('contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  @Get()
  getContracts(@Query() query: ContractsQueryDto): Promise<ContractsResponse> {
    return this.contractsService.getContracts(query.repo, query.branch, query.at, query.protocol);
  }
}
