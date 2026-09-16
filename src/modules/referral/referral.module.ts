import { Module } from '@nestjs/common';
import { ReferralController } from './referral.controller';

@Module({
  controllers: [ReferralController],
})
export class ReferralModule {}