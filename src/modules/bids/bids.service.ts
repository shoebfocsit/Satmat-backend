import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Bid } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketStatusService } from '../markets/market-status.service';
import { marketWindowInstants, nowMinutesIST, parseTimeToMinutes } from '../../common/utils/market-time';
import { CreateBidDto, CreateBulkBidDto, ListBidsQueryDto } from './dto/bids.dto';

const RATE_BY_GAME: Record<string, number> = {
  ANK: 95, // 10 → 95
  'Single Digit': 95, // legacy alias
  JODI: 950, // 10 → 950
  'Jodi Digit': 950,
  SP: 1500,
  'Single Pana': 1500,
  DP: 3000,
  'Double Pana': 3000,
  TP: 5000,
  'Triple Pana': 5000,
  CP: 1500, // Cycle Pana 1500/3000 (store 1500)
  'Cycle Pana': 1500,
  'HF.S': 10000,
  'Half Sangam': 10000,
  'F.S': 100000,
  'Full Sangam': 100000,
  MOTAR: 30, // MOTOR 7 ANK 15/30 (use 30)
  Motor: 30,
};

const CODE_BY_GAME: Record<string, string> = {
  ANK: 'ANK',
  'Single Digit': 'ANK',
  JODI: 'JODI',
  'Jodi Digit': 'JODI',
  SP: 'SP',
  'Single Pana': 'SP',
  DP: 'DP',
  'Double Pana': 'DP',
  TP: 'TP',
  'Triple Pana': 'TP',
  CP: 'CP',
  'Cycle Pana': 'CP',
  'HF.S': 'HF',
  'Half Sangam': 'HF',
  'F.S': 'FS',
  'Full Sangam': 'FS',
  MOTAR: 'MOTAR',
  Motor: 'MOTAR',
};

/** Hard cap on bulk batch size (abuse guard; totals are balance-bounded anyway). */
const MAX_BULK_ITEMS = 50;

interface ResolvedGame {
  gameType: string;
  code: string;
  rate: number;
}

@Injectable()
export class BidsService implements OnModuleInit {
  private readonly logger = new Logger(BidsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketStatus: MarketStatusService,
  ) {}

  /**
   * Boot-time self-heal for the idempotency ledger (same story as the market
   * columns: manual Render services may never run `migrate deploy`). Without
   * the table, the first keyed bid would die mid-transaction.
   */
  async onModuleInit() {
    await this.ensureIdempotencyTable().catch(() => undefined);
  }

  /**
   * Run a bid/cancel transaction with one heal-and-retry. Postgres ABORTS a
   * transaction on the first failed statement, so a lazily-healed table
   * (P2021/P2022, surfaced directly or as 25P02 on the next statement) must
   * never be caught-and-continued inside the tx. Instead: let it roll back,
   * heal OUTSIDE any transaction, and retry exactly once on fresh
   * connections. The retry is safe — the failed attempt committed nothing.
   */
  private async transactWithHeal<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== 'P2021' && code !== 'P2022' && code !== '25P02') throw err;
      this.logger.warn(`tx hit ${code} — healing ledger/market tables outside tx and retrying once`);
      await this.ensureIdempotencyTable().catch(() => undefined);
      await this.marketStatus.ensureMarketColumns().catch(() => undefined);
      return this.prisma.$transaction(fn);
    }
  }

  // -- placement ----------------------------------------------------------

  async placeBid(userId: string, dto: CreateBidDto, idemKey?: string) {
    // 1-7. Auth (guard) -> market -> active -> window, all server-side.
    // Fast pre-check outside the tx so obviously-closed markets fail fast;
    // the binding check is re-run INSIDE the tx (race protection).
    await this.marketStatus.assertBiddable(dto.marketId, { round: 'OPEN' });
    const game = this.resolveGame(dto.gameType);
    const number = this.validateNumberForGame(game.code, dto.number);

    if (idemKey) {
      const replay = await this.findReplay(userId, idemKey);
      if (replay) return replay;
    }

    const placed = await this.transactWithHeal(async (tx) => {
      // Re-validate the window at commit time: a request that passed the
      // pre-check must still die if the market closes while queued.
      const market = await this.marketStatus.assertBiddable(dto.marketId, { tx, race: true, round: 'OPEN' });

      if (idemKey) await this.claimIdemKey(tx, userId, idemKey);

      await this.debitWallet(tx, userId, dto.amount);

      const created = await tx.bid.create({
        data: {
          userId,
          marketId: dto.marketId,
          gameType: dto.gameType,
          gameTypeCode: game.code as any,
          number,
          amount: dto.amount,
          rate: game.rate,
          round: 'OPEN',
        },
      });

      await tx.walletTransaction.create({
        data: {
          userId,
          type: 'DEBIT',
          amount: dto.amount,
          title: `Bid on ${market.name} (${dto.gameType} ${number})`,
          status: 'COMPLETED',
          reference: created.id,
        },
      });

      await tx.order.create({
        data: {
          userId,
          marketId: dto.marketId,
          marketName: market.name,
          amount: dto.amount,
          status: 'COMPLETED',
          type: 'BID',
        },
      });

      const result = {
        success: true,
        bid: this.serialize(created),
        market: this.marketSlice(market),
      };
      if (idemKey) await this.storeReplay(tx, userId, idemKey, 201, result);
      return result;
    }).catch((err) => {
      // A lost idempotency race surfaces the winner's stored response.
      if (err instanceof ConflictException && idemKey) {
        return this.requireReplay(userId, idemKey);
      }
      throw err;
    });

    this.logger.log(
      `bid accepted user=${userId} market=${dto.marketId} game=${game.code} number=${number} amount=${dto.amount} bid=${(placed as any).bid?.id}`,
    );
    return placed;
  }

  async placeBulkBid(userId: string, dto: CreateBulkBidDto, idemKey?: string) {
    if (dto.items.length > MAX_BULK_ITEMS) {
      throw new BadRequestException({
        code: 'INVALID_BID',
        message: `Too many items in one request (max ${MAX_BULK_ITEMS})`,
      });
    }
    await this.marketStatus.assertBiddable(dto.marketId, { round: dto.round });
    const game = this.resolveGame(dto.gameType);
    const numbers = dto.items.map((i) => this.validateNumberForGame(game.code, i.number));
    const totalAmount = dto.items.reduce((sum, i) => sum + i.amount, 0);

    if (idemKey) {
      const replay = await this.findReplay(userId, idemKey);
      if (replay) return replay;
    }

    const placed = await this.transactWithHeal(async (tx) => {
      const market = await this.marketStatus.assertBiddable(dto.marketId, { tx, race: true, round: dto.round });

      if (idemKey) await this.claimIdemKey(tx, userId, idemKey);

      await this.debitWallet(tx, userId, totalAmount);

      const created: Bid[] = [];
      for (let idx = 0; idx < dto.items.length; idx++) {
        const bid = await tx.bid.create({
          data: {
            userId,
            marketId: dto.marketId,
            gameType: dto.gameType,
            gameTypeCode: game.code as any,
            number: numbers[idx],
            amount: dto.items[idx].amount,
            rate: game.rate,
            round: dto.round,
          },
        });
        created.push(bid);
      }

      await tx.walletTransaction.create({
        data: {
          userId,
          type: 'DEBIT',
          amount: totalAmount,
          title: `Bulk bid on ${market.name} (${dto.gameType})`,
          status: 'COMPLETED',
          reference: created[0].id,
        },
      });

      await tx.order.create({
        data: {
          userId,
          marketId: dto.marketId,
          marketName: market.name,
          amount: totalAmount,
          status: 'COMPLETED',
          type: 'BID',
        },
      });

      const result = {
        success: true,
        bids: created.map((b) => this.serialize(b)),
        totalAmount: totalAmount / 100,
        market: this.marketSlice(market),
      };
      if (idemKey) await this.storeReplay(tx, userId, idemKey, 201, result);
      return result;
    }).catch((err) => {
      if (err instanceof ConflictException && idemKey) {
        return this.requireReplay(userId, idemKey);
      }
      throw err;
    });

    this.logger.log(
      `bulk bid accepted user=${userId} market=${dto.marketId} game=${game.code} items=${dto.items.length} total=${totalAmount}`,
    );
    return placed;
  }

  // -- reads --------------------------------------------------------------

  async listBids(userId: string, query: ListBidsQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const where: any = { userId };
    if (query.status) {
      const map: Record<string, string> = { pending: 'PENDING', won: 'WON', lost: 'LOST', cancelled: 'CANCELLED' };
      where.status = map[query.status] || query.status.toUpperCase();
    }
    const [items, total] = await Promise.all([
      this.prisma.bid.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.bid.count({ where }),
    ]);
    return { items: items.map((b) => this.serialize(b)), total, page, limit };
  }

  async getBid(userId: string, id: string) {
    const bid = await this.prisma.bid.findFirst({ where: { id, userId } });
    if (!bid) throw new NotFoundException({ code: 'BID_NOT_FOUND', message: 'Bid not found' });
    return this.serialize(bid);
  }

  async cancelBid(userId: string, id: string, idemKey?: string) {
    // Everything — status read, window check, leg check, PENDING claim,
    // refund — happens inside ONE transaction so two concurrent cancels (or a
    // cancel landing exactly at close) can never double-refund or slip past
    // the close rule. The idempotency ledger makes retries replay instead of
    // erroring after a successful refund.
    if (idemKey) {
      const replay = await this.findReplay(userId, idemKey);
      if (replay) return replay;
    }
    const result = await this.transactWithHeal(async (tx) => {
      const bid = await tx.bid.findFirst({ where: { id, userId } });
      if (!bid) throw new NotFoundException({ code: 'BID_NOT_FOUND', message: 'Bid not found' });
      if (bid.status !== 'PENDING') {
        throw new BadRequestException({ code: 'BID_NOT_CANCELLABLE', message: 'Only pending bids can be cancelled' });
      }
      // Cancellation is allowed while the market is OPEN or SCHEDULED
      // (upcoming); only a finished/declared session blocks refunds.
      try {
        await this.marketStatus.assertBiddable(bid.marketId, { tx, race: true });
      } catch (err) {
        if (err instanceof NotFoundException) throw err;
        const code = (err as any)?.response?.code;
        if (code !== 'MARKET_NOT_OPEN') {
          throw new ForbiddenException({ code: 'MARKET_CLOSED', message: 'Cannot cancel after market close' });
        }
      }
      // An OPEN-leg bid whose open is already declared is decided — no refund.
      if (bid.round === 'OPEN' && (await this.marketStatus.isOpenDeclared(bid.marketId, { tx }))) {
        throw new BadRequestException({
          code: 'BID_NOT_CANCELLABLE',
          message: 'Open result already declared — this bid can no longer be cancelled',
        });
      }

      // 5-minute pre-open / pre-close cancellation rule
      const marketRow = await tx.market?.findUnique?.({ where: { id: bid.marketId } }).catch(() => null);
      if (marketRow) {
        const nowMins = nowMinutesIST(new Date(), marketRow.timezone);
        const openMins = parseTimeToMinutes(marketRow.openTime);
        const closeMins = parseTimeToMinutes(marketRow.closeTime);

        if (bid.round === 'OPEN' && openMins !== null) {
          if (nowMins >= openMins - 5) {
            throw new BadRequestException({
              code: 'BID_NOT_CANCELLABLE',
              message: 'Bids cannot be cancelled within 5 minutes of market open time',
            });
          }
        } else if (closeMins !== null) {
          if (nowMins >= closeMins - 5) {
            throw new BadRequestException({
              code: 'BID_NOT_CANCELLABLE',
              message: 'Bids cannot be cancelled within 5 minutes of market close time',
            });
          }
        }
      }
      if (idemKey) await this.claimIdemKey(tx, userId, idemKey);
      // Conditional claim: exactly one concurrent canceller wins.
      const claimed = await tx.bid.updateMany({
        where: { id, userId, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      if (claimed.count === 0) {
        throw new BadRequestException({ code: 'BID_NOT_CANCELLABLE', message: 'Only pending bids can be cancelled' });
      }
      await tx.user.update({ where: { id: userId }, data: { balance: { increment: bid.amount } } });
      await tx.walletTransaction.create({
        data: {
          userId,
          type: 'CREDIT',
          amount: bid.amount,
          title: `Bid cancelled refund (${bid.marketId})`,
          status: 'COMPLETED',
          reference: bid.id,
        },
      });
      const done = await tx.bid.findUnique({ where: { id } });
      const out = { success: true, bid: this.serialize(done) };
      if (idemKey) await this.storeReplay(tx, userId, idemKey, 201, out);
      return out;
    }).catch((err) => {
      if (err instanceof ConflictException && idemKey) {
        return this.requireReplay(userId, idemKey);
      }
      throw err;
    });

    this.logger.log(`bid cancelled user=${userId} bid=${id}`);
    return result;
  }

  // -- validation (server-side, never client-trusted) ----------------------

  /** Unknown game types are rejected — never silently stored with a guess rate. */
  private resolveGame(gameType: string): ResolvedGame {
    const code = CODE_BY_GAME[gameType];
    const rate = RATE_BY_GAME[gameType];
    if (!code || !rate) {
      throw new BadRequestException({
        code: 'INVALID_BID',
        message: `Unsupported game type: ${gameType}`,
      });
    }
    return { gameType, code, rate };
  }

  /** Per-game number shape check. Returns the canonical stored form. */
  private validateNumberForGame(code: string, raw: string): string {
    const v = (raw || '').trim();
    const invalid = (message: string) =>
      new BadRequestException({ code: 'INVALID_BID', message });
    switch (code) {
      case 'ANK':
        if (!/^[0-9]$/.test(v)) throw invalid('ANK is a single digit 0-9');
        return v;
      case 'JODI':
        if (!/^[0-9]{2}$/.test(v)) throw invalid('JODI is 2 digits 00-99');
        return v;
      case 'SP': {
        if (!/^[0-9]{3}$/.test(v)) throw invalid('Single Pana is 3 digits (e.g. 123)');
        const [a, b, c] = v.split('');
        if (a === b || b === c || a === c) throw invalid('Single Pana needs 3 distinct digits (e.g. 123)');
        return v;
      }
      case 'DP': {
        if (!/^[0-9]{3}$/.test(v)) throw invalid('Double Pana is 3 digits (e.g. 112)');
        if (new Set(v.split('')).size !== 2) throw invalid('Double Pana needs exactly one pair (e.g. 112)');
        return v;
      }
      case 'TP':
        if (!/^(.)\1\1$/.test(v)) throw invalid('Triple Pana needs 3 identical digits (e.g. 777)');
        return v;
      case 'CP':
        if (!/^[0-9]{3}$/.test(v)) throw invalid('Cycle Pana is 3 digits (e.g. 123)');
        return v;
      case 'HF': {
        const digits = v.replace(/[^0-9]/g, '');
        const m = v.match(/^([0-9])[*-]?([0-9]{3})$/);
        if (!m || digits.length !== 4) throw invalid('Half Sangam is Ank*Pana e.g. 5*123');
        return `${m[1]}*${m[2]}`;
      }
      case 'FS': {
        const digits = v.replace(/[^0-9]/g, '');
        const m = v.match(/^([0-9]{3})[*-]?([0-9]{3})$/);
        if (!m || digits.length !== 6) throw invalid('Full Sangam is Pana*Pana e.g. 123*456');
        return `${m[1]}*${m[2]}`;
      }
      case 'MOTAR': {
        const digits = v.replace(/[^0-9]/g, '');
        if (!/^[0-9]{7}$/.test(digits)) throw invalid('Motor needs exactly 7 ank digits (e.g. 1234567)');
        return digits;
      }
      default:
        throw invalid(`Unsupported game type: ${code}`);
    }
  }

  /**
   * Atomic debit: the balance check and the decrement are ONE conditional
   * write, so concurrent bids can never both pass the check and overdraw.
   * Either the row matches (funds reserved) or nothing changes.
   */
  private async debitWallet(tx: any, userId: string, amountPaise: number): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    const res = await tx.user.updateMany({
      where: { id: userId, balance: { gte: amountPaise } },
      data: { balance: { decrement: amountPaise } },
    });
    if (res.count === 0) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_BALANCE',
        message: 'Your wallet balance is insufficient for this bid',
      });
    }
  }

  // -- idempotency ledger (DB-backed; cache interceptor stays as outer layer) ---

  private idemKeyOf(userId: string, key: string) {
    return { userId_key: { userId, key } };
  }

  /** Fast replay path: same (user, key) already completed -> stored response. */
  private async findReplay(userId: string, key: string): Promise<any | null> {
    try {
      const row = await (this.prisma as any).idempotencyKey.findUnique({
        where: this.idemKeyOf(userId, key),
      });
      if (row?.response) return JSON.parse(row.response);
      return null;
    } catch {
      return null; // table missing/unreachable -> degrade to no replay (still safe: window+balance hold)
    }
  }

  /** Claim the key inside the bid transaction; concurrent claimants lose (P2002).
   *  Missing-table errors (P2021/P2022) deliberately PROPAGATE so
   *  transactWithHeal can heal outside the tx and retry — catching them here
   *  would leave a poisoned (aborted) transaction behind (25P02 on every
   *  following statement). */
  private async claimIdemKey(tx: any, userId: string, key: string): Promise<void> {
    try {
      await tx.idempotencyKey.create({ data: { userId, key } });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        // Concurrent duplicate: surface to the race handler below.
        throw new ConflictException({ code: 'DUPLICATE_BID', message: 'Duplicate bid request' });
      }
      throw err;
    }
  }

  private async storeReplay(tx: any, userId: string, key: string, statusCode: number, body: unknown): Promise<void> {
    try {
      await tx.idempotencyKey.update({
        where: this.idemKeyOf(userId, key),
        data: { statusCode, response: JSON.stringify(body) },
      });
    } catch {
      // Best-effort: the bid itself already committed atomically above.
    }
  }

  /** After losing a claim race, return the winner's response (poll briefly). */
  private async requireReplay(userId: string, key: string): Promise<any> {
    for (let i = 0; i < 10; i++) {
      const replay = await this.findReplay(userId, key);
      if (replay) return replay;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new ConflictException({ code: 'DUPLICATE_BID', message: 'Duplicate bid request is being processed' });
  }

  private async ensureIdempotencyTable(): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "IdempotencyKey" (` +
          `"id" TEXT NOT NULL, "userId" TEXT NOT NULL, "key" TEXT NOT NULL, ` +
          `"statusCode" INTEGER, "response" TEXT, ` +
          `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ` +
          `CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id"))`,
      );
      await this.prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key")`,
      );
      await this.prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "IdempotencyKey_userId_idx" ON "IdempotencyKey"("userId")`,
      );
      this.logger.log('ensureIdempotencyTable: IdempotencyKey table ready');
    } catch (e) {
      this.logger.warn(`ensureIdempotencyTable skipped: ${(e as Error)?.message ?? e}`);
    }
  }

  // -- response -------------------------------------------------------------

  private marketSlice(market: { id: string; name: string; openTime: string; closeTime: string; timezone: string }) {
    const instants = marketWindowInstants(market.openTime, market.closeTime, { timezone: market.timezone });
    return {
      id: market.id,
      name: market.name,
      status: 'OPEN' as const,
      closesAt: instants.closesAt,
      serverTime: instants.serverTime,
    };
  }

  private serialize(bid: any) {
    return {
      id: bid.id,
      marketId: bid.marketId,
      gameType: bid.gameType,
      number: bid.number,
      amount: bid.amount / 100,
      rate: bid.rate,
      status: bid.status.toLowerCase(),
      round: bid.round,
      date: bid.date.toISOString(),
    };
  }
}
