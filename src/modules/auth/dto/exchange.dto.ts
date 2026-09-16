import { IsString } from 'class-validator';

export class ExchangeDto {
  @IsString()
  code: string;
}