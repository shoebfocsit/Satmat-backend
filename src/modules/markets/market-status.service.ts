import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_MARKET_TIMEZONE,
  getMarketStatus,
  marketWindowInstants,
  resolveTimezone,
  todayIST,
} from '../../common/utils/market-time';

export type MarketBidStatus = 'SCHEDULED' | 'OPEN' | 'CLOSED' | 'RESULT_DECLARED';

export interface MarketStatusPayload {
  marketId: string;
  name: string;
  timezone: string;
  status: MarketBidStatus;
  canBid: boolean;
  /** Machine-readable reason when canBid is false. */
  reason:
    | 'MARKET_INACTIVE'
    | 'RESULT_DECLARED'
    | 'NOT_OPEN_YET'
    | 'CLOSED'
    | 'INVALID_SCHEDULE';
  /** Today's open panna already declared (OPEN leg closed, CLOSE still open). */
  openDeclared: boolean;
  /** Today's close panna already declared. */
  closeDeclared: boolean;
  opensAt: string | null;
  closesAt: string | null;
  serverTime: string;
}

/**
 * Single server-side authority for "may this market accept bids right now?".
 *
 * Order of checks (fail-closed at every step):
 *   1. market exists            -> MARKET_NOT_FOUND
 *   2. market active            -> MARKET_INACTIVE
 *   3. full result declared     -> RESULT_DECLARED
 *   4. openTime <= now < close  -> SCHEDULED / OPEN / CLOSED
 *   5. leg cutoff (round=OPEN)  -> LEG_CLOSED once today's open is declared
 *
 * All times are computed from the SERVER clock in the MARKET's timezone
 * (default Asia/Kolkata). Client-supplied times/status are never accepted —
 * callers simply don't take any.
 */
@Injectable()
export class MarketStatusService implements OnModuleInit {
  private readonly logger = new Logger(MarketStatusService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Boot-time self-heal: prod DBs created before the market-bidding migration
   * (manual Render service without preDeployCommand) get the missing columns
   * within seconds of boot, so normal Prisma reads work for all later traffic.
   * Best-effort — a failure only logs, never blocks boot.
   */
  async onModuleInit() {
    await this.ensureMarketColumns().catch(() => undefined);
  }

  /** Public status payload for countdowns and UI banners (UI-only). */
  async getStatusById(marketId: string, now = new Date()): Promise<MarketStatusPayload> {
    const market = await this.loadMarket(marketId);
    if (!market) {
      throw new NotFoundException({ code: 'MARKET_NOT_FOUND', message: 'Market not found' });
    }
    return this.buildStatus(market, now);
  }

  /**
   * Throw a coded HTTP exception unless bidding is currently allowed.
   * Pass the in-transaction client so the check and the bid write share one
   * atomic unit (race protection: the window is re-validated at commit time).
   * Pass `round` to also enforce the per-leg cutoff: once today's OPEN is
   * declared, OPEN-leg bids die with LEG_CLOSED while CLOSE-leg bids live on.
   */
  async assertBiddable(
    marketId: string,
    opts: { tx?: any; now?: Date; race?: boolean; round?: 'OPEN' | 'CLOSE' } = {},
  ): Promise<{
    id: string;
    name: string;
    timezone: string;
    openTime: string;
    closeTime: string;
  }> {
    const now = opts.now ?? new Date();
    const db = opts.tx ?? this.prisma;
    const market = await this.loadMarketRow(db, marketId);
    if (!market) {
      throw new NotFoundException({ code: 'MARKET_NOT_FOUND', message: 'Market not found' });
    }
    const active = (market as Record<string, unknown>).isActive !== false;
    if (!active) {
      this.logger.warn(`bid rejected market=${marketId} reason=MARKET_INACTIVE`);
      throw new ForbiddenException({
        code: 'MARKET_INACTIVE',
        message: `Bidding is disabled for ${market.name}`,
      });
    }
    const timezone = resolveTimezone(
      (market as Record<string, unknown>).timezone ?? DEFAULT_MARKET_TIMEZONE,
    );

    if (await this.hasFullResultToday(db, marketId, now, timezone)) {
      this.logger.warn(`bid rejected market=${marketId} reason=RESULT_DECLARED`);
      throw new ForbiddenException({
        code: 'MARKET_CLOSED',
        message: `Result already declared for ${market.name}. Bidding is closed.`,
      });
    }

    const window = getMarketStatus(market.openTime, market.closeTime, { now, timezone });
    if (!window.canBid) {
      // The in-transaction re-check uses BID_WINDOW_EXPIRED so concurrent
      // requests dying at the close boundary are distinguishable in logs.
      const code =
        window.reason === 'NOT_OPEN_YET' ? 'MARKET_NOT_OPEN' : opts.race ? 'BID_WINDOW_EXPIRED' : 'MARKET_CLOSED';
      const message =
        window.reason === 'NOT_OPEN_YET'
          ? `${market.name} opens at ${market.openTime} IST. Bidding is not open yet.`
          : window.reason === 'INVALID_SCHEDULE'
            ? `Bidding is temporarily unavailable for ${market.name}.`
            : `Bidding is closed for ${market.name} (closed at ${market.closeTime} IST).`;
      this.logger.warn(
        `bid rejected market=${marketId} reason=${code} now=${now.toISOString()} open=${market.openTime} close=${market.closeTime}`,
      );
      throw new ForbiddenException({ code, message });
    }
    if (opts.round === 'OPEN' && (await this.isOpenDeclared(marketId, { tx: db, now, timezone }))) {
      this.logger.warn(`bid rejected market=${marketId} round=OPEN reason=LEG_CLOSED`);
      throw new ForbiddenException({
        code: 'LEG_CLOSED',
        message: `Open result already declared for ${market.name}. Only CLOSE bets are accepted now.`,
      });
    }
    return { id: market.id, name: market.name, timezone, openTime: market.openTime, closeTime: market.closeTime };
  }

  /**
   * True once today's OPEN panna is declared (OPEN leg closed for bidding
   * AND for cancellation; CLOSE leg unaffected until the window shuts).
   */
  async isOpenDeclared(
    marketId: string,
    opts: { tx?: any; now?: Date; timezone?: string } = {},
  ): Promise<boolean> {
    const rec = await this.getTodayRecord(
      opts.tx ?? this.prisma,
      marketId,
      opts.now ?? new Date(),
      resolveTimezone(opts.timezone ?? DEFAULT_MARKET_TIMEZONE),
    );
    return !!(rec && rec.open);
  }

  // -- internals ----------------------------------------------------------

  /**
   * List all markets, tolerating a DB that predates the timezone/isActive
   * migration (P2022): falls back to a raw select of legacy columns with
   * safe defaults, after kicking off the self-heal. Never throws P2022.
   */
  async listMarketRows(): Promise<any[]> {
    try {
      return await this.prisma.market.findMany({ orderBy: { order: 'asc' } });
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2022') throw err;
      await this.ensureMarketColumns().catch(() => undefined);
      const rows = (await this.prisma.$queryRawUnsafe(
        `SELECT "id", "name", "result", "openTime", "closeTime", "order" FROM "Market" ORDER BY "order" ASC`,
      )) as any[];
      return (rows ?? []).map((r) => ({
        ...r,
        timezone: DEFAULT_MARKET_TIMEZONE,
        isActive: true,
      }));
    }
  }

  /** Single-market variant of listMarketRows (null when missing). */
  async getMarketRow(marketId: string): Promise<any | null> {
    try {
      return await this.prisma.market.findUnique({ where: { id: marketId } });
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2022') throw err;
      await this.ensureMarketColumns().catch(() => undefined);
      const rows = (await this.prisma.$queryRawUnsafe(
        `SELECT "id", "name", "result", "openTime", "closeTime", "order" FROM "Market" WHERE "id" = $1 LIMIT 1`,
        marketId,
      )) as any[];
      const row = rows?.[0] ?? null;
      return row ? { ...row, timezone: DEFAULT_MARKET_TIMEZONE, isActive: true } : null;
    }
  }

  /** Load one market row, tolerating a prod DB that predates the migration. */
  private async loadMarketRow(db: any, marketId: string): Promise<any | null> {
    try {
      return await db.market.findUnique({ where: { id: marketId } });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2022') {
        void this.ensureMarketColumns().catch(() => undefined);
        const rows = await db.$queryRawUnsafe(
          `SELECT "id", "name", "openTime", "closeTime" FROM "Market" WHERE "id" = $1 LIMIT 1`,
          marketId,
        );
        return rows?.[0] ?? null;
      }
      throw err;
    }
  }

  private async loadMarket(marketId: string): Promise<any | null> {
    return this.loadMarketRow(this.prisma, marketId);
  }

  private async buildStatus(market: any, now: Date): Promise<MarketStatusPayload> {
    const timezone = resolveTimezone(market.timezone ?? DEFAULT_MARKET_TIMEZONE);
    const active = market.isActive !== false;
    const instants = marketWindowInstants(market.openTime, market.closeTime, { now, timezone });
    const base = {
      marketId: market.id,
      name: market.name,
      timezone,
      opensAt: instants.opensAt,
      closesAt: instants.closesAt,
      serverTime: instants.serverTime,
    };

    if (!active) {
      return {
        ...base,
        status: 'CLOSED',
        canBid: false,
        reason: 'MARKET_INACTIVE',
        openDeclared: false,
        closeDeclared: false,
      };
    }

    // try assigns, catch assigns null — no initializer needed.
    let rec: any;
    try {
      rec = await this.getTodayRecord(this.prisma, market.id, now, timezone);
    } catch {
      rec = null;
    }
    const openDeclared = !!(rec && rec.open);
    const closeDeclared = !!(rec && rec.close);
    if (rec && rec.open && rec.jodi && rec.close) {
      return {
        ...base,
        status: 'RESULT_DECLARED',
        canBid: false,
        reason: 'RESULT_DECLARED',
        openDeclared,
        closeDeclared,
      };
    }

    const window = getMarketStatus(market.openTime, market.closeTime, { now, timezone });
    return {
      ...base,
      status: window.status,
      canBid: window.canBid,
      reason:
        window.reason === 'NOT_OPEN_YET'
          ? 'NOT_OPEN_YET'
          : window.reason === 'INVALID_SCHEDULE'
            ? 'INVALID_SCHEDULE'
            : 'CLOSED',
      openDeclared,
      closeDeclared,
    };
  }

  /** Today's ResultRecord for the market (null when the provider shows Loading). */
  private async getTodayRecord(db: any, marketId: string, now: Date, timezone: string): Promise<any | null> {
    try {
      return await db.resultRecord.findUnique({
        where: { marketId_date: { marketId, date: todayIST(now, timezone) } },
      });
    } catch {
      // ResultRecord lookup failures must never break the bidding gate —
      // the time window still enforces the close rule on its own.
      return null;
    }
  }

  /** A full (open + jodi + close) ResultRecord for the market's today. */
  private async hasFullResultToday(db: any, marketId: string, now: Date, timezone: string): Promise<boolean> {
    const rec = await this.getTodayRecord(db, marketId, now, timezone);
    return !!(rec && rec.open && rec.jodi && rec.close);
  }

  /**
   * Self-heal for prod DBs where the market-bidding migration hasn't run yet
   * (manually-created Render service without preDeployCommand).
   */
  async ensureMarketColumns(): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `ALTER TABLE "Market" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata'`,
      );
      await this.prisma.$executeRawUnsafe(
        `ALTER TABLE "Market" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true`,
      );
      this.logger.log('ensureMarketColumns: Market.timezone/isActive ready');
    } catch (e) {
      this.logger.warn(`ensureMarketColumns skipped: ${(e as Error)?.message ?? e}`);
    }
  }
}
