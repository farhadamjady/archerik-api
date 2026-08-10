import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** POST /api/v1/ask body (API-CONTRACT.md §4). `model` is an id the user picked from /models. */
export class AskRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question!: string;

  /**
   * Model id the user picked from GET /models (`claude` | `gpt`). Selects which provider key is
   * loaded and which model actually answers — no longer cosmetic. An unknown or omitted id falls
   * back to the registry default rather than 400ing, so a stale UI bundle still gets an answer.
   */
  @IsOptional()
  @IsString()
  model?: string;
}
