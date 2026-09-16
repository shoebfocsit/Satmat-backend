import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { WalletService } from './wallet.service';
import {
  DepositDto,
  InitManualDepositDto,
  ListTransactionsQueryDto,
  ListWithdrawalsQueryDto,
  SaveBankDetailsDto,
  SubmitDepositProofDto,
  WithdrawDto,
} from './dto/wallet.dto';

@Controller()
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('wallet')
  async balance(@CurrentUser('id') userId: string) {
    return this.wallet.getBalance(userId);
  }

  @Post('wallet/deposit')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  async deposit(@CurrentUser('id') userId: string, @Body() dto: DepositDto) {
    return this.wallet.deposit(userId, dto);
  }

  @Post('wallet/deposit/:orderId/verify')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  async verifyDeposit(@CurrentUser('id') userId: string, @Param('orderId') orderId: string) {
    return this.wallet.verifyDeposit(userId, orderId);
  }

  @Public()
  @Post('wallet/deposit/webhook')
  @HttpCode(HttpStatus.OK)
  async depositWebhook(
    @Body() payload: any,
    @Headers('x-webhook-signature') signature?: string,
  ) {
    return this.wallet.depositWebhook(payload, signature);
  }

  @Post('wallet/withdraw')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  async withdraw(@CurrentUser('id') userId: string, @Body() dto: WithdrawDto) {
    return this.wallet.withdraw(userId, dto);
  }

  @Public()
  @Post('wallet/withdraw/webhook')
  @HttpCode(HttpStatus.OK)
  async withdrawWebhook(
    @Body() payload: any,
    @Headers('x-webhook-signature') signature?: string,
  ) {
    return this.wallet.withdrawWebhook(payload, signature);
  }

  @Get('wallet/withdrawals')
  async withdrawals(@CurrentUser('id') userId: string, @Query() query: ListWithdrawalsQueryDto) {
    return this.wallet.listWithdrawals(userId, query);
  }

  @Get('transactions')
  async transactions(@CurrentUser('id') userId: string, @Query() query: ListTransactionsQueryDto) {
    return this.wallet.listTransactions(userId, query);
  }

  @Get('bank-details')
  async bankDetails(@CurrentUser('id') userId: string) {
    return this.wallet.getBankDetails(userId);
  }

  @Post('bank-details')
  @UseInterceptors(IdempotencyInterceptor)
  async saveBankDetails(@CurrentUser('id') userId: string, @Body() dto: SaveBankDetailsDto) {
    return this.wallet.saveBankDetails(userId, dto);
  }

  @Get('winnings')
  async winnings(@CurrentUser('id') userId: string, @Query() query: any) {
    return this.wallet.getWinnings(userId, query);
  }

  @Post('wallet/deposit/manual/init')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  async initManualDeposit(@CurrentUser('id') userId: string, @Body() dto: InitManualDepositDto) {
    return this.wallet.initManualDeposit(userId, dto);
  }

  @Post('wallet/deposit/manual/submit')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  async submitDepositProof(@CurrentUser('id') userId: string, @Body() dto: SubmitDepositProofDto) {
    return this.wallet.submitDepositProof(userId, dto);
  }

  @Get('wallet/deposit/manual/history')
  async listUserDeposits(@CurrentUser('id') userId: string) {
    return this.wallet.listUserDeposits(userId);
  }
}