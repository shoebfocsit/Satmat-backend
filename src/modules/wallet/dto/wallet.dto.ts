import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class DepositDto {
  @IsInt()
  @Min(1000)
  @Max(10000000)
  amount: number;

  @IsIn(['upi'])
  method = 'upi' as const;
}

export class WithdrawDto {
  @IsInt()
  @Min(1000)
  @Max(10000000)
  amount: number;

  @IsIn(['bank', 'upi'])
  payout: 'bank' | 'upi';

  @IsOptional()
  @IsString()
  upiId?: string;

  @IsOptional()
  @IsString()
  bankDetailsId?: string;
}

export class SaveBankDetailsDto {
  @IsString()
  accountHolder: string;

  @IsString()
  accountNumber: string;

  @IsString()
  ifscCode: string;

  @IsString()
  bankName: string;
}

export class ListWithdrawalsQueryDto {
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

export class ListTransactionsQueryDto {
  @IsOptional()
  @IsIn(['credit', 'debit', 'pending'])
  type?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number = 20;
}

export class InitManualDepositDto {
  @IsInt()
  @Min(100)
  @Max(10000000)
  amount: number;
}

export class SubmitDepositProofDto {
  @IsString()
  depositId: string;

  @IsString()
  utr: string;

  @IsOptional()
  @IsString()
  screenshotUrl?: string;
}

export class AdminReviewDepositDto {
  @IsIn(['APPROVED', 'REJECTED'])
  status: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  adminRemarks?: string;
}