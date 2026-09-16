import { Module } from '@nestjs/common';
import { ChartsModule } from '../charts/charts.module';
import { ScrapeController } from './scrape.controller';
import { ScrapeScheduler } from './scrape.scheduler';

/**
 * Continuous realtime scraper. `ScrapeScheduler` runs on a configurable
 * interval while `SCRAPE_ENABLED=true` and writes provider records into the
 * DB cache; `SatmatWebAdapter` (exported by ChartsModule) is also usable
 * on-demand by `GET /charts` via `SOURCE_ADAPTER=satmat-web`.
 */
@Module({
  imports: [ChartsModule],
  controllers: [ScrapeController],
  providers: [ScrapeScheduler],
  exports: [ScrapeScheduler],
})
export class ScraperModule {}
