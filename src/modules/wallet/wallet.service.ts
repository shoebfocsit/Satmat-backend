import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { PaymentProvider } from '../../common/providers/payment.provider';
import { createHash, createHmac } from 'crypto';
import {
  DepositDto,
  SaveBankDetailsDto,
  WithdrawDto,
} from './dto/wallet.dto';

export interface AdminAdjustDto {
  userId?: string;
  phone?: string;
  /** paise (integer, > 0) */
  amount: number;
  direction: 'credit' | 'debit';
  title?: string;
}

@Injectable()
export class WalletService implements OnModuleInit {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cache: CacheService,
    @Inject('PAYMENT_PROVIDER') private readonly payments: PaymentProvider,
  ) {}

  onModuleInit() {
    if (this.isManualMode()) {
      this.logger.warn(
        'MANUAL_PAYMENTS=true — deposits and withdrawals settle INSTANTLY (test mode). ' +
          'Turn it off before real users arrive, or money moves without a gateway.',
      );
    }
  }

  /**
   * Manual/test settlement mode. When true, mock deposits credit instantly on
   * verify and withdrawals complete instantly — no payment gateway involved.
   * Strictly for testing; never enable with real users.
   */
  isManualMode(): boolean {
    return this.config.get<string>('MANUAL_PAYMENTS') === 'true';
  }

  async getBalance(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    return { balance: user.balance / 100, currency: 'INR' };
  }

  async deposit(userId: string, dto: DepositDto) {
    const order = await this.payments.createDepositOrder({
      userId,
      amount: dto.amount,
      method: dto.method,
    });

    await this.prisma.walletTransaction.create({
      data: {
        userId,
        type: 'CREDIT',
        amount: dto.amount,
        title: `Deposit order ${order.orderId}`,
        status: 'PENDING',
        reference: order.orderId,
      },
    });

    await this.prisma.order.create({
      data: {
        userId,
        marketName: 'Wallet Deposit',
        amount: dto.amount,
        status: 'PENDING',
        type: 'DEPOSIT',
      },
    });

    return order;
  }

  async verifyDeposit(userId: string, orderId: string) {
    const tx = await this.prisma.walletTransaction.findFirst({
      where: { reference: orderId, userId },
    });
    if (!tx) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Deposit order not found' });

    // Mock provider auto-reports paid:true. In production that is only
    // acceptable in explicit manual/test mode — never with real users.
    if (
      this.config.get('NODE_ENV') === 'production' &&
      (this.payments as any)?.constructor?.name === 'MockPaymentProvider' &&
      !this.isManualMode()
    ) {
      throw new BadRequestException({ code: 'MOCK_DISABLED', message: 'Manual deposit verification is disabled in production' });
    }

    // Razorpay stores orderId as `ORD-<pgOrderId>`; mock uses `PG-<orderId>`.
    const pgOrderId = orderId.startsWith('ORD-') ? orderId.slice(4) : `PG-${orderId}`;
    const verification = await this.payments.verifyDeposit(orderId, pgOrderId);
    if (verification.paid && tx.status === 'PENDING') {
      await this.prisma.$transaction(async (prisma) => {
        await prisma.user.update({ where: { id: userId }, data: { balance: { increment: tx.amount } } });
        await prisma.walletTransaction.update({ where: { id: tx.id }, data: { status: 'COMPLETED' } });
        await this.markSiblingDepositOrderComplete(prisma, tx);
        await this.handleReferralBonus(userId, prisma);
      });
    }
    return { status: verification.paid ? 'COMPLETED' : tx.status.toLowerCase(), balance: await this.getBalance(userId) };
  }

  // Complete ONLY the Order row created alongside this deposit (same user +
  // amount + created within minutes). Order has no reference column, so a
  // blanket updateMany would wrongly complete every pending deposit.
  private async markSiblingDepositOrderComplete(db: any, tx: { userId: string; amount: number; createdAt?: Date | string }) {
    const where: any = { userId: tx.userId, status: 'PENDING', type: 'DEPOSIT', amount: tx.amount };
    if (tx.createdAt) {
      const t = new Date(tx.createdAt).getTime();
      if (!Number.isNaN(t)) {
        where.createdAt = { gte: new Date(t - 5 * 60 * 1000), lte: new Date(t + 5 * 60 * 1000) };
      }
    }
    await db.order.updateMany({ where, data: { status: 'COMPLETED' } });
  }

  // Payment gateway webhook — HMAC verified via x-webhook-signature against PAYMENT_WEBHOOK_SECRET
  // Idempotent: uses Redis to track processed webhook event IDs
  async depositWebhook(payload: any, signature?: string) {
    const secret = this.config.get('PAYMENT_WEBHOOK_SECRET') || '';
    if (!secret) {
      if (this.config.get('NODE_ENV') === 'production') {
        throw new BadRequestException({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'Payment webhook secret not configured' });
      }
      // In development, allow unverified webhooks
    } else {
      const verifier = (this.payments as any).verifyWebhookSignature?.bind(this.payments);
      const ok = verifier
        ? verifier(payload, signature, secret)
        : this.verifyHmac(payload, signature, secret);
      if (!ok) {
        throw new BadRequestException({ code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' });
      }
    }

    const orderId = payload.order_id || payload.orderId;
    const status = payload.status || payload.event?.split('.')[0];
    const paid = status === 'paid' || status === 'authorized';

    // Idempotency: deterministic key so provider retries dedupe. Date.now()
    // must NOT be part of the key — every redelivery would otherwise
    // double-credit.
    const eventId =
      payload.id ||
      payload.event_id ||
      (orderId
        ? `deposit:${orderId}:${status}`
        : `body:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`);
    const idempotencyKey = `webhook:${eventId}`;
    const processed = await this.cache.has(idempotencyKey);
    if (processed) {
      return { received: true, duplicate: true };
    }

    const tx = await this.prisma.walletTransaction.findFirst({ where: { reference: orderId } });
    if (tx && paid && tx.status === 'PENDING') {
      await this.prisma.$transaction(async (prisma) => {
        await prisma.user.update({ where: { id: tx.userId }, data: { balance: { increment: tx.amount } } });
        await prisma.walletTransaction.update({ where: { id: tx.id }, data: { status: 'COMPLETED' } });
        await this.markSiblingDepositOrderComplete(prisma, tx);
        await this.handleReferralBonus(tx.userId, prisma);
      });
    }

    // Mark webhook as processed (24 hour TTL)
    await this.cache.set(idempotencyKey, true, 24 * 60 * 60 * 1000);
    return { received: true };
  }

  async withdraw(userId: string, dto: WithdrawDto) {
    let bankDetailsId = dto.bankDetailsId;
    if (dto.payout === 'bank') {
      const bank = await this.prisma.bankDetails.findUnique({ where: { userId } });
      if (!bank && !bankDetailsId) {
        throw new BadRequestException({ code: 'BANK_DETAILS_REQUIRED', message: 'Save bank details before withdrawing' });
      }
      bankDetailsId = bankDetailsId || bank!.id;
    }

    // Manual/test mode settles instantly (no payout gateway to wait for).
    const autoSettle = this.isManualMode();

    const withdrawal = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
      if (user.balance < dto.amount) {
        throw new BadRequestException({ code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance for withdrawal' });
      }

      await tx.user.update({ where: { id: userId }, data: { balance: { decrement: dto.amount } } });
      const created = await tx.withdrawal.create({
        data: {
          userId,
          amount: dto.amount,
          method: dto.payout === 'bank' ? 'BANK' : 'UPI',
          upiId: dto.upiId,
          bankDetailsId,
          status: autoSettle ? 'COMPLETED' : 'PENDING',
        },
      });
      await tx.walletTransaction.create({
        data: {
          userId,
          type: 'DEBIT',
          amount: dto.amount,
          title: autoSettle ? 'Withdrawal (manual test, auto-settled)' : 'Withdrawal request',
          status: autoSettle ? 'COMPLETED' : 'PENDING',
          reference: created.id,
        },
      });
      return created;
    });

    if (autoSettle) {
      this.logger.warn(`manual withdrawal auto-settled user=${userId} id=${withdrawal.id} amount=${withdrawal.amount}`);
    }
    return { requestId: withdrawal.id, status: autoSettle ? 'completed' : 'pending', amount: withdrawal.amount / 100 };
  }

  /**
   * Manual balance adjustment (ADMIN only — enforced by RolesGuard).
   * The support/testing tool for crediting test funds or correcting ledgers.
   * Fully atomic with a ledger row; debits can never drive balance negative.
   */
  async adminAdjust(adminId: string, dto: AdminAdjustDto) {
    if (!dto.userId && !dto.phone) {
      throw new BadRequestException({ code: 'USER_REQUIRED', message: 'Provide userId or phone' });
    }
    const user = dto.userId
      ? await this.prisma.user.findUnique({ where: { id: dto.userId } })
      : await this.prisma.user.findFirst({ where: { phone: dto.phone } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });

    const title = dto.title?.trim() || `Admin ${dto.direction} by ${adminId}`;
    if (dto.direction === 'credit') {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { balance: { increment: dto.amount } } });
        await tx.walletTransaction.create({
          data: { userId: user.id, type: 'CREDIT', amount: dto.amount, title, status: 'COMPLETED', reference: `admin:${adminId}` },
        });
      });
    } else {
      const res = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.user.updateMany({
          where: { id: user.id, balance: { gte: dto.amount } },
          data: { balance: { decrement: dto.amount } },
        });
        if (claimed.count === 0) {
          throw new BadRequestException({ code: 'INSUFFICIENT_BALANCE', message: 'User balance is insufficient for this debit' });
        }
        await tx.walletTransaction.create({
          data: { userId: user.id, type: 'DEBIT', amount: dto.amount, title, status: 'COMPLETED', reference: `admin:${adminId}` },
        });
      });
      void res;
    }

    const fresh = await this.prisma.user.findUnique({ where: { id: user.id } });
    this.logger.warn(`admin wallet adjust admin=${adminId} user=${user.id} ${dto.direction}=${dto.amount}`);
    return { ok: true, userId: user.id, delta: dto.direction === 'credit' ? dto.amount / 100 : -dto.amount / 100, balance: (fresh?.balance ?? 0) / 100 };
  }

  /**
   * Manually settle a PENDING withdrawal (ADMIN only): `complete` marks the
   * money as sent, `fail` refunds it atomically. Terminal states are final —
   * double-settling is rejected, never double-applied.
   */
  async settleWithdrawal(adminId: string, id: string, action: 'complete' | 'fail') {
    const w = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!w) throw new NotFoundException({ code: 'WITHDRAWAL_NOT_FOUND', message: 'Withdrawal not found' });
    if (w.status !== 'PENDING') {
      throw new BadRequestException({ code: 'WITHDRAWAL_NOT_SETTLABLE', message: 'Only pending withdrawals can be settled' });
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.withdrawal.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: action === 'complete' ? 'COMPLETED' : 'FAILED' },
      });
      if (claimed.count === 0) {
        throw new BadRequestException({ code: 'WITHDRAWAL_NOT_SETTLABLE', message: 'Withdrawal was already settled' });
      }
      await tx.walletTransaction.updateMany({
        where: { reference: id, status: 'PENDING' },
        data: { status: 'COMPLETED' },
      });
      if (action === 'fail') {
        await tx.user.update({ where: { id: w.userId }, data: { balance: { increment: w.amount } } });
        await tx.walletTransaction.create({
          data: {
            userId: w.userId,
            type: 'CREDIT',
            amount: w.amount,
            title: `Withdrawal failed refund (admin ${adminId})`,
            status: 'COMPLETED',
            reference: w.id,
          },
        });
      }
    });

    this.logger.warn(`admin withdrawal settle admin=${adminId} id=${id} action=${action} amount=${w.amount}`);
    return { ok: true, id, status: action === 'complete' ? 'completed' : 'failed' };
  }

  // Payout provider webhook — HMAC verified via x-webhook-signature.
  // Idempotent: deterministic key + terminal-state guard so retries can
  // neither double-refund nor flap a settled withdrawal.
  async withdrawWebhook(payload: any, signature?: string) {
    const secret =
      this.config.get('PAYOUT_WEBHOOK_SECRET') || this.config.get('PAYMENT_WEBHOOK_SECRET') || '';
    if (!secret) {
      if (this.config.get('NODE_ENV') === 'production') {
        throw new BadRequestException({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'Payout webhook secret not configured' });
      }
      // In development, allow unverified webhooks
    } else if (!this.verifyHmac(payload, signature, secret)) {
      throw new BadRequestException({ code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' });
    }

    const id = payload.request_id || payload.requestId;
    if (!id) return { received: true };

    // Idempotency: deterministic key so provider retries dedupe.
    const eventId =
      payload.id ||
      payload.event_id ||
      `withdraw:${id}:${payload.status || 'unknown'}`;
    const idempotencyKey = `webhook:${eventId}`;
    const processed = await this.cache.has(idempotencyKey);
    if (processed) {
      return { received: true, duplicate: true };
    }

    const statusMap: Record<string, any> = {
      paid: 'COMPLETED',
      completed: 'COMPLETED',
      failed: 'FAILED',
      processing: 'PROCESSING',
    };
    const next = statusMap[payload.status] || 'PROCESSING';
    const w = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!w) {
      await this.cache.set(idempotencyKey, true, 24 * 60 * 60 * 1000);
      return { received: true };
    }

    // Terminal states are final — late/duplicate webhooks change nothing.
    if (w.status === 'COMPLETED' || w.status === 'FAILED') {
      await this.cache.set(idempotencyKey, true, 24 * 60 * 60 * 1000);
      return { received: true, duplicate: true };
    }

    await this.prisma.withdrawal.update({ where: { id }, data: { status: next } });
    if (next === 'FAILED') {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: w.userId }, data: { balance: { increment: w.amount } } });
        await tx.walletTransaction.create({
          data: {
            userId: w.userId,
            type: 'CREDIT',
            amount: w.amount,
            title: 'Withdrawal failed refund',
            status: 'COMPLETED',
            reference: w.id,
          },
        });
      });
    }

    // Mark webhook as processed (24 hour TTL)
    await this.cache.set(idempotencyKey, true, 24 * 60 * 60 * 1000);
    return { received: true };
  }

  async listWithdrawals(userId: string, query: any) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const where: any = { userId };
    if (query.status) where.status = query.status.toUpperCase();
    const [items, total] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.withdrawal.count({ where }),
    ]);
    return {
      items: items.map((w) => ({
        id: w.id,
        amount: w.amount / 100,
        method: w.method.toLowerCase(),
        status: w.status.toLowerCase(),
        createdAt: w.createdAt.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  async listTransactions(userId: string, query: any) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const where: any = { userId };
    if (query.type === 'credit') where.type = 'CREDIT';
    if (query.type === 'debit') where.type = 'DEBIT';
    if (query.type === 'pending') where.status = 'PENDING';
    if (query.search) {
      where.title = { contains: query.search, mode: 'insensitive' };
    }
    const [items, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);
    return {
      items: items.map((t) => ({
        id: t.id,
        type: t.type.toLowerCase(),
        amount: t.amount / 100,
        title: t.title,
        date: t.date.toISOString(),
        status: t.status.toLowerCase(),
      })),
      total,
      page,
      limit,
    };
  }

  async getBankDetails(userId: string) {
    const bank = await this.prisma.bankDetails.findUnique({ where: { userId } });
    if (!bank) return null;
    return {
      accountHolder: bank.accountHolder,
      accountNumber: bank.accountNumber,
      ifscCode: bank.ifscCode,
      bankName: bank.bankName,
    };
  }

  async saveBankDetails(userId: string, dto: SaveBankDetailsDto) {
    const data = { userId, ...dto };
    const bank = await this.prisma.bankDetails.upsert({
      where: { userId },
      update: dto,
      create: data,
    });
    return {
      accountHolder: bank.accountHolder,
      accountNumber: bank.accountNumber,
      ifscCode: bank.ifscCode,
      bankName: bank.bankName,
    };
  }

  async getWinnings(userId: string, query: any) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const wonBids = await this.prisma.bid.findMany({
      where: { userId, status: 'WON' },
      orderBy: { date: 'desc' },
    });
    const items = wonBids.slice((page - 1) * limit, page * limit);
    const totalWinnings = wonBids.reduce((sum, b) => sum + (b.wonAmount || b.amount * b.rate), 0);
    return {
      totalWinnings: totalWinnings / 100,
      winningCount: wonBids.length,
      items: items.map((b) => ({
        id: b.id,
        marketName: b.marketId,
        gameType: b.gameType,
        number: b.number,
        amount: b.amount / 100,
        wonAmount: (b.wonAmount || b.amount * b.rate) / 100,
        date: b.date.toISOString(),
      })),
    };
  }

  private verifyHmac(payload: any, signature: string | undefined, secret: string): boolean {
    if (!signature) return false;
    try {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const expected = createHmac('sha256', secret).update(body).digest('hex');
      return signature === expected || signature === `sha256=${expected}`;
    } catch {
      return false;
    }
  }

  private async handleReferralBonus(userId: string, _tx?: any) {
    const db: any = _tx || this.prisma;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user?.referredBy) return;
    const referrer = await db.user.findFirst({ where: { referralCode: user.referredBy } });
    if (!referrer) return;

    const existing = await db.referral.findFirst({
      where: { referrerId: referrer.id, inviteePhone: user.phone },
    });
    if (existing?.bonusCredited) return;

    const bonus = 1000; // paise ₹10
    // Run in the caller's transaction if one is active; otherwise use a standalone transaction.
    const run = async (tx: any) => {
      await tx.user.update({ where: { id: referrer.id }, data: { balance: { increment: bonus } } });
      await tx.walletTransaction.create({
        data: {
          userId: referrer.id,
          type: 'CREDIT',
          amount: bonus,
          title: `Referral bonus for ${user.name}`,
          status: 'COMPLETED',
        },
      });
      await tx.referral.create({
        data: {
          referrerId: referrer.id,
          inviteePhone: user.phone,
          bonusCredited: true,
        },
      });
    };
    if (_tx) {
      await run(_tx);
    } else {
      await this.prisma.$transaction(async (tx) => run(tx));
    }
  }

  async initManualDeposit(userId: string, dto: { amount: number }) {
    const referenceId = 'BaBaTaj-' + Math.random().toString(36).substring(2, 10).toUpperCase() + '-' + Date.now().toString().slice(-4);
    const deposit = await this.prisma.deposit.create({
      data: {
        userId,
        amount: dto.amount,
        referenceId,
        status: 'PENDING',
      },
    });

    const merchantUpi = this.config.get<string>('MERCHANT_UPI') || 'Q113570341@ybl';
    const merchantName = 'BaBaTaj';
    const amountRs = dto.amount / 100;
    const upiLink = `upi://pay?pa=${merchantUpi}&pn=${encodeURIComponent(merchantName)}&am=${amountRs}&tr=${deposit.id}&tn=${referenceId}`;

    return {
      success: true,
      depositId: deposit.id,
      referenceId: deposit.referenceId,
      amount: amountRs,
      merchantUpi,
      merchantName,
      upiLink,
      status: deposit.status,
    };
  }

  async submitDepositProof(userId: string, dto: { depositId: string; utr: string; screenshotUrl?: string }) {
    const deposit = await this.prisma.deposit.findFirst({
      where: { id: dto.depositId, userId },
    });
    if (!deposit) {
      throw new NotFoundException({ code: 'DEPOSIT_NOT_FOUND', message: 'Deposit request not found' });
    }
    if (deposit.status !== 'PENDING') {
      throw new BadRequestException({ code: 'INVALID_STATUS', message: 'Only pending deposit requests can submit proof' });
    }

    const existingUtr = await this.prisma.deposit.findUnique({
      where: { utr: dto.utr.trim() },
    });
    if (existingUtr) {
      throw new BadRequestException({ code: 'DUPLICATE_UTR', message: 'This UTR number has already been submitted' });
    }

    const updated = await this.prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        utr: dto.utr.trim(),
        screenshotUrl: dto.screenshotUrl,
        status: 'SUBMITTED',
      },
    });

    return {
      success: true,
      deposit: {
        id: updated.id,
        amount: updated.amount / 100,
        referenceId: updated.referenceId,
        utr: updated.utr,
        status: updated.status,
        createdAt: updated.createdAt.toISOString(),
      },
    };
  }

  async listUserDeposits(userId: string) {
    const items = await this.prisma.deposit.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      items: items.map((d) => ({
        id: d.id,
        amount: d.amount / 100,
        referenceId: d.referenceId,
        utr: d.utr,
        screenshotUrl: d.screenshotUrl,
        status: d.status,
        adminRemarks: d.adminRemarks,
        createdAt: d.createdAt.toISOString(),
      })),
    };
  }

  async adminListDeposits(query: { status?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const where: any = {};
    if (query.status) {
      where.status = query.status.toUpperCase();
    }
    const [items, total] = await Promise.all([
      this.prisma.deposit.findMany({
        where,
        include: { user: { select: { id: true, name: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.deposit.count({ where }),
    ]);

    return {
      items: items.map((d) => ({
        id: d.id,
        user: d.user,
        amount: d.amount / 100,
        referenceId: d.referenceId,
        utr: d.utr,
        screenshotUrl: d.screenshotUrl,
        status: d.status,
        adminRemarks: d.adminRemarks,
        createdAt: d.createdAt.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  async adminReviewDeposit(depositId: string, dto: { status: 'APPROVED' | 'REJECTED'; adminRemarks?: string }) {
    const deposit = await this.prisma.deposit.findUnique({
      where: { id: depositId },
    });
    if (!deposit) {
      throw new NotFoundException({ code: 'DEPOSIT_NOT_FOUND', message: 'Deposit request not found' });
    }
    if (deposit.status === 'APPROVED' || deposit.status === 'REJECTED') {
      throw new BadRequestException({ code: 'ALREADY_PROCESSED', message: `Deposit is already ${deposit.status.toLowerCase()}` });
    }

    if (dto.status === 'APPROVED') {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.deposit.update({
          where: { id: depositId },
          data: { status: 'APPROVED', adminRemarks: dto.adminRemarks },
        });

        await tx.user.update({
          where: { id: deposit.userId },
          data: { balance: { increment: deposit.amount } },
        });

        await tx.walletTransaction.create({
          data: {
            userId: deposit.userId,
            type: 'CREDIT',
            amount: deposit.amount,
            title: `Manual Deposit Approved (UTR: ${deposit.utr || 'N/A'})`,
            status: 'COMPLETED',
            reference: deposit.id,
          },
        });

        await tx.order.create({
          data: {
            userId: deposit.userId,
            marketName: 'Manual Deposit',
            amount: deposit.amount,
            status: 'COMPLETED',
            type: 'DEPOSIT',
          },
        });

        return { success: true, deposit: updated };
      });
    } else {
      const updated = await this.prisma.deposit.update({
        where: { id: depositId },
        data: { status: 'REJECTED', adminRemarks: dto.adminRemarks || 'Rejected by admin' },
      });
      return { success: true, deposit: updated };
    }
  }
}