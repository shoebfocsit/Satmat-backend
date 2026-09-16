import { Test } from '@nestjs/testing';
import { BidsService } from './bids.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketStatusService } from '../markets/market-status.service';
import { ConflictException } from '@nestjs/common';

const marketOk = {
  id: 'diamond',
  name: 'DIAMOND',
  timezone: 'Asia/Kolkata',
  openTime: '10:00 AM',
  closeTime: '06:00 PM',
};

const errWith = (code: string, message = code) => {
  const e: any = new Error(message);
  e.response = { code, message };
  e.status = 403;
  return e;
};

describe('BidsService (server-authoritative window)', () => {
  let service: BidsService;

  const tx = {
    user: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    bid: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    walletTransaction: { create: jest.fn() },
    order: { create: jest.fn() },
    idempotencyKey: { create: jest.fn(), update: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: any) => cb(tx)),
    idempotencyKey: { findUnique: jest.fn() },
    $executeRawUnsafe: jest.fn().mockResolvedValue([]),
  };
  const marketStatus = {
    assertBiddable: jest.fn(),
    getStatusById: jest.fn(),
    isOpenDeclared: jest.fn(),
    ensureMarketColumns: jest.fn().mockResolvedValue(undefined),
  };

  const bidRow = (over: Record<string, unknown> = {}) => ({
    id: 'bid-1',
    userId: 'u1',
    marketId: 'diamond',
    gameType: 'JODI',
    gameTypeCode: 'JODI',
    number: '47',
    amount: 5000,
    rate: 950,
    status: 'PENDING',
    round: 'OPEN',
    date: new Date('2026-09-08T06:30:00Z'),
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    marketStatus.assertBiddable.mockResolvedValue({ ...marketOk });
    marketStatus.isOpenDeclared.mockResolvedValue(false);
    tx.user.findUnique.mockResolvedValue({ id: 'u1', balance: 100000 });
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.bid.create.mockImplementation(async (args: any) => bidRow(args.data));
    tx.walletTransaction.create.mockResolvedValue({});
    tx.order.create.mockResolvedValue({});
    tx.idempotencyKey.create.mockResolvedValue({});
    tx.idempotencyKey.update.mockResolvedValue({});

    const moduleRef = await Test.createTestingModule({
      providers: [
        BidsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MarketStatusService, useValue: marketStatus },
      ],
    }).compile();
    service = moduleRef.get(BidsService);
  });

  it('ACCEPTS a valid bid in an open market and debits atomically', async () => {
    const res: any = await service.placeBid('u1', {
      marketId: 'diamond',
      gameType: 'JODI',
      number: '47',
      amount: 5000,
    });
    expect(res.success).toBe(true);
    expect(res.bid).toMatchObject({ marketId: 'diamond', number: '47', amount: 50, status: 'pending' });
    expect(res.market).toMatchObject({ id: 'diamond', status: 'OPEN' });
    // Conditional debit: check + decrement in ONE write (no overdraft race).
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', balance: { gte: 5000 } },
      data: { balance: { decrement: 5000 } },
    });
    expect(tx.walletTransaction.create).toHaveBeenCalled();
    expect(tx.order.create).toHaveBeenCalled();
  });

  it('REJECTS before open (MARKET_NOT_OPEN) without touching the ledger', async () => {
    marketStatus.assertBiddable.mockRejectedValue(errWith('MARKET_NOT_OPEN'));
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 5000 }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_NOT_OPEN' } });
    expect(tx.bid.create).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('REJECTS a request that arrives exactly at close (in-tx race -> BID_WINDOW_EXPIRED)', async () => {
    // Pre-check passes, but the market closes before commit.
    marketStatus.assertBiddable
      .mockResolvedValueOnce({ ...marketOk })
      .mockRejectedValueOnce(errWith('BID_WINDOW_EXPIRED', 'window just closed'));
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 5000 }),
    ).rejects.toMatchObject({ response: { code: 'BID_WINDOW_EXPIRED' } });
    expect(tx.bid.create).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('REJECTS inactive / unknown markets', async () => {
    marketStatus.assertBiddable.mockRejectedValueOnce(errWith('MARKET_INACTIVE'));
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 5000 }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_INACTIVE' } });

    marketStatus.assertBiddable.mockRejectedValueOnce(errWith('MARKET_NOT_FOUND'));
    await expect(
      service.placeBid('u1', { marketId: 'nope', gameType: 'JODI', number: '47', amount: 5000 }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_NOT_FOUND' } });
    expect(tx.bid.create).not.toHaveBeenCalled();
  });

  it('REJECTS when funds are insufficient (no partial writes)', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 500000 }),
    ).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_BALANCE' } });
    expect(tx.bid.create).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('REJECTS unknown game types and malformed numbers (INVALID_BID)', async () => {
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'ROCKET', number: '47', amount: 5000 }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_BID' } });
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'JODI', number: '5', amount: 5000 }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_BID' } });
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'SP', number: '112', amount: 5000 }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_BID' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ACCEPTS sangam/motor formats the old regex wrongly rejected', async () => {
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'HF.S', number: '5*123', amount: 5000 }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'F.S', number: '123*456', amount: 5000 }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'MOTAR', number: '1234567', amount: 5000 }),
    ).resolves.toMatchObject({ success: true });
  });

  it('IGNORES client-supplied status/balance/ownership fields', async () => {
    const res: any = await service.placeBid('u1', {
      marketId: 'diamond',
      gameType: 'JODI',
      number: '47',
      amount: 5000,
      isMarketOpen: true,
      balance: 999999999,
      closeTime: '11:59 PM',
      userId: 'hacker',
    } as any);
    expect(res.success).toBe(true);
    // Ownership comes from the auth token (arg), never the body.
    expect(tx.bid.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'u1' }) }),
    );
    // Window re-checked server-side inside the tx.
    expect(marketStatus.assertBiddable).toHaveBeenCalledWith('diamond', expect.objectContaining({ tx }));
  });

  it('REPLAYS duplicate requests without a second debit (same Idempotency-Key)', async () => {
    const dto = { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 5000 };
    const first: any = await service.placeBid('u1', dto, 'key-1');
    expect(first.success).toBe(true);
    expect(tx.bid.create).toHaveBeenCalledTimes(1);

    // Retry arrives: ledger already holds the completed response.
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      userId: 'u1',
      key: 'key-1',
      statusCode: 201,
      response: JSON.stringify(first),
    });
    const second: any = await service.placeBid('u1', dto, 'key-1');
    expect(second).toEqual(first);
    expect(tx.bid.create).toHaveBeenCalledTimes(1); // no second bid, no second debit
  });

  it('SERIALIZES concurrent duplicates on the ledger (one bid total)', async () => {
    // In-memory ledger: second concurrent claim loses with P2002, then replays.
    const ledger = new Map<string, any>();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
    tx.idempotencyKey.create.mockImplementation(async ({ data }: any) => {
      const k = `${data.userId}:${data.key}`;
      if (ledger.has(k)) {
        const e: any = new Error('Unique constraint');
        e.code = 'P2002';
        throw e;
      }
      ledger.set(k, { ...data, response: null });
      return data;
    });
    tx.idempotencyKey.update.mockImplementation(async ({ where, data }: any) => {
      const k = `${where.userId_key.userId}:${where.userId_key.key}`;
      ledger.set(k, { ...ledger.get(k), ...data });
      return ledger.get(k);
    });
    prisma.idempotencyKey.findUnique.mockImplementation(async ({ where }: any) => {
      const k = `${where.userId_key.userId}:${where.userId_key.key}`;
      return ledger.get(k) ?? null;
    });

    const dto = { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 5000 };
    const [a, b]: any[] = await Promise.all([
      service.placeBid('u1', dto, 'race-key'),
      service.placeBid('u1', dto, 'race-key'),
    ]);
    expect(a.bid.id).toBe(b.bid.id);
    expect(tx.bid.create).toHaveBeenCalledTimes(1);
  });

  it('ACCEPTS bulk bids with the CLOSE round and caps batch size', async () => {
    const res: any = await service.placeBulkBid(
      'u1',
      {
        marketId: 'diamond',
        gameType: 'ANK',
        round: 'CLOSE',
        items: [
          { number: '5', amount: 2000 },
          { number: '7', amount: 3000 },
        ],
      },
      'bulk-1',
    );
    expect(res.success).toBe(true);
    expect(res.bids).toHaveLength(2);
    expect(res.totalAmount).toBe(50);
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', balance: { gte: 5000 } },
      data: { balance: { decrement: 5000 } },
    });

    const tooMany = Array.from({ length: 51 }, (_, i) => ({ number: `${i % 10}`, amount: 1000 }));
    await expect(
      service.placeBulkBid('u1', { marketId: 'diamond', gameType: 'ANK', round: 'OPEN', items: tooMany }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_BID' } });
  });

  it('BLOCKS cancellation after close (MARKET_CLOSED)', async () => {
    tx.bid.findFirst.mockResolvedValue(bidRow({ id: 'bid-1', round: 'OPEN', status: 'PENDING' }));
    marketStatus.assertBiddable.mockRejectedValue(errWith('MARKET_CLOSED'));
    await expect(service.cancelBid('u1', 'bid-1', 'cancel-2')).rejects.toMatchObject({
      response: { code: 'MARKET_CLOSED' },
    });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('CANCELS a pending bid with a single atomic refund', async () => {
    tx.bid.findFirst.mockResolvedValue(bidRow({ id: 'bid-1', round: 'OPEN', status: 'PENDING', amount: 5000 }));
    tx.bid.updateMany.mockResolvedValue({ count: 1 });
    tx.bid.findUnique.mockResolvedValue(bidRow({ id: 'bid-1', status: 'CANCELLED' }));
    const res: any = await service.cancelBid('u1', 'bid-1', 'cancel-1');
    expect(res.success).toBe(true);
    expect(res.bid.status).toBe('cancelled');
    // Conditional PENDING claim: exactly one canceller can win.
    expect(tx.bid.updateMany).toHaveBeenCalledWith({
      where: { id: 'bid-1', userId: 'u1', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { balance: { increment: 5000 } },
    });
  });

  it('BLOCKS cancelling an OPEN-leg bid after the open is declared', async () => {
    tx.bid.findFirst.mockResolvedValue(bidRow({ id: 'bid-1', round: 'OPEN', status: 'PENDING' }));
    marketStatus.isOpenDeclared.mockResolvedValue(true);
    await expect(service.cancelBid('u1', 'bid-1', 'cancel-3')).rejects.toMatchObject({
      response: { code: 'BID_NOT_CANCELLABLE' },
    });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('REFUNDS exactly once when two cancels race (ledger + PENDING claim)', async () => {
    const ledger = new Map<string, any>();
    tx.idempotencyKey.create.mockImplementation(async ({ data }: any) => {
      const k = `${data.userId}:${data.key}`;
      if (ledger.has(k)) {
        const e: any = new Error('Unique constraint');
        e.code = 'P2002';
        throw e;
      }
      ledger.set(k, { ...data, response: null });
      return data;
    });
    tx.idempotencyKey.update.mockImplementation(async ({ where, data }: any) => {
      const k = `${where.userId_key.userId}:${where.userId_key.key}`;
      ledger.set(k, { ...ledger.get(k), ...data });
      return ledger.get(k);
    });
    prisma.idempotencyKey.findUnique.mockImplementation(async ({ where }: any) => {
      const k = `${where.userId_key.userId}:${where.userId_key.key}`;
      return ledger.get(k) ?? null;
    });
    tx.bid.findFirst.mockResolvedValue(bidRow({ id: 'bid-1', round: 'CLOSE', status: 'PENDING', amount: 5000 }));
    tx.bid.updateMany.mockResolvedValue({ count: 1 });
    tx.bid.findUnique.mockResolvedValue(bidRow({ id: 'bid-1', status: 'CANCELLED' }));

    const [a, b]: any[] = await Promise.all([
      service.cancelBid('u1', 'bid-1', 'cancel-race'),
      service.cancelBid('u1', 'bid-1', 'cancel-race'),
    ]);
    expect(a).toEqual(b);
    expect(a.success).toBe(true);
    expect(tx.user.update).toHaveBeenCalledTimes(1); // single refund
  });

  it('REJECTS a lost cancel race without refunding', async () => {
    tx.bid.findFirst.mockResolvedValue(bidRow({ id: 'bid-1', round: 'CLOSE', status: 'PENDING' }));
    tx.bid.updateMany.mockResolvedValue({ count: 0 }); // someone else claimed it
    await expect(service.cancelBid('u1', 'bid-1', 'cancel-4')).rejects.toMatchObject({
      response: { code: 'BID_NOT_CANCELLABLE' },
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('FORWARDS the leg to the window gate and honours LEG_CLOSED', async () => {
    const dto = { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 5000 };
    await service.placeBid('u1', dto, 'leg-1');
    expect(marketStatus.assertBiddable).toHaveBeenCalledWith(
      'diamond',
      expect.objectContaining({ round: 'OPEN' }),
    );
    await service.placeBulkBid(
      'u1',
      { marketId: 'diamond', gameType: 'ANK', round: 'CLOSE', items: [{ number: '5', amount: 2000 }] },
      'leg-2',
    );
    expect(marketStatus.assertBiddable).toHaveBeenCalledWith(
      'diamond',
      expect.objectContaining({ round: 'CLOSE' }),
    );

    // Open declared mid-session: OPEN-leg dies, CLOSE-leg lives (server-side).
    marketStatus.assertBiddable.mockRejectedValue(errWith('LEG_CLOSED'));
    await expect(service.placeBid('u1', dto, 'leg-3')).rejects.toMatchObject({
      response: { code: 'LEG_CLOSED' },
    });
    expect(tx.bid.create).toHaveBeenCalledTimes(2); // no third bid
  });

  it('rethrows non-conflict transaction errors (no silent replay)', async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(new ConflictException('boom'));
    // No idem key -> ConflictException propagates untouched.
    await expect(
      service.placeBid('u1', { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 5000 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('HEALS a missing ledger table mid-tx and retries once (no 25P02 to client)', async () => {
    // Prod DB without the IdempotencyKey table: the claim blows up with
    // P2021 inside the tx. The tx rolls back, tables heal outside any tx,
    // and exactly one retry completes the bid.
    const p2021: any = new Error('table "IdempotencyKey" does not exist');
    p2021.code = 'P2021';
    tx.idempotencyKey.create.mockRejectedValueOnce(p2021);
    const dto = { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 5000 };
    const res: any = await service.placeBid('u1', dto, 'heal-1');
    expect(res.success).toBe(true);
    expect(res.bid).toMatchObject({ marketId: 'diamond', number: '47' });
    // Rolled-back attempt created nothing; the retry created exactly one bid.
    expect(tx.bid.create).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
  });

  it('retries once when the tx reports 25P02, then surfaces real errors', async () => {
    const aborted: any = new Error('current transaction is aborted');
    aborted.code = '25P02';
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(aborted);
    const dto = { marketId: 'diamond', gameType: 'JODI', number: '47', amount: 5000 };
    const res: any = await service.placeBid('u1', dto, 'heal-2');
    expect(res.success).toBe(true);

    // A second consecutive failure is NOT retried again — it propagates.
    (prisma.$transaction as jest.Mock)
      .mockRejectedValueOnce(aborted)
      .mockRejectedValueOnce(new Error('still down'));
    await expect(service.placeBid('u1', dto, 'heal-3')).rejects.toThrow('still down');
  });
});
