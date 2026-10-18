import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class DeclareResultDto {
  @IsString()
  @Matches(/^\d{3}$/, { message: 'open must be a 3-digit panel (e.g. 128)' })
  open: string;

  @IsString()
  @Matches(/^\d{2}$/, { message: 'jodi must be 2 digits (e.g. 47)' })
  jodi: string;

  @IsString()
  @Matches(/^\d{3}$/, { message: 'close must be a 3-digit panel (e.g. 460)' })
  close: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

export class OpenCloseDto {
  @IsString()
  action: 'open' | 'close';
}

export class UpdateMarketScheduleDto {
  @IsString()
  @Matches(/^(\d{1,2}:\d{2}(\s*[AP]M)?)$/i, { message: 'openTime must be HH:MM or hh:mm AM/PM' })
  openTime: string;

  @IsString()
  @Matches(/^(\d{1,2}:\d{2}(\s*[AP]M)?)$/i, { message: 'closeTime must be HH:MM or hh:mm AM/PM' })
  closeTime: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateNoticeDto {
  @IsString()
  title: string;

  @IsString()
  content: string;

  @IsOptional()
  isImportant?: boolean;
}

export class AdminQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class AdminDepositsQueryDto extends AdminQueryDto {
  @IsOptional()
  @IsString()
  status?: string;
}

export class AdjustWalletDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  /** paise (integer paise, min ₹1, max ₹10,00,000) */
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(100000000)
  amount: number;

  @IsIn(['credit', 'debit'])
  direction: 'credit' | 'debit';

  @IsOptional()
  @IsString()
  title?: string;
}

export class SettleWithdrawalDto {
  @IsIn(['complete', 'fail'])
  action: 'complete' | 'fail';
}