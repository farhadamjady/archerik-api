import { IsEmail } from 'class-validator';

export class SsoStartDto {
  @IsEmail()
  email!: string;
}
