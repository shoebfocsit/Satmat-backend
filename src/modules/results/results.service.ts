import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { todayIST } from '../../common/utils/market-time';

@Injectable()
export class ResultsService {
  private readonly logger = new Logger(ResultsService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Today's provider-published lucky numbers (Ank + Final Ank), or null when
   * the provider hasn't published yet. LIVE-ONLY: fresh DB read, never
   * fabricated — null honestly means "awaiting".
   *
   * NEVER throws: a missing table (migration not yet applied in prod),
   * a stale Prisma client without the delegate, or any transient DB error
   * all resolve to null so GET /lucky-number stays HTTP 200 (null) instead
   * of HTTP 500 spamming the client poll loop.
   */
  async getLuckyNumber() {
    try {
      const delegate = (this.prisma as unknown as Record<string, unknown>)[
        'luckyNumber'
      ] as { findUnique?: (args: unknown) => Promise<unknown> } | undefined;
      if (!delegate || typeof delegate.findUnique !== 'function') {
        return null;
      }
      const row = (await delegate.findUnique({
        where: { date: todayIST() },
      })) as { date: string; ank: string; finalAnk: string; source: string } | null;
      if (!row) return null;
      return { date: row.date, ank: row.ank, finalAnk: row.finalAnk, source: row.source };
    } catch (err) {
      // P2021 = table does not exist (migration pending), P2022 = column
      // missing, P1001/P1002/P1017 = DB unreachable — all mean "awaiting".
      const code = (err as { code?: string })?.code;
      this.logger.warn(
        `getLuckyNumber degraded to null${code ? ` (${code})` : ''}: ${(err as Error)?.message ?? err}`,
      );
      // Self-heal: if the table is missing (prod DB predates the
      // lucky-number migration and Render preDeploy never ran), create it
      // inline so the next scrape cycle can store rows. Fire-and-forget —
      // this request still returns null ("awaiting").
      if (code === 'P2021' || code === 'P2022') {
        void this.ensureLuckyNumberTable().catch(() => undefined);
      }
      return null;
    }
  }

  /**
   * CREATE TABLE IF NOT EXISTS fallback for prod DBs where the
   * `20260907112635_lucky_number` migration hasn't been applied (e.g. a
   * manually-created Render service without preDeployCommand). Mirrors
   * prisma/migrations/20260907112635_lucky_number/migration.sql exactly.
   */
  private async ensureLuckyNumberTable(): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "LuckyNumber" (` +
          `"id" TEXT NOT NULL, ` +
          `"date" TEXT NOT NULL, ` +
          `"ank" TEXT NOT NULL, ` +
          `"finalAnk" TEXT NOT NULL, ` +
          `"source" TEXT NOT NULL DEFAULT 'vip', ` +
          `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ` +
          `"updatedAt" TIMESTAMP(3) NOT NULL, ` +
          `CONSTRAINT "LuckyNumber_pkey" PRIMARY KEY ("id"))`,
      );
      await this.prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "LuckyNumber_date_key" ON "LuckyNumber"("date")`,
      );
      await this.prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "LuckyNumber_date_idx" ON "LuckyNumber"("date")`,
      );
      this.logger.log('ensureLuckyNumberTable: LuckyNumber table ready');
    } catch (e) {
      this.logger.warn(`ensureLuckyNumberTable skipped: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * Returns the result markets with their latest declared result (if any).
   * `highlight` marks the markets the UI must emphasize; `result` is null when
   * no record exists yet (the UI renders a "not declared" placeholder).
   * LIVE-ONLY: no read cache — always fresh from DB.
   */
  async getResults() {
    const markets = await this.prisma.resultMarket.findMany({
      orderBy: { order: 'asc' },
    });
    const ids = markets.map((m) => m.id);

    const latest = await this.prisma.resultRecord.findMany({
      where: { marketId: { in: ids } },
      orderBy: { date: 'desc' },
    });
    const latestByMarket = new Map<string, (typeof latest)[number]>();
    for (const rec of latest) {
      if (!latestByMarket.has(rec.marketId)) {
        latestByMarket.set(rec.marketId, rec);
      }
    }

    return {
      updatedAt: new Date().toISOString(),
      markets: markets.map((m) => {
        const rec = latestByMarket.get(m.id);
        return {
          id: m.id,
          name: m.name,
          highlight: m.highlight,
          openTime: m.openTime,
          closeTime: m.closeTime,
          result: rec
            ? {
                jodi: rec.jodi,
                panel: rec.panel,
                open: rec.open,
                close: rec.close,
                date: rec.date,
                source: rec.source,
              }
            : null,
        };
      }),
    };
  }
}
