import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FetchRecordsOptions, SampleRecord, SourceAdapter } from './source-adapter';
import { fetchHtml } from './scraper-http';
import { parsePanelChart } from './satmat-web.parser';
import { parseVipHomepage, parseVipLucky, parseMarketSchedule, VipLiveResult, VipLucky, VipMarketSchedule } from './vip-live.parser';

export const SATMAT_WEB_SOURCE = 'satmat-web';

/** Homepage carrying the live-result block for all markets (one fetch). */
export const VIP_HOMEPAGE_URL = 'https://sattamatkavip.in/';

/**
 * Primary market -> provider URL mapping. The ids are the backend market ids
 * consumed by the API/UI. Override any of these via `SCRAPE_MARKET_URLS`
 * (a JSON object) in the environment.
 */
export const DEFAULT_SATMAT_MARKET_URLS: Record<string, string> = {
  // Live markets from sattamatkavip.in (verified: direct 200, ~120-450ms,
  // recent data incl. partial open-only days). Same 3-cell panel format
  // (mixed th/td cells). NOTE: this provider spells it "penal-chart" on
  // most /record/ pages.
  // KALYAN exception: the VIP kalyan page is stale (stuck at Aug 2026) while
  // sattaindianmatka.com/kalyan-panel_chart.php is fresh through the latest
  // session — so kalyan primary stays on the legacy URL (VIP as fallback).
  kalyan: 'https://sattaindianmatka.com/kalyan-panel_chart.php',
  'main-bazar': 'https://sattamatkavip.in/main-bazar-panel-chart.php',
  sridevi: 'https://sattamatkavip.in/record/sridevi-satta-penal-chart.php', // SRIDEVI DAY
  'time-bazar-day': 'https://sattamatkavip.in/time-bazar-panel-chart.php', // TIME BAZAR
  'madhur-day': 'https://sattamatkavip.in/madhur-day-panel-chart.php',
  'milan-day': 'https://sattamatkavip.in/record/milan-day-penal-chart.php',
  'rajdhani-day': 'https://sattamatkavip.in/record/rajdhani-day-penal-chart.php',
  'sridevi-night': 'https://sattamatkavip.in/record/sridevi-night-satta-penal-chart.php',
  'madhur-night': 'https://sattamatkavip.in/madhur-night-panel-chart.php',
  'milan-night': 'https://sattamatkavip.in/record/milan-night-penal-chart.php',
  'rajdhani-night': 'https://sattamatkavip.in/record/rajdhani-night-penal-chart.php',
  'kalyan-night': 'https://sattamatkavip.in/record/kalyan-night-penal-chart.php',
  'supreme-day': 'https://sattamatkavip.in/supreme-day-panel-chart.php',
  'supreme-night': 'https://sattamatkavip.in/supreme-night-panel-chart.php',
};

/** Previous primaries, kept as fallbacks if the VIP mirror ever fails. */
export const LEGACY_SATMAT_MARKET_URLS: Record<string, string> = {
  kalyan: 'https://sattamatkavip.in/record/kalyan-penal-chart.php',
  'main-bazar': 'https://sattaindianmatka.com/main-bazar-panel_chart.php',
  sridevi: 'https://sattaindianmatka.com/sridevi-panel_chart.php',
  'time-bazar-day': 'https://sattaindianmatka.com/time-bazar-panel_chart.php',
  'madhur-day': 'https://sattaindianmatka.com/madhur-day-panel_chart.php',
  'milan-day': 'https://sattaindianmatka.com/milan-day-panel_chart.php',
  'rajdhani-day': 'https://sattaindianmatka.com/rajdhani-day-panel_chart.php',
  'sridevi-night': 'https://sattaindianmatka.com/sridevi-night-panel_chart.php',
  'madhur-night': 'https://sattaindianmatka.com/madhur-night-panel_chart.php',
  'milan-night': 'https://sattaindianmatka.com/milan-night-panel_chart.php',
  'rajdhani-night': 'https://sattaindianmatka.com/rajdhani-night-panel_chart.php',
  'kalyan-night': 'https://sattaindianmatka.com/kalyan-night-panel_chart.php',
  'supreme-day': 'https://dpbossss.com/panel-chart-record/supreme-day.php',
  'supreme-night': 'https://dpbossss.com/panel-chart-record/supreme-night.php',
};

/**
 * Fallback URLs tried when the primary source fails (Cloudflare block, timeout,
 * etc.). Only for markets whose primary is on a protected domain or dpbossss.
 */
export const FALLBACK_SATMAT_MARKET_URLS: Record<string, string> = {
  // Fallback: previous primaries (verified working before the VIP switch)
  ...LEGACY_SATMAT_MARKET_URLS,
};

/**
 * Real scraper adapter for panel charts (primary: sattamatkavip.in).
 *
 * Registered under the name `satmat-web` so it can be selected with
 * `SOURCE_ADAPTER=satmat-web`. Records it produces are tagged
 * `source: "satmat-web"` and are never fabricated: fully-undeclared
 * (`***`) or empty days are skipped, while partial days (OPEN declared,
 * CLOSE pending) are stored with nulls so today's OPEN shows lively.
 */
@Injectable()
export class SatmatWebAdapter implements SourceAdapter {
  readonly name = SATMAT_WEB_SOURCE;
  private readonly logger = new Logger(SatmatWebAdapter.name);
  private readonly urls: Record<string, string>;
  private readonly fallbackUrls: Record<string, string>;
  private readonly delayMs: number;
  private readonly timeoutMs: number;
  private readonly proxyUrl?: string;

  constructor(config: ConfigService) {
    let override: Record<string, string> = {};
    const raw = config.get<string>('SCRAPE_MARKET_URLS');
    if (raw && raw.trim()) {
      try {
        override = JSON.parse(raw);
      } catch {
        this.logger.warn(
          'SCRAPE_MARKET_URLS is not valid JSON; ignoring it and using defaults.',
        );
      }
    }
    this.urls = { ...DEFAULT_SATMAT_MARKET_URLS, ...override };
    this.fallbackUrls = { ...FALLBACK_SATMAT_MARKET_URLS };
    this.delayMs = Number(config.get('SCRAPE_DELAY_MS') || 0);
    this.timeoutMs = Number(config.get('SCRAPE_TIMEOUT_MS') || 15000);
    this.proxyUrl = config.get<string>('SCRAPE_PROXY_URL') || undefined;

    // Log proxy routing summary for visibility
    const proxyMarkets: string[] = [];
    const directMarkets: string[] = [];
    for (const [id, url] of Object.entries(this.urls)) {
      if (this.needsProxy(url)) {
        proxyMarkets.push(id);
      } else {
        directMarkets.push(id);
      }
    }
    if (this.proxyUrl) {
      this.logger.log(
        `Proxy configured: ${proxyMarkets.length} markets via proxy, ` +
          `${directMarkets.length} markets direct`,
      );
    } else if (proxyMarkets.length > 0) {
      this.logger.warn(
        `NO proxy set but ${proxyMarkets.length} markets require it: ${proxyMarkets.join(', ')}. ` +
          `Set SCRAPE_PROXY_URL to fix.`,
      );
    }

    const fallbackCount = Object.keys(this.fallbackUrls).length;
    if (fallbackCount > 0) {
      this.logger.log(
        `Fallback source (diamondsattamatka.co) configured for ${fallbackCount} markets.`,
      );
    }
  }

  /** All configured market ids (used by the scheduler to iterate). */
  marketIds(): string[] {
    return Object.keys(this.urls);
  }

  /** Resolves the provider URL for a market id, or null when unconfigured. */
  marketUrl(marketId: string): string | null {
    return this.urls[marketId] ?? null;
  }

  /**
   * One-fetch live snapshot: today's declares for all markets from the
   * provider homepage. Partial-aware (open-only rows included) — the
   * scheduler upserts these before the panel cycle runs.
   */
  async fetchLiveSnapshot(): Promise<VipLiveResult[]> {
    const html = await fetchHtml(VIP_HOMEPAGE_URL, {
      delayMs: 0,
      timeoutMs: this.timeoutMs,
      retries: 1,
    });
    return parseVipHomepage(html);
  }

  /** Today's lucky numbers from the provider homepage (null when unpublished). */
  async fetchLuckyNumber(): Promise<VipLucky | null> {
    const html = await fetchHtml(VIP_HOMEPAGE_URL, {
      delayMs: 0,
      timeoutMs: this.timeoutMs,
      retries: 1,
    });
    return parseVipLucky(html);
  }

  /**
   * The provider's official schedule table (Market | Open | Close). The app
   * runs exactly these windows — see ScrapeScheduler.syncMarketSchedules.
   */
  async fetchMarketSchedule(): Promise<VipMarketSchedule[]> {
    const html = await fetchHtml(VIP_HOMEPAGE_URL, {
      delayMs: 0,
      timeoutMs: this.timeoutMs,
      retries: 1,
    });
    return parseMarketSchedule(html);
  }

  async fetchRecords(
    marketId: string,
    startDate: string,
    endDate: string,
    opts: FetchRecordsOptions = {},
  ): Promise<SampleRecord[]> {
    const url = this.marketUrl(marketId);
    if (!url) return [];

    try {
      const primary = await this.fetchFromSource(marketId, url, startDate, endDate);
      if (!opts.mergeFallback) return primary;
      // Backfill enrichment: fold in fallback-mirror dates the primary lacks
      // (primary always wins overlaps). Best-effort — a dead mirror must
      // never fail the backfill.
      const fallbackUrl = this.fallbackUrls[marketId];
      if (!fallbackUrl) return primary;
      try {
        const extra = await this.fetchFromSource(marketId, fallbackUrl, startDate, endDate);
        if (extra.length === 0) return primary;
        const seen = new Set(primary.map((r) => r.date));
        const merged = [...primary];
        for (const r of extra) {
          if (!seen.has(r.date)) {
            seen.add(r.date);
            merged.push(r);
          }
        }
        merged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        if (merged.length > primary.length) {
          this.logger.log(
            `[${marketId}] backfill merge: primary=${primary.length} +fallback=${merged.length - primary.length}`,
          );
        }
        return merged;
      } catch (err) {
        this.logger.warn(`[${marketId}] backfill fallback merge skipped: ${(err as Error).message}`);
        return primary;
      }
    } catch (primaryErr) {
      const fallbackUrl = this.fallbackUrls[marketId];
      if (!fallbackUrl) throw primaryErr;

      this.logger.warn(
        `[${marketId}] primary source failed (${(primaryErr as Error).message}); ` +
          `trying fallback: ${fallbackUrl}`,
      );
      return this.fetchFromSource(
        marketId,
        fallbackUrl,
        startDate,
        endDate,
      );
    }
  }

  private async fetchFromSource(
    marketId: string,
    url: string,
    startDate: string,
    endDate: string,
  ): Promise<SampleRecord[]> {
    const proxyUrl = this.needsProxy(url) ? this.proxyUrl : undefined;

    if (this.needsProxy(url) && !proxyUrl) {
      this.logger.warn(
        `[${marketId}] needs proxy but SCRAPE_PROXY_URL is empty — will likely fail`,
      );
    }

    const html = await fetchHtml(url, {
      delayMs: this.delayMs,
      timeoutMs: this.timeoutMs,
      proxyUrl,
      retries: 2,
    });
    const parsed = parsePanelChart(html);

    const records: SampleRecord[] = [];
    for (const day of parsed) {
      if (day.date < startDate || day.date > endDate) continue;
      records.push({
        marketId,
        date: day.date,
        jodi: day.jodi,
        panel: day.open,
        open: day.open,
        close: day.close,
        source: SATMAT_WEB_SOURCE,
      });
    }
    return records;
  }

  /** Returns true if the URL is on a Cloudflare-protected domain that needs proxy. */
  private needsProxy(url: string): boolean {
    return (
      url.includes('sattamatkakgf.com') ||
      url.includes('diamondsattamatka.co')
    );
  }
}
