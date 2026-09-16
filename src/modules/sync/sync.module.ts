import { Module } from '@nestjs/common';
import { MarketsModule } from '../markets/markets.module';
import { SyncController } from './sync.controller';

@Module({
  imports: [MarketsModule],
  controllers: [SyncController],
})
export class SyncModule {}