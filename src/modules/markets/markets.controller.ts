import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { MarketsService } from './markets.service';

@Controller()
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  @Public()
  @Get('markets')
  @Header('Cache-Control', 'no-store')
  async list() {
    return this.markets.listMarkets();
  }

  @Public()
  @Get('markets/:id/chart')
  async chart(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.markets.getChart(id, from, to);
  }

  @Public()
  @Get('markets/:id/results/latest')
  async latest(@Param('id') id: string) {
    return this.markets.getLatestResult(id);
  }

  @Public()
  @Get('markets/:id')
  async detail(@Param('id') id: string) {
    return this.markets.getMarket(id);
  }

  @Public()
  @Get('markets/:id/status')
  @Header('Cache-Control', 'no-store')
  async status(@Param('id') id: string) {
    // Server-authoritative bidding status for countdown sync. UI-only:
    // POST /bids always re-validates the window at commit time.
    return this.markets.getStatus(id);
  }

  @Public()
  @Get('game-types')
  @Header('Cache-Control', 'no-store')
  async gameTypes(@Query('market') market?: string) {
    return this.markets.listGameTypes(market ?? undefined);
  }

  @Public()
  @Get('game-rates')
  @Header('Cache-Control', 'no-store')
  async gameRates() {
    return this.markets.listGameRates();
  }
}