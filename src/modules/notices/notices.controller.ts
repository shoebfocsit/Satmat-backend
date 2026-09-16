import { Controller, Get, Header } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../../common/decorators/public.decorator';
import { CacheService } from '../../common/cache/cache.service';

@Controller('notices')
export class NoticesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=120')
  async list() {
    const cached = await this.cache.get<any[]>('notices:list');
    if (cached) return cached;
    const notices = await this.prisma.notice.findMany({ orderBy: { date: 'desc' } });
    const data = notices.map((n) => ({
      id: n.id,
      title: n.title,
      content: n.content,
      date: n.date.toISOString().slice(0, 10),
      isImportant: n.isImportant,
    }));
    await this.cache.set('notices:list', data, 30_000);
    return data;
  }
}