import { Injectable, NotFoundException } from '@nestjs/common';
import { Market } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketStatusService } from './market-status.service';
import {
  computeLiveStatus,
  getMarketStatus,
  resolveTimezone,
} from '../../common/utils/market-time';

@Injectable()
export class MarketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly status: MarketStatusService,
  ) {}

  async listMarkets() {
    // LIVE-ONLY: no read cache — every call hits the DB so the app never
    // shows a stale snapshot. We join each market's LATEST ResultRecord so
    // cards always show the freshest declared numbers in realtime (the same
    // source the Results screen uses). resultDate travels with the numbers
    // so the UI badges them honestly: green TODAY when fresh, amber with the
    // date when the latest declare is older. Only a market with zero rows
    // renders "AWAITING". Never uses the Market.result cache column (it can
    // lag the ledger between scrape cycles).
    // Safe reader: keeps serving (with IST/active defaults) even if the prod
    // DB predates the timezone/isActive migration.
    const markets = await this.status.listMarketRows();
    const byMarket = await this.latestRecordsByMarket(markets.map((m) => m.id));
    const serverNow = new Date();
    return markets.map((m) => {
      const rec = byMarket.get(m.id);
      const result = rec
        ? `${rec.open ?? '***'}-${rec.jodi ?? '**'}-${rec.close ?? '***'}`
        : '***-**-***';
      return this.serialize({ ...m, result } as Market, rec ? rec.date : null, serverNow);
    });
  }

  async getMarket(id: string) {
    const market = await this.status.getMarketRow(id);
    if (!market) {
      throw new NotFoundException({ code: 'MARKET_NOT_FOUND', message: 'Market not found' });
    }
    // Same latest-declared source as listMarkets — never the lagging column.
    const byMarket = await this.latestRecordsByMarket([id]);
    const rec = byMarket.get(id);
    const result = rec
      ? `${rec.open ?? '***'}-${rec.jodi ?? '**'}-${rec.close ?? '***'}`
      : '***-**-***';
    return this.serialize({ ...market, result } as Market, rec ? rec.date : null);
  }

  /** Latest ResultRecord per market id (first row wins on date-desc order). */
  private async latestRecordsByMarket(ids: string[]) {
    const byMarket = new Map<string, {
      marketId: string;
      date: string;
      jodi: string | null;
      open: string | null;
      close: string | null;
    }>();
    if (ids.length === 0) return byMarket;
    const rows = await this.prisma.resultRecord.findMany({
      where: { marketId: { in: ids } },
      orderBy: { date: 'desc' },
    });
    for (const r of rows) {
      if (!byMarket.has(r.marketId)) byMarket.set(r.marketId, r);
    }
    return byMarket;
  }

  /** Server-authoritative bidding status (countdown source of truth). */
  async getStatus(id: string) {
    return this.status.getStatusById(id);
  }

  async getChart(id: string, from?: string, to?: string) {
    const market = await this.prisma.market.findUnique({ where: { id } });
    if (!market) {
      throw new NotFoundException({ code: 'MARKET_NOT_FOUND', message: 'Market not found' });
    }
    const records = await this.prisma.chartRecord.findMany({
      where: {
        marketId: id,
        ...(from || to
          ? { date: { gte: from || '0000-00-00', lte: to || '9999-99-99' } }
          : {}),
      },
      orderBy: { date: 'desc' },
    });
    // Never fabricate chart data: on a miss return [] and let the scraper
    // backfill real records. Persisting pseudo-random numbers would poison
    // real results.
    return records;
  }

  async getLatestResult(id: string) {
    const market = await this.prisma.market.findUnique({ where: { id } });
    if (!market) {
      throw new NotFoundException({ code: 'MARKET_NOT_FOUND', message: 'Market not found' });
    }
    const latest = await this.prisma.chartRecord.findFirst({
      where: { marketId: id },
      orderBy: { date: 'desc' },
    });
    if (!latest) return null;
    return {
      open: latest.open,
      jodi: latest.jodi,
      close: latest.close,
      declaredAt: new Date().toISOString(),
    };
  }

  async listGameTypes(marketId?: string) {
    // LIVE-ONLY: fresh DB read every call (tiny indexed query).
    return this.prisma.marketGameType.findMany({
      where: marketId ? { marketId } : undefined,
      orderBy: { order: 'asc' },
    });
  }

  async listGameRates() {
    // LIVE-ONLY: fresh DB read every call.
    return this.prisma.gameRate.findMany({ orderBy: { order: 'asc' } });
  }

  private serialize(market: Market, resultDate?: string | null, now = new Date()) {
    const live = computeLiveStatus(market.openTime, market.closeTime);
    // Server-authoritative bidding gate (UI hint only — POST /bids re-checks).
    const timezone = resolveTimezone((market as any).timezone);
    const active = (market as any).isActive !== false;
    const window = active
      ? getMarketStatus(market.openTime, market.closeTime, { now, timezone })
      : { status: 'CLOSED' as const, canBid: false };
    return {
      id: market.id,
      name: market.name,
      result: market.result,
      // YYYY-MM-DD of the latest ResultRecord (today when lively, older when pending)
      resultDate: resultDate ?? null,
      openTime: market.openTime,
      closeTime: market.closeTime,
      isLive: live.isLive,
      isClosed: live.isClosed,
      status: window.status,
      canBid: window.canBid,
      serverTime: now.toISOString(),
      // expose times for frontend countdowns if needed
      order: (market as any).order ?? 0,
    };
  }
}