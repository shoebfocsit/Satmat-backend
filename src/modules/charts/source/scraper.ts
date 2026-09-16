import { SampleRecord, SourceAdapter, SourceUnavailableError } from './source-adapter';

/**
 * Placeholder scraper source adapter.
 *
 * This adapter is intentionally not wired to any network. Real result data is
 * served by the `satmat-web` adapter (see satmat-web.adapter.ts), which runs
 * server-side, respects rate limits and tags every record with
 * `source: "satmat-web"`.
 */
export class ScraperSourceAdapter implements SourceAdapter {
  readonly name = 'scraper';

  async fetchRecords(
    _marketId: string,
    _startDate: string,
    _endDate: string,
  ): Promise<SampleRecord[]> {
    throw new SourceUnavailableError(
      'No source is configured for this adapter. Use SOURCE_ADAPTER=satmat-web.',
    );
  }
}
