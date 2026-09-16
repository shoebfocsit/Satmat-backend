import { Injectable } from '@nestjs/common';

/**
 * A single result record for a market on a given date.
 * Fields are nullable to support lively partial declares: provider often
 * publishes OPEN first (open panna) and CLOSE hours later. Storing the
 * partial immediately lets Home/Results show today's OPEN live instead of
 * waiting for the full row and showing yesterday.
 */
export interface SampleRecord {
  marketId: string;
  /** YYYY-MM-DD */
  date: string;
  jodi: string | null;
  panel: string | null;
  open: string | null;
  close: string | null;
  source: string;
}

/**
 * Normalizes a YYYY-MM-DD string, returning null when it is not a real
 * calendar date (e.g. "2026-02-30", "2026/01/01", "not-a-date").
 */
export function normalizeDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/**
 * A source adapter supplies normalized result records for a market over an
 * inclusive date range. All scraping / third-party access happens exclusively
 * server-side, behind this interface; frontends only ever talk to the API.
 */
export interface SourceAdapter {
  readonly name: string;
  fetchRecords(
    marketId: string,
    startDate: string,
    endDate: string,
    opts?: FetchRecordsOptions,
  ): Promise<SampleRecord[]>;
}

/** Options for range fetches. */
export interface FetchRecordsOptions {
  /**
   * Also fetch the fallback mirror and merge dates the primary lacks
   * (primary wins overlaps). Backfill-only: costs one extra page fetch,
   * so the rolling cycle leaves it off.
   */
  mergeFallback?: boolean;
}

/** Thrown when the configured source cannot serve the requested data. */
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

@Injectable()
export class SourceAdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): SourceAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new SourceUnavailableError(`Unknown source adapter: ${name}`);
    }
    return adapter;
  }
}
