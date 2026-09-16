import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsIn } from 'class-validator';

// Transport-level shape only ("digits with optional * / - separators").
// Strict per-game rules (lengths, SP/DP/TP shapes) are enforced server-side in
// BidsService.validateNumberForGame -> INVALID_BID. Never trust the client.
const NUMBER_PATTERN = /^[0-9*-]{1,12}$/;

export class CreateBidDto {
  @IsString()
  marketId: string;

  @IsString()
  gameType: string;

  @IsString()
  @Matches(NUMBER_PATTERN, {
    message: 'number must be digits with optional * / - separators',
  })
  number: string;

  @IsInt()
  @Min(1000)
  @Max(10000000)
  amount: number;
}

export class BulkItemDto {
  @IsString()
  @Matches(NUMBER_PATTERN, {
    message: 'number must be digits with optional * / - separators',
  })
  number: string;

  @IsInt()
  @Min(1000)
  @Max(10000000)
  amount: number;
}

export class CreateBulkBidDto {
  @IsString()
  marketId: string;

  @IsString()
  gameType: string;

  @IsIn(['OPEN', 'CLOSE'])
  round: 'OPEN' | 'CLOSE';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkItemDto)
  items: BulkItemDto[];
}

export class ListBidsQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number = 20;
}