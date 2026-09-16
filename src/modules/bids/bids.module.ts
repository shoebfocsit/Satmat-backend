import { Module } from '@nestjs/common';
import { MarketsModule } from '../markets/markets.module';
import { BidsService } from './bids.service';
import { BidsController } from './bids.controller';

@Module({
  imports: [MarketsModule],
  controllers: [BidsController],
  providers: [BidsService],
})
export class BidsModule {}