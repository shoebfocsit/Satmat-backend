import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheStore } from './cache-store.interface';
import Redis from 'ioredis';

@Injectable()
export class RedisCache implements CacheStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCache.name);
  private client: Redis | null = null;
  private isConnected = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.warn('REDIS_URL not configured - Redis cache unavailable');
      return;
    }

    try {
      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: true,
        retryStrategy: (times) => {
          if (times > 3) {
            this.logger.error('Redis max retries reached, giving up');
            return null;
          }
          return Math.min(times * 200, 2000);
        },
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.logger.log('Redis connected');
      });

      this.client.on('ready', () => {
        this.isConnected = true;
        this.logger.log('Redis ready');
      });

      this.client.on('error', (err) => {
        this.logger.error(`Redis error: ${err.message}`);
        this.isConnected = false;
      });

      this.client.on('close', () => {
        this.isConnected = false;
        this.logger.warn('Redis connection closed');
      });

      this.client.on('reconnecting', () => {
        this.logger.log('Redis reconnecting...');
      });

      await this.client.connect();
    } catch (err: any) {
      this.logger.error(`Redis initialization failed: ${err.message}`);
      this.client = null;
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      try {
        await this.client.quit();
      } catch (err) {
        this.logger.error(`Error closing Redis connection: ${err}`);
      }
    }
  }

  private ensureConnected(): void {
    if (!this.client || !this.isConnected) {
      throw new Error('Redis not connected');
    }
  }

  async set(key: string, value: any, ttlMs?: number): Promise<void> {
    this.ensureConnected();
    const payload = JSON.stringify(value);
    if (ttlMs) {
      await this.client!.set(key, payload, 'PX', ttlMs);
    } else {
      await this.client!.set(key, payload);
    }
  }

  async get<T = any>(key: string): Promise<T | undefined> {
    this.ensureConnected();
    const raw = await this.client!.get(key);
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async has(key: string): Promise<boolean> {
    this.ensureConnected();
    const exists = await this.client!.exists(key);
    return exists === 1;
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    await this.client!.del(key);
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client || !this.isConnected) return false;
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}