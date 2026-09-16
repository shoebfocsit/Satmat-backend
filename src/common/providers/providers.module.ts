import { Global, Module } from '@nestjs/common';
import { paymentProviderFactory } from './payment.provider';
import { smsProviderFactory } from './sms.provider';
import { pushProviderFactory } from './push.provider';

@Global()
@Module({
  providers: [
    paymentProviderFactory,
    smsProviderFactory,
    pushProviderFactory,
  ],
  exports: [
    paymentProviderFactory,
    smsProviderFactory,
    pushProviderFactory,
  ],
})
export class ProvidersModule {}

export type {
  PaymentProvider,
  DepositOrder,
  CreateDepositOrderInput,
} from './payment.provider';
export type { SmsProvider } from './sms.provider';
export type { PushProvider, PushNotification } from './push.provider';