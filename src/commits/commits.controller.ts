import { Controller, Get, Query } from '@nestjs/common';
import { CommitsQueryDto } from '../common/dto/repo-query.dto';
import { CommitDto } from '../common/types';
import { CommitsService } from './commits.service';

@Controller('commits')
export class CommitsController {
  constructor(private readonly commitsService: CommitsService) {}

  @Get()
  getCommits(@Query() query: CommitsQueryDto): Promise<CommitDto[]> {
    return this.commitsService.getCommits(query.repo, query.branch, query.limit, query.at);
  }
}
