import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { RepoQueryDto } from '../common/dto/repo-query.dto';
import { GraphResponse } from '../common/types';
import { GraphService } from './graph.service';

@Controller('graph')
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  @Get()
  getGraph(@CurrentUser() user: AuthUser, @Query() query: RepoQueryDto): Promise<GraphResponse> {
    return this.graphService.getGraph(user.accountId, query.branch, {
      repo: query.repo,
      service: query.service,
      at: query.at,
    });
  }
}
