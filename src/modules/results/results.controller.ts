import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { ResultsService } from './results.service';

@Controller()
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Public()
  @Get('results')
  @Header('Cache-Control', 'no-store')
  async list() {
    return this.results.getResults();
  }

  @Public()
  @Get('lucky-number')
  @Header('Cache-Control', 'no-store')
  async luckyNumber() {
    return this.results.getLuckyNumber();
  }
}
