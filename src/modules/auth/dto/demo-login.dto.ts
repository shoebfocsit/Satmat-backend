import { IsString, IsOptional } from 'class-validator';

export class DemoLoginDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  phone: string;

  @IsString()
  @IsOptional()
  password?: string;
}