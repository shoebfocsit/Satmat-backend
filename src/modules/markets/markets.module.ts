import { Module } from '@nestjs/common';
import { MarketsService } from './markets.service';
import { MarketStatusService } from './market-status.service';
import { MarketsController } from './markets.controller';

@Module({
  controllers: [MarketsController],
  providers: [MarketsService, MarketStatusService],
  exports: [MarketsService, MarketStatusService],
})
export class MarketsModule {}