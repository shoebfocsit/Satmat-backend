import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      // Disable verbose query logging even in dev — it adds ~5-15ms synchronous I/O per query
      // and floods Render logs. Enable with PRISMA_LOG=query if you need it locally.
      log:
        process.env.PRISMA_LOG === 'query'
          ? ['query', 'error', 'warn']
          : ['error'],
      // Pool tuning: via DATABASE_URL params (pgbouncer=true&connection_limit=10&pool_timeout=10)
      // No engine config needed here — Prisma respects the URL params.
      // We also enable accelerate-style retry without adding a dependency.
    });
  }

  async onModuleInit() {
    const maxRetries = 5;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.$connect();
        this.logger.log('Prisma connected');
        // Warm the connection pool with a lightweight query to avoid first-request
        // latency (pgbouncer handshake + TLS can be 200-400ms). This runs once at boot.
        try {
          await this.$queryRaw`SELECT 1`;
          this.logger.log('Prisma warm query ok');
        } catch {
          // Best-effort warm-up only; the connection itself already succeeded.
        }
        return;
      } catch (e: any) {
        lastErr = e;
        // Log full shape so Render shows host/DNS/auth vs pgbouncer issue (was only e.message before and got truncated)
        this.logger.warn(`Prisma connect attempt ${attempt}/${maxRetries} failed: ${e.message}`);
        console.error(`[Prisma] attempt ${attempt} error:`, e.message);
        if (e.code) console.error(`[Prisma] code:`, e.code);
        if (e.meta) console.error(`[Prisma] meta:`, JSON.stringify(e.meta).slice(0, 1000));
        console.error(`[Prisma] stack:`, e.stack?.split('\n').slice(0, 6).join(' | ').slice(0, 1200));
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, attempt * 800));
      }
    }
    this.logger.error('Prisma failed to connect after retries', lastErr as any);
    console.error('[Prisma] FINAL FAILURE — check DATABASE_URL host/port and Supabase pooler vs DIRECT_URL');
    console.error('[Prisma] DATABASE_URL masked:', String(process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@').slice(0, 120));
    console.error('[Prisma] DIRECT_URL masked:', String(process.env.DIRECT_URL || '').replace(/:[^:@/]+@/, ':***@').slice(0, 120));
    throw lastErr;
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}