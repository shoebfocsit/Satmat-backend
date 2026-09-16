import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cache: CacheService,
  ) {}

  @Public()
  @Get()
  root() {
    return {
      service: 'SATMAT API',
      status: 'ok',
      endpoints: {
        health: '/health',
        apiHealth: '/api/v1/health',
        docs: '/api/v1/docs',
      },
      message: 'SATMAT backend is running. See /health for a live check.',
    };
  }

  @Public()
  @Get('health')
  async health() {
    return this.doHealth();
  }

  @Public()
  @Get('api/v1/health')
  async healthV1() {
    return this.doHealth();
  }

  private async doHealth() {
    // Parallelize DB + Redis checks — saves ~60-100ms vs sequential
    const [dbRes, redisRes] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.cache.healthCheck(),
    ]);
    let db = 'ok';
    let dbError: string | null = null;
    if (dbRes.status === 'rejected') {
      db = 'down';
      dbError = (dbRes.reason as any)?.message || String(dbRes.reason);
    }
    // Both branches below assign before the read, so no initializer needed.
    let redis: string;
    if (redisRes.status === 'fulfilled') {
      redis = redisRes.value ? 'ok' : 'degraded';
    } else {
      redis = 'degraded';
    }

    const ok = db === 'ok';
    return {
      status: ok ? 'ok' : 'degraded',
      db,
      redis,
      uptime: process.uptime(),
      time: new Date().toISOString(),
      version: '1.0.0',
      env: this.config.get<string>('NODE_ENV') || 'development',
      ...(dbError ? { dbError } : {}),
    };
  }
}