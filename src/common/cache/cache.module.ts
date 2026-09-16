import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from './cache.service';
import { MemoryCache } from './memory-cache';
import { RedisCache } from './redis-cache';

@Global()
@Module({
  providers: [
    RedisCache,
    MemoryCache,
    {
      provide: CacheService,
      inject: [ConfigService, RedisCache, MemoryCache],
      useFactory: (config: ConfigService, redis: RedisCache, memory: MemoryCache) =>
        new CacheService(config, redis, memory),
    },
  ],
  exports: [CacheService, RedisCache, MemoryCache],
})
export class CacheModule {}