import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheStore } from './cache-store.interface';

@Injectable()
export class MemoryCache implements CacheStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryCache.name);
  private store = new Map<string, { value: any; expiresAt: number }>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private redis: any | null = null;
  private redisEnabled = false;

  constructor(private readonly config?: ConfigService) {}

  async onModuleInit() {
    const intervalMs = 60_000;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();

    const isProd = this.config?.get<string>('NODE_ENV') === 'production';
    const redisUrl = this.config?.get<string>('REDIS_URL');
    const hasRedis = !!redisUrl;
    if (isProd && !hasRedis) {
      this.logger.warn(
        'REDIS_URL not set — using in-memory cache (single instance only). Set REDIS_URL for multi-instance production.',
      );
    }
    if (redisUrl) {
      try {
        // Lazy require so tests without ioredis still pass; but we added dep.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const IORedis = require('ioredis');
        const Redis = IORedis.default || IORedis;
        this.redis = new Redis(redisUrl, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: true,
        });
        this.redis.on('error', (e: Error) => this.logger.error(`Redis error: ${e.message}`));
        await this.redis.connect().catch((e: Error) => {
          this.logger.error(`Redis connect failed, falling back to memory: ${e.message}`);
          this.redis = null;
        });
        if (this.redis) {
          this.redisEnabled = true;
          this.logger.log('Redis cache enabled');
        }
      } catch (e: any) {
        this.logger.warn(`Redis init failed (${e?.message}), using memory cache`);
        this.redis = null;
      }
    }
  }

  async onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // ignore
      }
    }
  }

  async set(key: string, value: any, ttlMs?: number): Promise<void> {
    if (this.redisEnabled && this.redis) {
      try {
        const payload = JSON.stringify(value);
        if (ttlMs) await this.redis.set(key, payload, 'PX', ttlMs);
        else await this.redis.set(key, payload);
        return;
      } catch (e: any) {
        this.logger.error(`Redis set failed for ${key}: ${e.message}, falling back to memory`);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : Number.MAX_SAFE_INTEGER,
    });
  }

  async get<T = any>(key: string): Promise<T | undefined> {
    if (this.redisEnabled && this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (raw == null) return undefined;
        try {
          return JSON.parse(raw) as T;
        } catch {
          return raw as unknown as T;
        }
      } catch (e: any) {
        this.logger.error(`Redis get failed for ${key}: ${e.message}`);
      }
    }
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async has(key: string): Promise<boolean> {
    if (this.redisEnabled && this.redis) {
      try {
        const exists = await this.redis.exists(key);
        if (exists) return true;
      } catch {
        // fall through to memory
      }
    }
    const v = await this.get(key);
    return v !== undefined;
  }

  async delete(key: string): Promise<void> {
    if (this.redisEnabled && this.redis) {
      try {
        await this.redis.del(key);
      } catch {
        // ignore
      }
    }
    this.store.delete(key);
  }

  sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (now > v.expiresAt) this.store.delete(k);
    }
  }

  // Compatibility shim for callers that still use sync-style without await in tests.
  // Keeping sync aliases so existing sync tests don't break if they forget await,
  // but all production code should await.
  getSync<T = any>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }
}