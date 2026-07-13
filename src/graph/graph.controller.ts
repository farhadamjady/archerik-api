import { Controller, Get, Query } from '@nestjs/common';
import { RepoQueryDto } from '../common/dto/repo-query.dto';
import { GraphResponse } from '../common/types';
import { GraphService } from './graph.service';

@Controller('graph')
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  @Get()
  getGraph(@Query() query: RepoQueryDto): Promise<GraphResponse> {
    return this.graphService.getGraph(query.repo, query.branch, query.at);
  }
}
