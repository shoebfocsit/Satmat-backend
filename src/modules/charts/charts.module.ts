import { Module } from '@nestjs/common';
import { ChartsService } from './charts.service';
import { ChartsController } from './charts.controller';
import { SourceAdapterRegistry } from './source/source-adapter';
import { ScraperSourceAdapter } from './source/scraper';
import { SatmatWebAdapter } from './source/satmat-web.adapter';

@Module({
  controllers: [ChartsController],
  providers: [
    ChartsService,
    SourceAdapterRegistry,
    ScraperSourceAdapter,
    SatmatWebAdapter,
  ],
  exports: [ChartsService, SourceAdapterRegistry, SatmatWebAdapter],
})
export class ChartsModule {}
