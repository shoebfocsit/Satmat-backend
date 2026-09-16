import * as cheerio from 'cheerio';

/**
 * Parser for the sattamatkavip.in homepage live-result block — the single
 * fastest source for TODAY's declares across all markets (one fetch instead
 * of 14 panel pages).
 *
 * The site serves two markups for the same block (observed 2026-09-08):
 *   A. `.S1` > `.yom` (market name) + `.D1` (result, e.g. `356-49-568`)
 *   B. `div.fix` > `span` (green name) + `span` (black result, e.g. `139-3`)
 * Both are parsed and merged (first hit per market wins).
 *
 * Result formats:
 *   - `open-jodi-close` (e.g. `356-49-568`) → full declare
 *   - `open-jodi` (3-digit + 2-digit)         → close pending
 *   - `open-ank` (3-digit + 1-digit, e.g. `139-3`) → open declared only
 *     (the trailing digit is the open ank = digit-sum mod 10)
 *   - `Loading...` / `HOLIDAY` / empty / stars → nothing declared, skipped
 */

export interface VipLiveResult {
  marketId: string;
  open: string | null;
  jodi: string | null;
  close: string | null;
}

/** One row of the provider's official schedule table. Raw site strings. */
export interface VipMarketSchedule {
  marketId: string;
  /** e.g. "3:00 PM" (site format, unpadded hour possible) */
  openTime: string;
  /** e.g. "5:00 PM" */
  closeTime: string;
}

/** Homepage display name (normalized) -> backend market id. Exact matches only. */
const NAME_TO_MARKET: Record<string, string> = {
  SRIDEVI: 'sridevi',
  'TIME BAZAR': 'time-bazar-day',
  'MADHUR DAY': 'madhur-day',
  'MILAN DAY': 'milan-day',
  'RAJDHANI DAY': 'rajdhani-day',
  'SUPREME DAY': 'supreme-day',
  KALYAN: 'kalyan',
  'SRIDEVI NIGHT': 'sridevi-night',
  'MADHUR NIGHT': 'madhur-night',
  'SUPREME NIGHT': 'supreme-night',
  'MILAN NIGHT': 'milan-night',
  'RAJDHANI NIGHT': 'rajdhani-night',
  'KALYAN NIGHT': 'kalyan-night',
  'MAIN BAZAR': 'main-bazar',
};

function normalizeName(raw: string): string {
  return raw
    .replace(/[{}[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function parseResult(raw: string): { open: string | null; jodi: string | null; close: string | null } | null {
  const text = raw.replace(/\s+/g, '').trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper.includes('LOADING') || upper.includes('HOLIDAY')) return null;
  if (/^[*-]+$/.test(text)) return null;

  let m = /^(\d{3})-(\d{2})-(\d{3})$/.exec(text);
  if (m) return { open: m[1], jodi: m[2], close: m[3] };
  m = /^(\d{3})-(\d{2})$/.exec(text);
  if (m) return { open: m[1], jodi: m[2], close: null };
  m = /^(\d{3})-(\d)$/.exec(text);
  if (m) return { open: m[1], jodi: null, close: null };
  return null;
}

export interface VipLucky {
  ank: string;
  finalAnk: string;
}

/**
 * Parses the "Today Satta Matka Lucky Number" block:
 *   <div class="menu3">
 *     <div class="live-result1">Today Satta Matka Lucky Number</div>
 *     <table class="table">
 *       <tr><td>Ank (शुभांक)</td><td>Final Ank</td></tr>
 *       <tr><td>2-6-5-8</td><td>K-4, M-4</td></tr>
 *     </table>
 *   </div>
 * Returns null when the block/values are absent — the caller stores nothing,
 * so the app can never show a fabricated lucky number.
 */
export function parseVipLucky(html: string): VipLucky | null {
  const $ = cheerio.load(html);
  const blocks = $('div.menu3').toArray();
  for (const block of blocks) {
    const title = $(block).find('.live-result1').first().text();
    if (!/lucky number/i.test(title)) continue;
    const rows = $(block).find('table.table tr').toArray();
    if (rows.length < 2) continue;
    const cells = $(rows[rows.length - 1])
      .find('td')
      .toArray()
      .map((c) => $(c).text().replace(/\s+/g, ' ').trim());
    if (cells.length < 2) continue;
    const [ank, finalAnk] = cells;
    if (!ank || !finalAnk) continue;
    if (/ank/i.test(ank) && /ank/i.test(finalAnk)) continue; // header row, not values
    return { ank, finalAnk };
  }
  return null;
}

export function parseVipHomepage(html: string): VipLiveResult[] {  const $ = cheerio.load(html);
  const byMarket = new Map<string, VipLiveResult>();

  const consider = (nameRaw: string, resultRaw: string) => {
    const marketId = NAME_TO_MARKET[normalizeName(nameRaw)];
    if (!marketId || byMarket.has(marketId)) return;
    const parsed = parseResult(resultRaw);
    if (!parsed) return;
    byMarket.set(marketId, { marketId, ...parsed });
  };

  // Markup A: .S1 > .yom + .D1
  $('.S1').each((_, el) => {
    consider($(el).find('.yom').first().text(), $(el).find('.D1').first().text());
  });

  // Markup B: div.fix > span (name) + span (result)
  $('div.fix').each((_, el) => {
    const spans = $(el).children('span').toArray();
    if (spans.length < 2) return;
    consider($(spans[0]).text(), $(spans[1]).text());
  });

  return [...byMarket.values()];
}

/** Strict wall-clock time as the site prints it: "3:00 PM", "03:00 PM", "12:05 AM". */
const SCHEDULE_TIME_RE = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

function cleanScheduleTime(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  const m = SCHEDULE_TIME_RE.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const mins = Number(m[2]);
  if (h < 1 || h > 12 || mins < 0 || mins > 59) return null;
  return text;
}

/**
 * Parses the provider's official schedule table
 * (Market Name | Open Time | Close Time | Status). This is the ONLY source
 * for market timings — the app must run exactly the site's windows.
 *
 * Fail-safe: rows with unknown names, malformed times (e.g. the site's own
 * "11:400 AM" typo) or missing cells are skipped, never stored. First valid
 * row per market wins.
 */
export function parseMarketSchedule(html: string): VipMarketSchedule[] {
  const $ = cheerio.load(html);
  const byMarket = new Map<string, VipMarketSchedule>();

  $('table').each((_, table) => {
    const header = $(table)
      .find('tr')
      .first()
      .find('td, th')
      .toArray()
      .map((c) => $(c).text().replace(/\s+/g, ' ').trim().toUpperCase());
    const nameIdx = header.findIndex((h) => h.includes('MARKET'));
    const openIdx = header.findIndex((h) => h.includes('OPEN'));
    const closeIdx = header.findIndex((h) => h.includes('CLOSE'));
    if (nameIdx < 0 || openIdx < 0 || closeIdx < 0) return; // not the schedule table

    $(table)
      .find('tr')
      .slice(1)
      .each((_, tr) => {
        const cells = $(tr)
          .find('td, th')
          .toArray()
          .map((c) => $(c).text().replace(/\s+/g, ' ').trim());
        const name = cells[nameIdx] ?? '';
        const marketId = NAME_TO_MARKET[normalizeName(name)];
        if (!marketId || byMarket.has(marketId)) return;
        const openTime = cleanScheduleTime(cells[openIdx] ?? '');
        const closeTime = cleanScheduleTime(cells[closeIdx] ?? '');
        if (!openTime || !closeTime) return;
        byMarket.set(marketId, { marketId, openTime, closeTime });
      });
  });

  return [...byMarket.values()];
}
