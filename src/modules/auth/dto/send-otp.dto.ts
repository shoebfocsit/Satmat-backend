import { IsIn, IsString } from 'class-validator';

export class SendOtpDto {
  @IsString()
  phone: string;

  @IsIn(['login', 'forgot-password'])
  purpose: 'login' | 'forgot-password';
}