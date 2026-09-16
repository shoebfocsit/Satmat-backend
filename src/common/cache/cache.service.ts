import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheStore } from './cache-store.interface';
import { RedisCache } from './redis-cache';
import { MemoryCache } from './memory-cache';

@Injectable()
export class CacheService implements CacheStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private store: CacheStore;

  constructor(
    private readonly config: ConfigService,
    private readonly redisCache: RedisCache,
    private readonly memoryCache: MemoryCache,
  ) {
    const isProd = this.config.get<string>('NODE_ENV') === 'production';
    const redisUrl = this.config.get<string>('REDIS_URL');
    const hasRedis = !!redisUrl;

    if (isProd) {
      if (hasRedis) {
        this.store = this.redisCache;
        this.logger.log('Using Redis cache for production');
      } else {
        this.store = this.memoryCache;
        this.logger.warn('Production without Redis — using in-memory cache (single instance only). Set REDIS_URL for multi-instance deployments.');
      }
    } else if (hasRedis) {
      this.store = this.redisCache;
      this.logger.log('Using Redis cache (configured via REDIS_URL)');
    } else {
      this.store = this.memoryCache;
      this.logger.warn('Using in-memory cache (development only). Set REDIS_URL for production.');
    }
  }

  async onModuleInit() {
    // RedisCache and MemoryCache handle their own initialization
  }

  async onModuleDestroy() {
    await this.store.delete('__health_check__'); // trigger cleanup if needed
  }

  async set(key: string, value: any, ttlMs?: number): Promise<void> {
    try {
      return await this.store.set(key, value, ttlMs);
    } catch (e: any) {
      this.logger.warn(`Cache set failed for ${key}: ${e?.message}, falling back to memory`);
      if (this.store !== this.memoryCache) {
        return this.memoryCache.set(key, value, ttlMs);
      }
      throw e;
    }
  }

  async get<T = any>(key: string): Promise<T | undefined> {
    try {
      return await this.store.get<T>(key);
    } catch (e: any) {
      this.logger.warn(`Cache get failed for ${key}: ${e?.message}, falling back to memory`);
      if (this.store !== this.memoryCache) {
        return this.memoryCache.get<T>(key);
      }
      return undefined;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      return await this.store.has(key);
    } catch (e: any) {
      this.logger.warn(`Cache has failed for ${key}: ${e?.message}`);
      if (this.store !== this.memoryCache) {
        return this.memoryCache.has(key);
      }
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      return await this.store.delete(key);
    } catch (e: any) {
      this.logger.warn(`Cache delete failed for ${key}: ${e?.message}`);
      if (this.store !== this.memoryCache) {
        return this.memoryCache.delete(key);
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    if (this.store instanceof RedisCache) {
      return this.store.healthCheck();
    }
    // Memory cache is always "healthy" if the process is running
    return true;
  }
}