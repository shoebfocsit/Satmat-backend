import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WalletService } from '../wallet/wallet.service';
import { parseTimeToMinutes, resolveTimezone } from '../../common/utils/market-time';
import { AdminQueryDto, AdjustWalletDto, CreateNoticeDto, DeclareResultDto, OpenCloseDto, SettleWithdrawalDto, UpdateMarketScheduleDto } from './dto/admin.dto';

@Controller('admin')
@Roles('ADMIN')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  @Get('dashboard')
  async dashboard() {
    const [users, deposits, withdrawals, bids] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.walletTransaction.aggregate({ _sum: { amount: true }, where: { type: 'CREDIT', status: 'COMPLETED' } }),
      this.prisma.withdrawal.aggregate({ _sum: { amount: true }, where: { status: 'COMPLETED' } }),
      this.prisma.bid.aggregate({ _sum: { amount: true }, where: { status: 'PENDING' } }),
    ]);
    const depositSum = (deposits._sum.amount || 0) / 100;
    const withdrawalSum = (withdrawals._sum.amount || 0) / 100;
    return {
      totalUsers: users,
      totalDeposits: depositSum,
      totalWithdrawals: withdrawalSum,
      margin: depositSum - withdrawalSum,
      pendingBidVolume: (bids._sum.amount || 0) / 100,
    };
  }

  @Post('markets/:id/result')
  async declareResult(@Param('id') id: string, @Body() dto: DeclareResultDto) {
    const market = await this.prisma.market.findUnique({ where: { id } });
    if (!market) throw new NotFoundException({ code: 'MARKET_NOT_FOUND', message: 'Market not found' });
    const date = dto.date || new Date().toISOString().slice(0, 10);

    const chart = await this.prisma.chartRecord.upsert({
      where: { marketId_date: { marketId: id, date } },
      update: { open: dto.open, openAnk: dto.open[dto.open.length - 1], jodi: dto.jodi, close: dto.close, closeAnk: dto.close[dto.close.length - 1] },
      create: {
        marketId: id,
        date,
        open: dto.open,
        openAnk: dto.open[dto.open.length - 1],
        jodi: dto.jodi,
        close: dto.close,
        closeAnk: dto.close[dto.close.length - 1],
      },
    });

    await this.settleMarket(id, dto.open, dto.close, dto.jodi, date);
    await this.prisma.market.update({
      where: { id },
      data: { result: `${dto.open}-${dto.jodi}-${dto.close}` },
    });

    return { ok: true, chart };
  }
  @Post('markets/:id/open-close')
  async openClose(@Param('id') id: string, @Body() dto: OpenCloseDto) {
    const market = await this.prisma.market.findUnique({ where: { id } });
    if (!market) throw new NotFoundException({ code: 'MARKET_NOT_FOUND', message: 'Market not found' });
    const updated = await this.prisma.market.update({
      where: { id },
      data: dto.action === 'open' ? { isClosed: false, isLive: true } : { isClosed: true, isLive: false },
    });
    return { ok: true, isLive: updated.isLive, isClosed: updated.isClosed };
  }

  @Patch('markets/:id/schedule')
  async updateSchedule(@Param('id') id: string, @Body() dto: UpdateMarketScheduleDto) {
    const market = await this.prisma.market.findUnique({ where: { id } });
    if (!market) throw new NotFoundException({ code: 'MARKET_NOT_FOUND', message: 'Market not found' });
    // Validate before saving: both times must parse (12h or 24h formats).
    // Overnight windows (close <= open, e.g. 22:00 -> 02:00) are legal.
    const open = parseTimeToMinutes(dto.openTime);
    const close = parseTimeToMinutes(dto.closeTime);
    if (open === null || close === null) {
      throw new BadRequestException({
        code: 'INVALID_SCHEDULE',
        message: 'Invalid schedule: use HH:MM (24h) or hh:mm AM/PM for both open and close times',
      });
    }
    if (open === close) {
      throw new BadRequestException({
        code: 'INVALID_SCHEDULE',
        message: 'Invalid schedule: open and close times must differ',
      });
    }
    const timezone = dto.timezone !== undefined ? resolveTimezone(dto.timezone) : undefined;
    if (dto.timezone !== undefined && timezone !== dto.timezone) {
      throw new BadRequestException({
        code: 'INVALID_SCHEDULE',
        message: `Unknown timezone: ${dto.timezone}`,
      });
    }
    const updated = await this.prisma.market.update({
      where: { id },
      data: {
        openTime: dto.openTime.trim(),
        closeTime: dto.closeTime.trim(),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return {
      ok: true,
      market: {
        id: updated.id,
        name: updated.name,
        openTime: updated.openTime,
        closeTime: updated.closeTime,
        timezone: updated.timezone,
        isActive: updated.isActive,
      },
    };
  }

  @Post('notices')
  async createNotice(@Body() dto: CreateNoticeDto) {
    const notice = await this.prisma.notice.create({
      data: { title: dto.title, content: dto.content, isImportant: dto.isImportant || false },
    });
    return notice;
  }

  @Delete('notices/:id')
  async deleteNotice(@Param('id') id: string) {
    const notice = await this.prisma.notice.findUnique({ where: { id } });
    if (!notice) throw new NotFoundException({ code: 'NOTICE_NOT_FOUND', message: 'Notice not found' });
    await this.prisma.notice.delete({ where: { id } });
    return { ok: true, id };
  }

  @Get('deposits')
  async deposits(@Query() query: AdminQueryDto & { status?: string }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const where: any = { type: 'CREDIT' };
    if (query.status) where.status = query.status.toUpperCase();
    if (query.search) where.title = { contains: query.search, mode: 'insensitive' as const };
    const [items, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: true },
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);
    return {
      items: items.map((t) => ({
        id: t.id,
        userId: t.userId,
        user: { name: t.user.name, phone: t.user.phone, roles: t.user.roles, balance: t.user.balance / 100 },
        amount: t.amount / 100,
        title: t.title,
        reference: t.reference,
        status: t.status.toLowerCase(),
        createdAt: t.createdAt.toISOString(),
        date: t.date.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  @Post('deposits/:id/settle')
  async settleDeposit(@Param('id') id: string, @Body() dto: { action: 'approve' | 'reject'; reason?: string }) {
    if (!dto.action || !['approve', 'reject'].includes(dto.action)) {
      throw new BadRequestException({ code: 'INVALID_ACTION', message: "action must be 'approve' or 'reject'" });
    }
    const tx = await this.prisma.walletTransaction.findUnique({ where: { id }, include: { user: true } });
    if (!tx) throw new NotFoundException({ code: 'DEPOSIT_NOT_FOUND', message: 'Deposit transaction not found' });
    if (tx.status !== 'PENDING') throw new BadRequestException({ code: 'ALREADY_SETTLED', message: 'Only pending deposits can be settled' });
    if (dto.action === 'approve') {
      await this.prisma.$transaction(async (prisma) => {
        await prisma.user.update({ where: { id: tx.userId }, data: { balance: { increment: tx.amount } } });
        await prisma.walletTransaction.update({ where: { id }, data: { status: 'COMPLETED' } });
        await prisma.order.updateMany({ where: { userId: tx.userId, status: 'PENDING', type: 'DEPOSIT', amount: tx.amount }, data: { status: 'COMPLETED' } });
      });
      return { ok: true, id, status: 'approved' };
    } else {
      await this.prisma.walletTransaction.update({ where: { id }, data: { status: 'FAILED' } });
      await this.prisma.order.updateMany({ where: { userId: tx.userId, status: 'PENDING', type: 'DEPOSIT', amount: tx.amount }, data: { status: 'FAILED' } });
      return { ok: true, id, status: 'rejected', reason: dto.reason };
    }
  }

  @Get('support/tickets')
  async supportTickets(@Query() query: AdminQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const where: any = {};
    if (query.search) where.subject = { contains: query.search, mode: 'insensitive' as const };
    const [items, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);
    // Attach user info
    const userIds = [...new Set(items.map((t) => t.messages[0]?.userId).filter(Boolean) as string[])];
    // Actually ticket has no direct user relation via messages; fetch via first message's userId or ticket.userId field if exists
    // Our SupportTicket has userId field? schema shows SupportTicket userId via? Let's fetch users for those ids
    const ticketUserIds = items.map((t: any) => (t as any).userId).filter(Boolean);
    const allUserIds = [...new Set([...userIds, ...ticketUserIds])];
    const users = allUserIds.length ? await this.prisma.user.findMany({ where: { id: { in: allUserIds } } }) : [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    return {
      items: items.map((t: any) => {
        const ticketUser = userMap.get(t.userId) || null;
        return {
          id: t.id,
          userId: t.userId,
          user: ticketUser ? { name: ticketUser.name, phone: ticketUser.phone, roles: ticketUser.roles, balance: ticketUser.balance / 100 } : null,
          subject: t.subject,
          status: t.status,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
          messages: t.messages.map((m: any) => ({ id: m.id, text: m.text, fromUser: m.fromUser, userId: m.userId, createdAt: m.createdAt.toISOString() })),
        };
      }),
      total,
      page,
      limit,
    };
  }

  @Post('support/tickets/:id/reply')
  async replySupport(@Param('id') id: string, @CurrentUser('id') adminId: string, @Body() dto: { text: string }) {
    if (!dto.text || !dto.text.trim()) throw new BadRequestException({ code: 'TEXT_REQUIRED', message: 'Reply text is required' });
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException({ code: 'TICKET_NOT_FOUND', message: 'Ticket not found' });
    const msg = await this.prisma.supportTicketMessage.create({
      data: { ticketId: id, userId: adminId, text: dto.text.trim(), fromUser: false },
    });
    await this.prisma.supportTicket.update({ where: { id }, data: { status: 'in_progress' } });
    return { id: msg.id, text: msg.text, from: 'agent', createdAt: msg.createdAt.toISOString() };
  }

  @Patch('support/tickets/:id/resolve')
  async resolveTicket(@Param('id') id: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException({ code: 'TICKET_NOT_FOUND', message: 'Ticket not found' });
    const updated = await this.prisma.supportTicket.update({ where: { id }, data: { status: 'resolved' } });
    return { ok: true, id: updated.id, status: updated.status };
  }

  @Patch('users/:id/status')
  async setUserStatus(@Param('id') rawId: string, @Body() dto: { isActive: boolean }) {
    if (typeof dto.isActive !== 'boolean') throw new BadRequestException({ code: 'INVALID_STATUS', message: 'isActive must be boolean' });
    const cleanId = rawId.replace(/^#/, '');
    let user = await this.prisma.user.findUnique({ where: { id: cleanId } });
    if (!user) user = await this.prisma.user.findFirst({ where: { referralCode: cleanId } });
    if (!user) user = await this.prisma.user.findFirst({ where: { phone: cleanId } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    const updated = await this.prisma.user.update({ where: { id: user.id }, data: { isActive: dto.isActive } });
    return { ok: true, id: `#${updated.referralCode}`, isActive: updated.isActive };
  }

  @Patch('game-rates/:id')
  async updateGameRate(@Param('id') id: string, @Body() dto: { rateRange?: string; rate?: string }) {
    const rateRange = dto.rateRange || dto.rate;
    if (!rateRange || typeof rateRange !== 'string') throw new BadRequestException({ code: 'RATE_REQUIRED', message: 'rateRange is required' });
    const existing = await this.prisma.gameRate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ code: 'GAME_RATE_NOT_FOUND', message: 'Game rate not found' });
    const updated = await this.prisma.gameRate.update({ where: { id }, data: { rateRange } });
    return updated;
  }

  @Post('wallet/adjust')
  async adjustWallet(@CurrentUser('id') adminId: string, @Body() dto: AdjustWalletDto) {
    // Manual credit/debit for testing and support corrections. ADMIN-only.
    return this.wallet.adminAdjust(adminId, {
      userId: dto.userId,
      phone: dto.phone,
      amount: dto.amount,
      direction: dto.direction,
      title: dto.title,
    });
  }

  @Post('withdrawals/:id/settle')
  async settleWithdrawal(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: SettleWithdrawalDto,
  ) {
    // Manually complete (money sent) or fail (auto-refund) a withdrawal.
    return this.wallet.settleWithdrawal(adminId, id, dto.action);
  }

  @Get('users')
  async users(@Query() query: AdminQueryDto) {
    const where = query.search
      ? { OR: [{ name: { contains: query.search, mode: 'insensitive' as const } }, { phone: { contains: query.search } }] }
      : {};
    const page = query.page || 1;
    const limit = query.limit || 20;
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      items: items.map((u) => ({
        id: `#${u.referralCode}`,
        name: u.name,
        phone: u.phone,
        balance: u.balance / 100,
        roles: u.roles,
        isActive: u.isActive,
      })),
      total,
    };
  }

  @Get('withdrawals')
  async withdrawals(@Query() query: AdminQueryDto) {
    const where = query.search ? { status: query.search.toUpperCase() as any } : {};
    const page = query.page || 1;
    const limit = query.limit || 20;
    const [items, total] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: true },
      }),
      this.prisma.withdrawal.count({ where }),
    ]);
    return {
      items: items.map((w) => ({
        id: w.id,
        user: { name: w.user.name, phone: w.user.phone },
        amount: w.amount / 100,
        method: w.method.toLowerCase(),
        status: w.status.toLowerCase(),
        createdAt: w.createdAt.toISOString(),
      })),
      total,
    };
  }

  @Get(['bets', 'bids'])
  async bets(@Query() query: AdminQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const [items, total] = await Promise.all([
      this.prisma.bid.findMany({
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: true },
      }),
      this.prisma.bid.count(),
    ]);
    return {
      items: items.map((b) => ({
        id: `BID-${b.id.slice(0, 6).toUpperCase()}`,
        user: { name: b.user.name, phone: b.user.phone },
        marketId: b.marketId,
        gameType: b.gameType,
        number: b.number,
        amount: b.amount / 100,
        status: b.status.toLowerCase(),
        date: b.date.toISOString(),
      })),
      total,
    };
  }

  private async settleMarket(marketId: string, open: string, close: string, jodi: string, date: string) {
    const openAnk = open[open.length - 1];
    const closeAnk = close[close.length - 1];
    // Scope settlement to this market day (IST) — never "all pending ever".
    const dayStart = new Date(`${date}T00:00:00+05:30`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const bids = await this.prisma.bid.findMany({
      where: { marketId, status: 'PENDING', date: { gte: dayStart, lt: dayEnd } },
    });

    const won: typeof bids = [];
    const lost: typeof bids = [];
    // Helpers for sangam/motor normalization
    const normalizeSangam = (s: string) => s.replace(/[^0-9]/g, ''); // "5*123" -> "5123", "123-456" -> "123456"
    for (const bid of bids) {
      const code = bid.gameTypeCode;
      // Every OPEN/CLOSE branch below assigns before the read at the loop end.
      let hit: boolean;
      const numNorm = normalizeSangam(bid.number);
      if (bid.round === 'OPEN') {
        if (code === 'ANK' || code === 'SD' || code === 'SDB') hit = bid.number === openAnk;
        else if (code === 'JODI' || code === 'JD' || code === 'JDB') hit = bid.number === jodi;
        else if (code === 'SP' || code === 'DP' || code === 'TP' || code === 'CP') hit = bid.number === open; // exact 3-digit panel
        else if (code === 'HF' || code === 'HS') {
          // Half Sangam: ank * panna — OPEN is openAnk + closePana (e.g. "5*123" where 5=openAnk, 123=close)
          const win1 = `${openAnk}${close}`; // "5"+"123" = "5123" without sep
          const win2 = `${openAnk}-${close}`;
          const win3 = `${openAnk}*${close}`;
          hit = numNorm === win1 || bid.number === win2 || bid.number === win3;
        } else if (code === 'FS' || code === 'F.S' || code === 'FS') {
          // Full Sangam: openPana * closePana
          const win1 = `${open}${close}`; // "123456"
          const win2 = `${open}-${close}`;
          const win3 = `${open}*${close}`;
          hit = numNorm === win1 || bid.number === win2 || bid.number === win3;
        } else if (code === 'MOTAR' || code === 'MT' || code === 'MOTOR') {
          // Motor 7 Ank: 7 digits allowed, win if openAnk is in the set
          const anks = numNorm.split(''); // "1234567" -> ['1','2',...]
          hit = anks.includes(openAnk);
        } else hit = bid.number === open;
      } else {
        // CLOSE leg
        if (code === 'ANK' || code === 'SD' || code === 'SDB') hit = bid.number === closeAnk;
        else if (code === 'JODI' || code === 'JD' || code === 'JDB') hit = bid.number === jodi;
        else if (code === 'SP' || code === 'DP' || code === 'TP' || code === 'CP') hit = bid.number === close;
        else if (code === 'HF' || code === 'HS') {
          // Half Sangam CLOSE is closeAnk * openPana
          const win1 = `${closeAnk}${open}`;
          const win2 = `${closeAnk}-${open}`;
          const win3 = `${closeAnk}*${open}`;
          hit = numNorm === win1 || bid.number === win2 || bid.number === win3;
        } else if (code === 'FS' || code === 'F.S' || code === 'FS') {
          const win1 = `${open}${close}`;
          const win2 = `${open}-${close}`;
          const win3 = `${open}*${close}`;
          hit = numNorm === win1 || bid.number === win2 || bid.number === win3;
        } else if (code === 'MOTAR' || code === 'MT' || code === 'MOTOR') {
          const anks = numNorm.split('');
          hit = anks.includes(closeAnk);
        } else hit = bid.number === close;
      }
      (hit ? won : lost).push(bid);
    }

    // Single transaction: crash mid-settlement can't half-settle the market.
    if (won.length === 0 && lost.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      // Won bids: per-user balance + wallet tx (must be individual — amounts differ).
      for (const bid of won) {
        const wonAmount = bid.amount * bid.rate;
        await tx.user.update({ where: { id: bid.userId }, data: { balance: { increment: wonAmount } } });
        await tx.bid.update({ where: { id: bid.id }, data: { status: 'WON', wonAmount } });
        await tx.walletTransaction.create({
          data: {
            userId: bid.userId,
            type: 'CREDIT',
            amount: wonAmount,
            title: `Winning bid ${bid.number} on ${marketId}`,
            status: 'COMPLETED',
            reference: bid.id,
          },
        });
      }
      // Lost bids: single bulk update instead of per-bid loop (10k bids = 1 query).
      if (lost.length > 0) {
        const lostIds = lost.map((b) => b.id);
        await tx.bid.updateMany({ where: { id: { in: lostIds } }, data: { status: 'LOST' } });
      }
    });
  }

  @Get('deposits')
  async adminListDeposits(@Query() query: any) {
    return this.wallet.adminListDeposits(query);
  }

  @Post('deposits/:id/review')
  async adminReviewDeposit(@Param('id') id: string, @Body() dto: { status: 'APPROVED' | 'REJECTED'; adminRemarks?: string }) {
    return this.wallet.adminReviewDeposit(id, dto);
  }
}