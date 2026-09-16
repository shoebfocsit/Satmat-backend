import { Controller, Get, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketStatusService } from '../markets/market-status.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { computeLiveStatus } from '../../common/utils/market-time';

@Controller()
export class SyncController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketStatus: MarketStatusService,
  ) {}

  @Public()
  @Get('server-time')
  async serverTime() {
    return { iso: new Date().toISOString() };
  }

  @Public()
  @Get('app-config')
  async appConfig() {
    const config = await this.prisma.appConfig.findUnique({ where: { id: 'app' } });
    if (!config) return { minAppVersion: '1.0.0', forceUpdate: false, banners: [], supportContacts: {} };
    return {
      minAppVersion: config.minAppVersion,
      forceUpdate: config.forceUpdate,
      banners: (() => { try { return JSON.parse(config.banners); } catch { return []; } })(),
      supportContacts: (() => { try { return JSON.parse(config.supportContacts); } catch { return {}; } })(),
    };
  }

  @Get('sync')
  // `since` is accepted for forward-compat but currently unused (full sync).
  async sync(@CurrentUser('id') userId: string, @Query('since') _since?: string) {
    const [user, markets, notices, bids, transactions] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      // Safe reader: survives a DB that predates the timezone/isActive migration.
      this.marketStatus.listMarketRows(),
      this.prisma.notice.findMany({ orderBy: { date: 'desc' } }),
      this.prisma.bid.findMany({ where: { userId }, orderBy: { date: 'desc' }, take: 100 }),
      this.prisma.walletTransaction.findMany({
        where: { userId },
        orderBy: { date: 'desc' },
        take: 200,
      }),
    ]);

    return {
      user: user
        ? {
            id: `#${user.referralCode}`,
            name: user.name,
            phone: user.phone,
            balance: user.balance / 100,
            isGoldMember: user.isGoldMember,
            referralCode: user.referralCode,
          }
        : null,
      balance: user ? user.balance / 100 : 0,
      markets: markets.map((m) => {
        // Live-computed so every surface agrees (DB flags can go stale).
        const live = computeLiveStatus(m.openTime, m.closeTime);
        return {
          id: m.id,
          name: m.name,
          result: m.result,
          openTime: m.openTime,
          closeTime: m.closeTime,
          isLive: live.isLive,
          isClosed: live.isClosed,
        };
      }),
      notices: notices.map((n) => ({
        id: n.id,
        title: n.title,
        content: n.content,
        date: n.date.toISOString().slice(0, 10),
        isImportant: n.isImportant,
      })),
      bids: bids.map((b) => ({
        id: `BID-${b.id.slice(0, 6).toUpperCase()}`,
        marketId: b.marketId,
        gameType: b.gameType,
        number: b.number,
        amount: b.amount / 100,
        rate: b.rate,
        status: b.status.toLowerCase(),
        round: b.round,
        date: b.date.toISOString(),
      })),
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type.toLowerCase(),
        amount: t.amount / 100,
        title: t.title,
        date: t.date.toISOString(),
        status: t.status.toLowerCase(),
      })),
      syncedAt: new Date().toISOString(),
    };
  }
}