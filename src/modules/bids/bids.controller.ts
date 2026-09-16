import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { BidsService } from './bids.service';
import { CreateBidDto, CreateBulkBidDto, ListBidsQueryDto } from './dto/bids.dto';

const MAX_IDEMPOTENCY_KEY_LEN = 128;

function requireIdemKey(idemKey?: string): string {
  const key = (idemKey || '').trim();
  if (!key) {
    throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header is required for this request',
    });
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LEN) {
    throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header is too long (max 128 characters)',
    });
  }
  return key;
}

@Controller('bids')
export class BidsController {
  constructor(private readonly bids: BidsService) {}

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  async place(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateBidDto,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    // Only the server clock + server-side window decide acceptance. Any
    // client-sent status/time fields are stripped by the ValidationPipe
    // (whitelist) and never read here. The key is mandatory so every retry
    // replays instead of double-creating / double-debiting.
    return this.bids.placeBid(userId, dto, requireIdemKey(idemKey));
  }

  @Post('bulk')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  async bulk(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateBulkBidDto,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    return this.bids.placeBulkBid(userId, dto, requireIdemKey(idemKey));
  }

  @Get()
  async list(@CurrentUser('id') userId: string, @Query() query: ListBidsQueryDto) {
    return this.bids.listBids(userId, query);
  }

  @Get(':id')
  async detail(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.bids.getBid(userId, id);
  }

  @Post(':id/cancel')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  async cancel(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    return this.bids.cancelBid(userId, id, requireIdemKey(idemKey));
  }
}