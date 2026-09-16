import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SatmatWebAdapter } from '../charts/source/satmat-web.adapter';
import { todayIST, nowMinutesIST, resolveSessionDate, parseTimeToMinutes, formatTimeMinutes } from '../../common/utils/market-time';
export interface ScrapeMarketResult {
  marketId: string;
  records: number;
  resultRecord: number;
  chartRecord: number;
  latestResult: string | null;
}

export interface ScrapeRunStatus {
  enabled: boolean;
  runsCompleted: number;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: ScrapeMarketResult[];
  /** Fast homepage live snapshot (today's declares, one fetch). */
  liveSnapshot: { at: string; count: number } | null;
  /** Deep-history backfill (full provider history per market, one-off). */
  lastBackfill: { at: string; markets: number; records: number } | null;
  /** Last official-schedule sync (site table -> Market/ResultMarket timings). */
  lastScheduleSync: { at: string; updated: string[] } | null;
}

function isoToday(): string {
  // IST date, not UTC: Render runs on UTC, but markets declare on IST days.
  // UTC-based today missed the current IST date every night 00:00–05:30 IST.
  return todayIST();
}

function addDays(isoDate: string, days: number): string {
  const dt = new Date(isoDate + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Continuously fetches realtime results from the configured scraper adapter and
 * upserts them into the DB cache (`ResultRecord`, `ChartRecord`, `Market.result`).
 *
 * Runs once on boot and then on a configurable interval
 * (`SCRAPE_INTERVAL_MS`, default 5 minutes) while `SCRAPE_ENABLED=true`. Each
 * cycle is a no-op while the previous one is still running, so slow provider
 * responses never stack up. Failures are logged and surfaced in `status` but
 * never crash the process.
 */
@Injectable()
export class ScrapeScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScrapeScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private running = false;
  private snapshotRunning = false;

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly snapshotIntervalMs: number;
  private readonly windowDays: number;
  private readonly autoCreateResultMarkets: boolean;
  private readonly fetchConcurrency: number;
  private readonly backfillFrom: string;
  private readonly backfillLookbackDays: number;
  private backfilling = false;

  readonly status: ScrapeRunStatus = {
    enabled: false,
    runsCompleted: 0,
    lastRunAt: null,
    lastDurationMs: null,
    lastError: null,
    lastResult: [],
    liveSnapshot: null,
    lastBackfill: null,
    lastScheduleSync: null,
  };

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly adapter: SatmatWebAdapter,
  ) {
    this.enabled = config.get<string>('SCRAPE_ENABLED') === 'true';
    // Default 3 min (was 5): declare-to-app latency for live users. The cycle
    // self-throttles (skips while running), so a slow provider can't stack up.
    // Override per-env with SCRAPE_INTERVAL_MS. Homepage snapshot rides free.
    this.intervalMs = Number(config.get('SCRAPE_INTERVAL_MS') || 180000);
    // Live snapshot cadence (default 45s): one cheap homepage fetch carrying
    // today's declares + lucky numbers. Runs far more often than the heavy
    // 14-page panel cycle so a global release lands in-app within a minute.
    // Override per-env with SCRAPE_SNAPSHOT_INTERVAL_MS (min 15s guard below).
    this.snapshotIntervalMs = Math.max(
      15000,
      Number(config.get('SCRAPE_SNAPSHOT_INTERVAL_MS') || 45000),
    );
    this.windowDays = Number(config.get('SCRAPE_WINDOW_DAYS') || 14);
    this.autoCreateResultMarkets =
      config.get<string>('SCRAPE_AUTO_CREATE_RESULT_MARKETS') === 'true';
    this.fetchConcurrency = Math.max(
      1,
      Math.min(10, Number(config.get('SCRAPE_FETCH_CONCURRENCY') || 5)),
    );
    // Deep-history backfill: provider panel pages hold FULL history (2019+)
    // in a single fetch. Markets whose oldest stored row is newer than
    // `lookback` days get one full fetch so charts show the same complete
    // history as the source site. Steady cycles stay on the small rolling
    // window afterwards (upserts never delete old rows).
    this.backfillFrom = config.get<string>('SCRAPE_BACKFILL_FROM') || '2019-01-01';
    this.backfillLookbackDays = Number(config.get('SCRAPE_BACKFILL_LOOKBACK_DAYS') || 90);
  }

  async onModuleInit() {
    this.status.enabled = this.enabled;
    if (!this.enabled) {
      this.logger.warn(
        'Scraper scheduler disabled (set SCRAPE_ENABLED=true to enable).',
      );
      return;
    }
    if (this.intervalMs < 10000) {
      this.logger.warn(
        `SCRAPE_INTERVAL_MS=${this.intervalMs} is very aggressive; consider >= 60000.`,
      );
    }
    this.logger.log(
      `Scraper scheduler enabled: every ${this.intervalMs}ms, window ${this.windowDays}d, concurrency=${this.fetchConcurrency}.`,
    );
    this.logger.log(
      `Live snapshot every ${this.snapshotIntervalMs}ms (today's declares + lucky numbers).`,
    );
    void this.runCycle();
    // Deep-history backfill rides in the background (skips markets that are
    // already deep). Failures never block boot or the rolling cycle.
    void this.backfillHistory().catch(() => undefined);
    this.timer = setInterval(() => void this.runCycle(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // Fast lane for global releases: homepage snapshot (+ lucky numbers)
    // refreshes on its own cadence, independent of the heavy panel cycle.
    void this.refreshLiveSnapshot().catch(() => undefined);
    this.snapshotTimer = setInterval(() => void this.refreshLiveSnapshot().catch(() => undefined), this.snapshotIntervalMs);
    if (typeof this.snapshotTimer.unref === 'function') this.snapshotTimer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
  }

  /**
   * Fast lane: one homepage fetch carrying today's declares (+ lucky
   * numbers) straight into ResultRecord, session-dated exactly like the
   * rolling cycle does. Self-guarded (never overlaps itself) and never
   * throws — failures are logged and retried on the next tick.
   */
  async refreshLiveSnapshot(): Promise<void> {
    if (this.snapshotRunning) return;
    this.snapshotRunning = true;
    try {
      const to = isoToday();
      let timingById = new Map<string, { openTime: string; closeTime: string }>();
      try {
        const timingRows = await this.prisma.market.findMany({
          select: { id: true, openTime: true, closeTime: true },
        });
        timingById = new Map(timingRows.map((m) => [m.id, m]));
      } catch (err) {
        this.logger.warn(`[live] timing lookup skipped: ${(err as Error).message}`);
        return;
      }
      const nowMin = nowMinutesIST();

      // Fast live snapshot first (one homepage fetch): today's declares land
      // in DB within seconds, before the heavier 14-page panel cycle finishes.
      // Each row is session-dated (never blindly "today"): a full row for a
      // session that hasn't closed is yesterday's leftover still displayed on
      // the provider homepage — dating it today would pollute charts.
      // Failures here never fail the cycle — panels backfill after.
      try {
        const liveStart = Date.now();
        const live = await this.adapter.fetchLiveSnapshot();
        const dated = live.flatMap((r) => {
          const t = timingById.get(r.marketId);
          if (!t) return [];
          const isFull = !!(r.open && r.jodi && r.close);
          const date = resolveSessionDate(t.openTime, t.closeTime, isFull, to, nowMin);
          if (!date) return [];
          return [{
            marketId: r.marketId,
            date,
            jodi: r.jodi,
            panel: r.open,
            open: r.open,
            close: r.close,
            source: 'vip-live',
          }];
        });
        if (dated.length > 0) {
          await this.upsertResultRecords(dated);
          this.status.liveSnapshot = { at: new Date().toISOString(), count: dated.length };
          this.logger.log(`[live] homepage snapshot: ${dated.length}/${live.length} row(s) session-dated [${Date.now() - liveStart}ms]`);
        }
      } catch (err) {
        this.logger.warn(`[live] homepage snapshot skipped: ${(err as Error).message}`);
      }

      // Lucky numbers ride the same homepage fetch (one extra cheap call).
      // Absent block => nothing stored => UI honestly shows "awaiting".
      try {
        const lucky = await this.adapter.fetchLuckyNumber();
        if (lucky) {
          await this.prisma.luckyNumber.upsert({
            where: { date: to },
            update: { ank: lucky.ank, finalAnk: lucky.finalAnk, source: 'vip' },
            create: { date: to, ank: lucky.ank, finalAnk: lucky.finalAnk, source: 'vip' },
          });
          this.logger.log(`[live] lucky number stored for ${to}: ${lucky.ank} / ${lucky.finalAnk}`);
        }
      } catch (err) {
        this.logger.warn(`[live] lucky number skipped: ${(err as Error).message}`);
      }
    } finally {
      this.snapshotRunning = false;
    }
  }

  /** Runs one full scrape cycle; safe to call from tests / admin endpoints. */
  async runCycle(): Promise<ScrapeRunStatus> {
    if (this.running) {
      this.logger.warn('Scrape cycle still running; skipping this tick.');
      return this.status;
    }
    this.running = true;
    const started = Date.now();
    try {
      const marketIds = this.adapter.marketIds();
      if (marketIds.length === 0) {
        throw new Error('No markets configured (SCRAPE_MARKET_URLS is empty).');
      }

      const to = isoToday();
      const from = addDays(to, -(this.windowDays - 1));

      // Fast lane first: today's homepage declares (+ lucky numbers) land in
      // DB on the snapshot cadence as well as every panel cycle, so a global
      // release shows in-app within about a minute.
      await this.refreshLiveSnapshot();

      // Official timings ride free: the site's schedule table is the only
      // source of market windows (see syncMarketSchedules).
      try {
        await this.syncMarketSchedules();
      } catch (err) {
        this.logger.warn(`[schedule] sync skipped: ${(err as Error).message}`);
      }

      // Fetch markets with bounded concurrency so cycle time stays well under
      // the interval even with dozens of provider panel charts (fetching them
      // one-by-one could exceed the interval and skip ticks on cold start).
      const limit = this.fetchConcurrency;
      const result: ScrapeMarketResult[] = new Array(marketIds.length);

      let next = 0;
      let failures = 0;
      let firstError: string | null = null;
      const worker = async (workerId: number) => {
        for (;;) {
          const i = next++;
          if (i >= marketIds.length) return;
          const marketId = marketIds[i];
          const startTime = Date.now();
          try {
            const records = await this.adapter.fetchRecords(marketId, from, to);
            const entry = await this.persist(marketId, records);
            result[i] = entry;
            const elapsed = Date.now() - startTime;
            this.logger.log(
              `[worker ${workerId}] ${marketId}: ${entry.records} record(s) ` +
                `(result=${entry.resultRecord}, chart=${entry.chartRecord}) [${elapsed}ms]`,
            );
          } catch (err) {
            const elapsed = Date.now() - startTime;
            const message = (err as Error).message;
            const isCloudflare =
              message.includes('Cloudflare') ||
              message.includes('Just a moment') ||
              message.includes('Managed Challenge') ||
              message.includes('challenges.cloudflare.com');
            // Cloudflare Turnstile is an infra/config issue (wrong mirror or missing proxy),
            // not a transient app failure — log as WARN to avoid spamming ERROR alerts
            // every 5 min for a single market while the rest of the cycle succeeds.
            if (isCloudflare) {
              this.logger.warn(
                `[worker ${workerId}] ${marketId} SKIPPED [${elapsed}ms]: ${message}`,
              );
            } else {
              this.logger.error(
                `[worker ${workerId}] ${marketId} FAILED [${elapsed}ms]: ${message}`,
              );
            }
            failures += 1;
            if (!firstError) firstError = message;
            result[i] = {
              marketId,
              records: 0,
              resultRecord: 0,
              chartRecord: 0,
              latestResult: null,
            };
          }
        }
      };

      await Promise.all(
        Array.from({ length: limit }, (_, i) => worker(i + 1)),
      );

      // Self-heal + recompute so every cycle ends in a provably honest state
      // (cleans legacy misdated rows and provider carry-forward duplicates).
      try {
        const healed = await this.healResultDates(marketIds);
        if (healed > 0) this.logger.log(`[heal] removed ${healed} misdated/duplicate row(s)`);
        await this.refreshMarketResults(marketIds);
      } catch (err) {
        this.logger.warn(`[heal] skipped: ${(err as Error).message}`);
      }

      this.status.lastResult = result;
      if (failures === marketIds.length && marketIds.length > 0) {
        // Total failure: surface it and don't count the run as completed.
        this.status.lastError = firstError;
      } else {
        if (failures > 0) {
          this.status.lastError = `${failures}/${marketIds.length} markets failed (first: ${firstError})`;
        } else {
          this.status.lastError = null;
        }
        this.status.runsCompleted += 1;
      }
    } catch (err) {
      this.status.lastError = (err as Error).message;
      this.logger.error(`Scrape cycle failed: ${(err as Error).message}`);
    } finally {
      this.status.lastRunAt = new Date().toISOString();
      this.status.lastDurationMs = Date.now() - started;
      this.running = false;
    }
    return this.status;
  }

  /**
   * Deep-history backfill: fetches each market's FULL provider history
   * (provider panel pages hold everything since ~2019 in one fetch) and
   * persists it, so charts show the same complete history as the source site.
   *
   * Runs automatically on boot for markets whose oldest stored row is newer
   * than SCRAPE_BACKFILL_LOOKBACK_DAYS (default 90d) — i.e. exactly once per
   * database lifetime, never on steady cold starts. `force=true` (admin
   * endpoint) refills every market regardless. Upserts are idempotent;
   * per-market failures are logged and skipped, never fatal.
   */
  async backfillHistory(force = false): Promise<{ markets: number; records: number }> {
    if (this.backfilling) {
      this.logger.warn('History backfill already running; skipping.');
      return { markets: 0, records: 0 };
    }
    if (!this.enabled) return { markets: 0, records: 0 };
    this.backfilling = true;
    const started = Date.now();
    let markets = 0;
    let records = 0;
    try {
      const marketIds = this.adapter.marketIds();
      if (marketIds.length === 0) {
        this.logger.warn('History backfill skipped: no markets configured.');
        return { markets, records };
      }
      const to = isoToday();
      const from = this.backfillFrom < to ? this.backfillFrom : to;
      const cutoff = addDays(to, -Math.max(1, this.backfillLookbackDays));

      const pending: string[] = [];
      for (const marketId of marketIds) {
        if (!force) {
          let oldest: { date: string } | null = null;
          try {
            oldest = await this.prisma.resultRecord.findFirst({
              where: { marketId },
              orderBy: { date: 'asc' },
              select: { date: true },
            });
          } catch (err) {
            this.logger.warn(`[backfill] ${marketId} oldest-date check skipped: ${(err as Error).message}`);
            continue;
          }
          if (oldest && oldest.date <= cutoff) continue; // already deep
        }
        pending.push(marketId);
      }
      if (pending.length === 0) {
        this.logger.log('[backfill] all markets already hold deep history; nothing to do.');
        return { markets, records };
      }
      this.logger.log(`[backfill] filling ${pending.length}/${marketIds.length} market(s) from ${from} to ${to}…`);

      let next = 0;
      const worker = async (workerId: number) => {
        for (;;) {
          const i = next++;
          if (i >= pending.length) return;
          const marketId = pending[i];
          try {
            // mergeFallback: fold in fallback-mirror dates the primary lacks.
            const recs = await this.adapter.fetchRecords(marketId, from, to, { mergeFallback: true });
            const entry = await this.persist(marketId, recs);
            markets += 1;
            records += entry.records;
            this.logger.log(
              `[backfill worker ${workerId}] ${marketId}: ${entry.records} record(s) stored`,
            );
          } catch (err) {
            this.logger.warn(`[backfill worker ${workerId}] ${marketId} skipped: ${(err as Error).message}`);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(this.fetchConcurrency, pending.length) }, (_, i) => worker(i + 1)),
      );

      this.status.lastBackfill = { at: new Date().toISOString(), markets, records };
      this.logger.log(`[backfill] done: ${records} record(s) across ${markets} market(s) [${Date.now() - started}ms]`);
    } finally {
      this.backfilling = false;
    }
    return { markets, records };
  }

  /**
   * Official-schedule sync: the provider's schedule table
   * (Market | Open | Close) is the ONLY source of market timings — the app
   * must run exactly the site's windows (bidding gate, countdowns, charts
   * all derive from these). Rows with unknown names or malformed times are
   * skipped; updates apply to BOTH Market and ResultMarket (kept identical).
   * Changes are warn-logged (auditable). Never throws — a dead parse must
   * not disturb the result pipeline.
   */
  async syncMarketSchedules(): Promise<string[]> {
    const updated: string[] = [];
    // try assigns, catch returns early — no initializer needed.
    let rows: { marketId: string; openTime: string; closeTime: string }[];
    try {
      rows = await this.adapter.fetchMarketSchedule();
    } catch (err) {
      this.logger.warn(`[schedule] fetch skipped: ${(err as Error).message}`);
      return updated;
    }
    for (const row of rows) {
      const openMin = parseTimeToMinutes(row.openTime);
      const closeMin = parseTimeToMinutes(row.closeTime);
      if (openMin === null || closeMin === null || openMin === closeMin) continue;
      const openTime = formatTimeMinutes(openMin);
      const closeTime = formatTimeMinutes(closeMin);
      try {
        const market = await this.prisma.market.findUnique({ where: { id: row.marketId } });
        if (market && (market.openTime !== openTime || market.closeTime !== closeTime)) {
          await this.prisma.market.update({ where: { id: row.marketId }, data: { openTime, closeTime } });
          this.logger.warn(
            `[schedule] ${row.marketId}: ${market.openTime}-${market.closeTime} -> ${openTime}-${closeTime} (site table)`,
          );
          updated.push(`${row.marketId}(market)`);
        }
        const rm = await this.prisma.resultMarket.findUnique({ where: { id: row.marketId } });
        if (rm && (rm.openTime !== openTime || rm.closeTime !== closeTime)) {
          await this.prisma.resultMarket.update({ where: { id: row.marketId }, data: { openTime, closeTime } });
          updated.push(`${row.marketId}(results)`);
        }
      } catch (err) {
        this.logger.warn(`[schedule] ${row.marketId} sync skipped: ${(err as Error).message}`);
      }
    }
    if (updated.length > 0) {
      this.status.lastScheduleSync = { at: new Date().toISOString(), updated };
    }
    return updated;
  }

  private async persist(
    marketId: string,
    records: { date: string; jodi: string | null; open: string | null; close: string | null; source: string }[],
  ): Promise<ScrapeMarketResult> {
    const entry: ScrapeMarketResult = {
      marketId,
      records: records.length,
      resultRecord: 0,
      chartRecord: 0,
      latestResult: null,
    };
    if (records.length === 0) return entry;

    const [market, resultMarket] = await Promise.all([
      this.prisma.market.findUnique({ where: { id: marketId } }),
      this.prisma.resultMarket.findUnique({ where: { id: marketId } }),
    ]);

    const rows = records.map((r) => ({
      marketId,
      date: r.date,
      jodi: r.jodi,
      panel: r.open,
      open: r.open,
      close: r.close,
      source: r.source,
    }));
    // Latest = max date (records may arrive week-ordered, not strictly sorted).
    const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    if (resultMarket) {
      await this.upsertResultRecords(rows);
      entry.resultRecord = records.length;
    } else if (this.autoCreateResultMarkets) {
      await this.prisma.resultMarket.upsert({
        where: { id: marketId },
        update: {},
        create: {
          id: marketId,
          name: marketId.toUpperCase(),
          openTime: '10:00 AM',
          closeTime: '11:00 PM',
          order: 999,
        },
      });
      await this.upsertResultRecords(rows);
      entry.resultRecord = records.length;
    }

    if (market) {
      // ChartRecord requires full row (non-null columns) — write only complete days.
      // Partial days still land in ResultRecord above so OPEN shows lively.
      let chartWrites = 0;
      for (const r of records) {
        if (!r.open || !r.jodi || !r.close) continue;
        const ank = r.open[r.open.length - 1];
        await this.prisma.chartRecord.upsert({
          where: { marketId_date: { marketId, date: r.date } },
          update: {
            open: r.open,
            openAnk: ank,
            jodi: r.jodi,
            close: r.close,
            closeAnk: r.close[r.close.length - 1],
          },
          create: {
            marketId,
            date: r.date,
            open: r.open,
            openAnk: ank,
            jodi: r.jodi,
            close: r.close,
            closeAnk: r.close[r.close.length - 1],
          },
        });
        chartWrites++;
      }
      entry.chartRecord = chartWrites;

      // Partial-aware latest: open-only day => "116-**-***" so Home shows OPEN live.
      const latest = sorted[sorted.length - 1];
      const result = `${latest.open ?? '***'}-${latest.jodi ?? '**'}-${latest.close ?? '***'}`;
      await this.prisma.market.update({
        where: { id: marketId },
        data: { result },
      });
      entry.latestResult = result;
    }

    return entry;
  }

  /**
   * Duplicate healer — removes exact-duplicate FULL rows (same open/jodi/close)
   * that sit within 3 days of an earlier identical row. Sources of such rows:
   * legacy carry-forwards (last declare repeated under "today"), yesterday's
   * night leftover stamped today, weekend leftovers. Genuine back-to-back
   * repeats are astronomically rare for full combos; partial (open-only) rows
   * are never touched. Returns the number of deleted rows.
   */
  private async healResultDates(marketIds: string[]): Promise<number> {
    const cutoff = addDays(isoToday(), -10);
    const rows = await this.prisma.resultRecord.findMany({
      where: { marketId: { in: marketIds }, date: { gte: cutoff } },
      orderBy: [{ marketId: 'asc' }, { date: 'asc' }],
    });
    const seen = new Map<string, { date: string; id: string }[]>();
    const toDelete: string[] = [];
    for (const r of rows) {
      if (!r.open || !r.jodi || !r.close) continue; // full rows only
      const key = `${r.marketId}|${r.open}|${r.jodi}|${r.close}`;
      const prev = seen.get(key) ?? [];
      const dup = prev.find(
        (p) => Math.round((Date.parse(r.date) - Date.parse(p.date)) / 86400000) <= 3,
      );
      if (dup) {
        toDelete.push(r.id); // keep the earliest date, drop the repeat
      } else {
        prev.push({ date: r.date, id: r.id });
        seen.set(key, prev);
      }
    }
    if (toDelete.length > 0) {
      // Small batches to stay friendly to the pooler.
      for (let i = 0; i < toDelete.length; i += 50) {
        await this.prisma.resultRecord.deleteMany({
          where: { id: { in: toDelete.slice(i, i + 50) } },
        });
      }
    }
    return toDelete.length;
  }

  /**
   * Recomputes every market's display string from its latest ResultRecord so
   * `Market.result` can never point at a healed-away row. Partial-aware:
   * open-only days become `open-**-***`; no rows at all becomes null
   * (UI renders an honest "awaiting" state).
   */
  /**
   * Recomputes every market's display string from its latest ResultRecord so
   * `Market.result` can never point at a healed-away row. Partial-aware:
   * open-only days become `open-**-***`; no rows at all becomes null
   * (UI renders an honest "awaiting" state).
   *
   * Bounded by design: the display string only needs each market's LATEST
   * row, which on a live system is always inside the recent window. Markets
   * still missing get one indexed latest-row lookup each. Every cycle stays
   * O(days), never O(full table history) — otherwise each cycle would slow
   * down forever as years of chart data accumulate, delaying fresh declares.
   */
  private async refreshMarketResults(marketIds: string[]): Promise<void> {
    const cutoff = addDays(isoToday(), -4);
    const recent = await this.prisma.resultRecord.findMany({
      where: { marketId: { in: marketIds }, date: { gte: cutoff } },
      orderBy: { date: 'desc' },
    });
    const byMarket = new Map<string, (typeof recent)[number]>();
    for (const r of recent) {
      if (!byMarket.has(r.marketId)) byMarket.set(r.marketId, r);
    }
    for (const marketId of marketIds) {
      if (!byMarket.has(marketId)) {
        const one = await this.prisma.resultRecord
          .findFirst({ where: { marketId }, orderBy: { date: 'desc' } })
          .catch(() => null);
        if (one) byMarket.set(marketId, one);
      }
    }
    for (const marketId of marketIds) {
      const r = byMarket.get(marketId);
      const result = r ? `${r.open ?? '***'}-${r.jodi ?? '**'}-${r.close ?? '***'}` : null;
      await this.prisma.market
        .update({ where: { id: marketId }, data: { result } })
        .catch((err) => {
          this.logger.warn(`[refresh] ${marketId} result update skipped: ${(err as Error).message}`);
        });
    }
  }

  /**
   * Upserts scraped rows into `ResultRecord`, overwriting any existing row for
   * the same (marketId, date) so realtime results always reflect the latest
   * provider data.
   */
  private async upsertResultRecords(
    rows: { marketId: string; date: string; jodi: string | null; panel: string | null; open: string | null; close: string | null; source: string }[],
  ): Promise<void> {
    for (const r of rows) {
      await this.prisma.resultRecord.upsert({
        where: { marketId_date: { marketId: r.marketId, date: r.date } },
        // Null-safe: a thinner partial (e.g. open-only homepage row) must
        // never wipe a fuller row already stored (e.g. full panel row).
        // Data only moves forward: nulls fill in, values overwrite.
        update: {
          ...(r.jodi != null ? { jodi: r.jodi } : {}),
          ...(r.panel != null ? { panel: r.panel } : {}),
          ...(r.open != null ? { open: r.open } : {}),
          ...(r.close != null ? { close: r.close } : {}),
          source: r.source,
        },
        create: {
          marketId: r.marketId,
          date: r.date,
          jodi: r.jodi,
          panel: r.panel,
          open: r.open,
          close: r.close,
          source: r.source,
        },
      });
    }
  }
}
