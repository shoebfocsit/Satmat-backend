import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { WalletModule } from '../wallet/wallet.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [WalletModule],
  controllers: [AdminController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AdminModule {}