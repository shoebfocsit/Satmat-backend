import * as cheerio from 'cheerio';

/**
 * Parser for provider `*-panel-chart` pages, tied to a single shared table
 * format. It backs both sattaindianmatka.com (week label
 * `DD/MM/YYYY`) and sattamatkakgf.com (week label `DD/MM/YY`, 2-digit year).
 *
 * The page contains one HTML table. Each row is one week:
 *   - cell 0: week label like "10/08/2026 to 14/08/2026" (DD/MM/YYYY)
 *     or "31/07/17 to 05/08/17" (DD/MM/YY)
 *   - cells 1..21: 7 days x 3 cells, in the order
 *       [Open Panna (3 digits) | Jodi (2 digits) | Close Panna (3 digits)]
 *   Cells may be `td` or `th`: sattaindianmatka.com uses `td` throughout,
 *   while sattamatkavip.in renders open/close pannas (and the week label) as
 *   `th` with jodi in `td` — so both are selected.
 *
 * Open/close panna digits may be stacked in a single cell with `<br>`
 * (sattamatkakgf.com); they are joined before validation. Cells may contain
 * `***` / `**` (undeclared) or be empty (future days); such days are skipped
 * and never fabricated. This is the TypeScript equivalent of the
 * BeautifulSoup `row.find_all("td")` extraction.
 */

export interface ParsedDayResult {
  /** YYYY-MM-DD */
  date: string;
  /** 3-digit open panna, or null when undeclared (*** / empty = future/pending) */
  open: string | null;
  /** 2-digit jodi, or null when undeclared */
  jodi: string | null;
  /** 3-digit close panna, or null when undeclared */
  close: string | null;
}

/**
 * Matches a week label for sattaindianmatka.com (`DD/MM/YYYY`), sattamatkakgf.com
 * and other providers (`DD/MM/YY` / `DD/MM/YYYY`). The separator word is
 * case-insensitive (`to` / `To` / `TO`), since providers differ in casing.
 * Group order: D1 M1 Y1 to D2 M2 Y2.
 */
const WEEK_LABEL_RE =
  /(\d{2})\/(\d{2})\/(\d{2}|\d{4})\s*to\s*(\d{2})\/(\d{2})\/(\d{2}|\d{4})/i;
const CELLS_PER_DAY = 3;
const DAYS_PER_WEEK = 7;

function digitsOnly(text: string): string {
  return text.replace(/[^\d]/g, '');
}

/**
 * Expands a 2-digit year to 4 digits: `YY <= 69` maps to `20YY`, `YY >= 70`
 * maps to `19YY` (only relevant for sattamatkakgf.com, whose data spans
 * 2017-2026). 4-digit years pass through unchanged.
 */
function fullYear(year: number): number {
  if (year < 100) return year <= 69 ? 2000 + year : 1900 + year;
  return year;
}

function parseDdmmyyyy(day: number, month: number, year: number): string {
  const full = fullYear(year);
  const dt = new Date(Date.UTC(full, month - 1, day));
  if (
    dt.getUTCFullYear() !== full ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return '';
  }
  return dt.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const dt = new Date(isoDate + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function parsePanelChart(html: string): ParsedDayResult[] {
  const $ = cheerio.load(html);
  const results: ParsedDayResult[] = [];

  $('table')
    .first()
    .find('tr')
    .each((_, tr) => {
      const cells = $(tr).find('td, th').toArray();
      if (cells.length < CELLS_PER_DAY + 1) return;

      const label = $(cells[0]).text().replace(/\s+/g, ' ').trim();
      const match = WEEK_LABEL_RE.exec(label);
      if (!match) return; // header / footer rows

      const weekStart = parseDdmmyyyy(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
      );
      if (!weekStart) return;

      const dayCells = cells.slice(1);
      for (let day = 0; day < DAYS_PER_WEEK; day++) {
        const base = day * CELLS_PER_DAY;
        const group = dayCells.slice(base, base + CELLS_PER_DAY);
        if (group.length < CELLS_PER_DAY) break;

        const [openRaw, jodiRaw, closeRaw] = group.map((cell) =>
          digitsOnly($(cell).text()),
        );
        // Lively partial support: OPEN is often declared hours before CLOSE.
        // Emit the day when ANY cell is valid so today's OPEN shows immediately;
        // skip only fully-empty / fully-undeclared days (future days).
        const open = openRaw.length === 3 ? openRaw : null;
        const jodi = jodiRaw.length === 2 ? jodiRaw : null;
        const close = closeRaw.length === 3 ? closeRaw : null;
        if (!open && !jodi && !close) {
          continue; // undeclared (***) or empty day
        }

        const date = addDays(weekStart, day);
        results.push({ date, open, jodi, close });
      }
    });

  return results;
}
