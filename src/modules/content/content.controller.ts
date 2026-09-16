import { Controller, Get, Header } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller()
export class ContentController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('how-to-play')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=600')
  async howToPlay() {
    const doc = await this.prisma.howToPlay.findUnique({ where: { id: 'how-to-play' } });
    if (!doc) return { sections: [] };
    try {
      return { sections: JSON.parse(doc.sections) };
    } catch {
      return { sections: [] };
    }
  }

  @Public()
  @Get('stats')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=120, stale-while-revalidate=120')
  async stats() {
    const [players, markets] = await Promise.all([
      this.prisma.user.count({ where: { roles: { contains: 'USER' } } }),
      this.prisma.market.count(),
    ]);
    return {
      activePlayers: players,
      liveMarkets: markets,
      withdrawalTime: '2-4 hours',
      supportHours: '24x7',
    };
  }
}