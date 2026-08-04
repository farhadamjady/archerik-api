import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** POST /api/v1/ask body (BACKEND-HANDOFF.md §5). `model` is an id the user picked from /models. */
export class AskRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question!: string;

  /** Selected model id (claude|gpt|llama). Cosmetic — echoed into the response `model` label. */
  @IsOptional()
  @IsString()
  model?: string;
}
