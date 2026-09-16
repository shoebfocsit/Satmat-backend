import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SentryService } from './sentry.service';
import { APP_FILTER } from '@nestjs/core';
import { SentryExceptionFilter } from './sentry.filter';

@Global()
@Module({
  providers: [
    {
      provide: SentryService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const service = new SentryService(config);
        service.init();
        return service;
      },
    },
    {
      provide: APP_FILTER,
      useClass: SentryExceptionFilter,
    },
  ],
  exports: [SentryService],
})
export class SentryModule {}