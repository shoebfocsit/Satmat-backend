import { Controller, Get, Post, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Roles } from '../../common/decorators/roles.decorator';
import { ScrapeScheduler } from './scrape.scheduler';
import { checkProxyIp } from '../charts/source/scraper-http';

@Controller('admin/scrape')
@Roles('ADMIN')
export class ScrapeController {
  private readonly logger = new Logger(ScrapeController.name);

  constructor(
    private readonly scheduler: ScrapeScheduler,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  status() {
    return this.scheduler.status;
  }

  @Post('run')
  async run() {
    return this.scheduler.runCycle();
  }

  /**
   * Deep-history backfill (full provider history per market, ~2019→today).
   * Runs automatically on boot for shallow markets; this endpoint forces a
   * refill of every market. Takes a minute or two — poll GET status for
   * `lastBackfill` to watch progress.
   */
  @Post('backfill')
  async backfill() {
    return this.scheduler.backfillHistory(true);
  }

  /**
   * Test proxy connectivity. Verifies SCRAPE_PROXY_URL is working and
   * shows the exit IP the scraper will use for Cloudflare-protected markets.
   */
  @Get('proxy-check')
  async proxyCheck() {
    const proxyUrl = this.config.get<string>('SCRAPE_PROXY_URL');
    if (!proxyUrl?.trim()) {
      return {
        ok: false,
        configured: false,
        message:
          'SCRAPE_PROXY_URL is not set. Primary source (sattamatkavip.in) is direct and needs no proxy; the proxy is only used if a fallback domain gets Cloudflare-challenged.',
      };
    }
    try {
      const exitIp = await checkProxyIp(proxyUrl.trim());
      this.logger.log(`Proxy check passed — exit IP: ${exitIp}`);
      return {
        ok: true,
        configured: true,
        exitIp,
        message: `Proxy is working. Scraper requests will exit from IP ${exitIp}.`,
      };
    } catch (err) {
      this.logger.error(`Proxy check failed: ${(err as Error).message}`);
      return {
        ok: false,
        configured: true,
        error: (err as Error).message,
        message:
          'Proxy is configured but unreachable. Verify the URL and credentials in SCRAPE_PROXY_URL.',
      };
    }
  }
}
