import { IsIn, IsOptional } from 'class-validator';
import { RepoQueryDto } from '../../common/dto/repo-query.dto';
import { PROTOCOL, Protocol } from '../../common/enums';

export class ContractsQueryDto extends RepoQueryDto {
  /** Optional filter: only return `rest` endpoints or `kafka` topics. */
  @IsOptional()
  @IsIn(PROTOCOL)
  protocol?: Protocol;
}
