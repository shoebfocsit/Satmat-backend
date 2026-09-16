import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  requestId: string;

  @IsString()
  otp: string;

  @IsString()
  @MinLength(4)
  newPassword: string;
}