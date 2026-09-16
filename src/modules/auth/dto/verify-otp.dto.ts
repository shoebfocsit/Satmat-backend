import { IsString } from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  requestId: string;

  @IsString()
  otp: string;
}