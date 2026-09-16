import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { PublicAwareThrottlerGuard } from './common/guards/public-aware-throttler.guard';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { CacheModule } from './common/cache/cache.module';
import { ProvidersModule } from './common/providers/providers.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { SentryModule } from './common/sentry/sentry.module';
import { validateEnv } from './common/config/env.validation';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { MarketsModule } from './modules/markets/markets.module';
import { ResultsModule } from './modules/results/results.module';
import { ChartsModule } from './modules/charts/charts.module';
import { BidsModule } from './modules/bids/bids.module';
import { OrdersModule } from './modules/orders/orders.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { NoticesModule } from './modules/notices/notices.module';
import { ContentModule } from './modules/content/content.module';
import { ReferralModule } from './modules/referral/referral.module';
import { SupportModule } from './modules/support/support.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SyncModule } from './modules/sync/sync.module';
import { AiModule } from './modules/ai/ai.module';
import { NewsletterModule } from './modules/newsletter/newsletter.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';
import { ScraperModule } from './modules/scraper/scraper.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, expandVariables: true }),
    ScheduleModule.forRoot(),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: {
          expiresIn: parseInt(config.get('ACCESS_TOKEN_TTL') || '900', 10),
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [{
        ttl: parseInt(config.get('THROTTLE_TTL') || '60000', 10),
        limit: parseInt(config.get('THROTTLE_LIMIT') || '60', 10),
      }],
    }),
    PrismaModule,
    CacheModule,
    ProvidersModule,
    SentryModule,
    AuthModule,
    UsersModule,
    MarketsModule,
    ResultsModule,
    ChartsModule,
    BidsModule,
    OrdersModule,
    WalletModule,
    NoticesModule,
    ContentModule,
    ReferralModule,
    SupportModule,
    NotificationsModule,
    SyncModule,
    AiModule,
    NewsletterModule,
    AdminModule,
    HealthModule,
    ScraperModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: PublicAwareThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
export class AppModule {}