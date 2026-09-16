import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeDate, SourceAdapterRegistry } from './source/source-adapter';
import { SatmatWebAdapter } from './source/satmat-web.adapter';

// Full provider history runs ~2019→today (≈2600 days). One indexed range
// query + a few hundred KB of JSON is cheap on demand (charts are pulled,
// never polled), so allow a decade per request instead of forcing clients
// to stitch year-chunks.
const MAX_RANGE_DAYS = 3700;

@Injectable()
export class ChartsService {
  private readonly adapterName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SourceAdapterRegistry,
    private readonly satmatWebAdapter: SatmatWebAdapter,
    config: ConfigService,
  ) {
    this.adapterName = config.get('SOURCE_ADAPTER') || 'satmat-web';
    // Register the adapters so the registry can resolve them.
    this.registry.register(this.satmatWebAdapter);
  }

  /**
   * Returns result records for a market over an inclusive [startDate, endDate]
   * range. Validation is strict and explicit; missing dates are reported
   * honestly and are never filled in with fabricated values.
   */
  async getChart(
    market?: string,
    startDate?: string,
    endDate?: string,
  ) {
    if (!market) {
      throw new BadRequestException({
        code: 'MARKET_REQUIRED',
        message: 'Query parameter "market" is required',
      });
    }

    const marketRow = await this.prisma.resultMarket.findUnique({
      where: { id: market },
    });
    // Gracefully handle Market ids (e.g. kalyan-morning) that exist in Market table
    // but not in ResultMarket — return empty 200 instead of 404 to avoid frontend ChunkLoadError spam.
    let marketName: string | undefined = marketRow?.name;
    if (!marketRow) {
      const fallback = await this.prisma.market.findUnique({ where: { id: market } });
      marketName = fallback?.name ?? market;
      // marketRow stays null; the empty-200 path after validation handles it.
    }

    if (!startDate) {
      throw new BadRequestException({
        code: 'START_DATE_REQUIRED',
        message: 'Query parameter "startDate" (YYYY-MM-DD) is required',
      });
    }
    if (!endDate) {
      throw new BadRequestException({
        code: 'END_DATE_REQUIRED',
        message: 'Query parameter "endDate" (YYYY-MM-DD) is required',
      });
    }

    const start = normalizeDate(startDate);
    const end = normalizeDate(endDate);
    if (!start) {
      throw new BadRequestException({
        code: 'INVALID_DATE',
        message: 'startDate must be a valid YYYY-MM-DD date',
        details: { startDate },
      });
    }
    if (!end) {
      throw new BadRequestException({
        code: 'INVALID_DATE',
        message: 'endDate must be a valid YYYY-MM-DD date',
        details: { endDate },
      });
    }
    if (start > end) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: 'startDate must not be after endDate',
        details: { startDate: start, endDate: end },
      });
    }

    const rangeDays =
      Math.round(
        (Date.parse(end + 'T00:00:00Z') -
          Date.parse(start + 'T00:00:00Z')) /
          86400000,
      ) + 1;
    if (rangeDays > MAX_RANGE_DAYS) {
      throw new BadRequestException({
        code: 'RANGE_TOO_LARGE',
        message: `Date range must not exceed ${MAX_RANGE_DAYS} days`,
        details: { max: MAX_RANGE_DAYS, requested: rangeDays },
      });
    }

    // If market not in ResultMarket, return empty 200 instead of 404 —
    // frontend shows "No results" gracefully. LIVE-ONLY: no cache anywhere
    // in this endpoint; every call reads fresh DB rows.
    if (!marketRow) {
      const missingDates: string[] = [];
      const cursor = new Date(start + 'T00:00:00Z');
      const endDt = new Date(end + 'T00:00:00Z');
      while (cursor <= endDt) {
        missingDates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return {
        market: marketName ?? market,
        marketId: market,
        startDate: start,
        endDate: end,
        source: this.adapterName,
        count: 0,
        data: [],
        missingDates,
      };
    }

    // Fresh DB read. The background ScrapeScheduler is responsible for
    // populating ResultRecord from the provider; this endpoint must NOT block the
    // single-threaded event loop on a synchronous live fetch on a DB miss —
    // doing so starved concurrent auth/market requests and made data loads slow.
    const records = await this.prisma.resultRecord.findMany({
      where: { marketId: market, date: { gte: start, lte: end } },
      orderBy: { date: 'asc' },
    });

    const data = records.map((r) => ({
      date: r.date,
      jodi: r.jodi,
      panel: r.panel,
      open: r.open,
      close: r.close,
      source: r.source,
    }));

    const present = new Set(records.map((r) => r.date));
    const missingDates: string[] = [];
    const cursor = new Date(start + 'T00:00:00Z');
    const endDt = new Date(end + 'T00:00:00Z');
    while (cursor <= endDt) {
      const d = cursor.toISOString().slice(0, 10);
      if (!present.has(d)) missingDates.push(d);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return {
      market: marketRow.name,
      marketId: marketRow.id,
      startDate: start,
      endDate: end,
      source: this.adapterName,
      count: data.length,
      data,
      missingDates,
    };
  }
}
