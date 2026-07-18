import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Common query params for the read endpoints. The account (company) is the scope — derived from the
 * session, never a query param — so everything is optional. `repo` and `service` just narrow the
 * account-wide graph; omit both to get the whole architecture.
 */
export class RepoQueryDto {
  /** Optional filter: only nodes/edges/contracts owned by this repo. */
  @IsOptional()
  @IsString()
  repo?: string;

  /** Optional filter: focus on one service and its immediate neighbours. */
  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsString()
  branch: string = 'main';

  /** Optional commit SHA to query the graph at a point in time. */
  @IsOptional()
  @IsString()
  at?: string;
}

/** GET /api/v1/commits also supports ?since= and ?limit= */
export class CommitsQueryDto extends RepoQueryDto {
  @IsOptional()
  @IsString()
  since?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 20;
}
