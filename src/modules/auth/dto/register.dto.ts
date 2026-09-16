import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name: string;

  @IsString()
  @MinLength(10)
  @MaxLength(15)
  phone: string;

  @IsString()
  @MinLength(4)
  @MaxLength(100)
  password: string;

  @IsOptional()
  @IsString()
  referralCode?: string;
}