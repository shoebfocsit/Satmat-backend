import { Controller, Get, Header, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { ChartsService } from './charts.service';

@Controller()
export class ChartsController {
  constructor(private readonly charts: ChartsService) {}

  @Public()
  @Get('charts')
  @Header('Cache-Control', 'no-store')
  async chart(
    @Query('market') market?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.charts.getChart(market, startDate, endDate);
  }
}
