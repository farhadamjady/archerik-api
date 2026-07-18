import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { CommitsQueryDto } from '../common/dto/repo-query.dto';
import { CommitDto } from '../common/types';
import { CommitsService } from './commits.service';

@Controller('commits')
export class CommitsController {
  constructor(private readonly commitsService: CommitsService) {}

  @Get()
  getCommits(@CurrentUser() user: AuthUser, @Query() query: CommitsQueryDto): Promise<CommitDto[]> {
    return this.commitsService.getCommits(user.accountId, query.branch, query.limit, query.at);
  }
}
