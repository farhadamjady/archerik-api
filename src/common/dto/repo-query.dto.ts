import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/** Common query params for the read endpoints: ?repo=&branch=&at= */
export class RepoQueryDto {
  @IsString()
  @MinLength(1)
  repo!: string;

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
