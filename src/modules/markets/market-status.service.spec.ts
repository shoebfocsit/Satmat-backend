import { Test } from '@nestjs/testing';
import { MarketStatusService } from './market-status.service';
import { PrismaService } from '../../prisma/prisma.service';

// Absolute instants (IST = UTC+5:30) so tests hold in any server TZ.
const atIST = (h: number, m: number, day = 8) =>
  new Date(Date.UTC(2026, 8, day, h - 5, m - 30));

const market = (over: Record<string, unknown> = {}) => ({
  id: 'diamond',
  name: 'DIAMOND',
  openTime: '10:00 AM',
  closeTime: '06:00 PM',
  timezone: 'Asia/Kolkata',
  isActive: true,
  ...over,
});

describe('MarketStatusService', () => {
  let service: MarketStatusService;

  const prisma = {
    market: { findUnique: jest.fn(), findMany: jest.fn() },
    resultRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    $executeRawUnsafe: jest.fn().mockResolvedValue([]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.resultRecord.findUnique.mockResolvedValue(null);
    const moduleRef = await Test.createTestingModule({
      providers: [
        MarketStatusService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(MarketStatusService);
  });

  const codeOf = (err: any) => err?.response?.code;

  it('rejects unknown markets (MARKET_NOT_FOUND)', async () => {
    prisma.market.findUnique.mockResolvedValue(null);
    await expect(service.assertBiddable('nope')).rejects.toMatchObject({});
    try {
      await service.assertBiddable('nope');
      fail('should throw');
    } catch (e) {
      expect(codeOf(e)).toBe('MARKET_NOT_FOUND');
    }
  });

  it('rejects inactive markets (MARKET_INACTIVE)', async () => {
    prisma.market.findUnique.mockResolvedValue(market({ isActive: false }));
    try {
      await service.assertBiddable('diamond');
      fail('should throw');
    } catch (e) {
      expect(codeOf(e)).toBe('MARKET_INACTIVE');
    }
  });

  it('rejects before open (MARKET_NOT_OPEN)', async () => {
    prisma.market.findUnique.mockResolvedValue(market());
    jest.spyOn(Date as any, 'now').mockReturnValue(0);
    try {
      await service.assertBiddable('diamond', { now: atIST(9, 59) });
      fail('should throw');
    } catch (e) {
      expect(codeOf(e)).toBe('MARKET_NOT_OPEN');
    }
  });

  it('accepts exactly at open and during the window', async () => {
    prisma.market.findUnique.mockResolvedValue(market());
    await expect(
      service.assertBiddable('diamond', { now: atIST(10, 0) }),
    ).resolves.toMatchObject({ id: 'diamond' });
    await expect(
      service.assertBiddable('diamond', { now: atIST(17, 59) }),
    ).resolves.toMatchObject({ id: 'diamond' });
  });

  it('rejects at close (MARKET_CLOSED) and uses BID_WINDOW_EXPIRED for in-tx races', async () => {
    prisma.market.findUnique.mockResolvedValue(market());
    try {
      await service.assertBiddable('diamond', { now: atIST(18, 0) });
      fail('should throw');
    } catch (e) {
      expect(codeOf(e)).toBe('MARKET_CLOSED');
    }
    try {
      await service.assertBiddable('diamond', { now: atIST(18, 0, 8), race: true });
      fail('should throw');
    } catch (e) {
      expect(codeOf(e)).toBe('BID_WINDOW_EXPIRED');
    }
  });

  it('rejects when a full result is declared (RESULT_DECLARED path)', async () => {
    prisma.market.findUnique.mockResolvedValue(market());
    prisma.resultRecord.findUnique.mockResolvedValue({
      marketId: 'diamond',
      date: '2026-09-08',
      open: '128',
      jodi: '47',
      close: '460',
    });
    // Mid-window but fully declared -> closed.
    try {
      await service.assertBiddable('diamond', { now: atIST(12, 0) });
      fail('should throw');
    } catch (e) {
      expect(codeOf(e)).toBe('MARKET_CLOSED');
    }
    const status = await service.getStatusById('diamond', atIST(12, 0));
    expect(status.status).toBe('RESULT_DECLARED');
    expect(status.canBid).toBe(false);
  });

  it('keeps an open-only partial biddable (close leg still open)', async () => {
    prisma.market.findUnique.mockResolvedValue(market());
    prisma.resultRecord.findUnique.mockResolvedValue({
      marketId: 'diamond',
      date: '2026-09-08',
      open: '128',
      jodi: null,
      close: null,
    });
    await expect(
      service.assertBiddable('diamond', { now: atIST(12, 0) }),
    ).resolves.toMatchObject({ id: 'diamond' });
  });

  it('exposes a countdown-ready status payload', async () => {
    prisma.market.findUnique.mockResolvedValue(market());
    const s = await service.getStatusById('diamond', atIST(12, 0));
    expect(s).toMatchObject({
      marketId: 'diamond',
      status: 'OPEN',
      canBid: true,
      timezone: 'Asia/Kolkata',
    });
    expect(typeof s.serverTime).toBe('string');
    expect(new Date(s.closesAt as string).getTime()).toBeGreaterThan(
      new Date(s.serverTime).getTime(),
    );
  });

  it('handles overnight markets', async () => {
    prisma.market.findUnique.mockResolvedValue(
      market({ id: 'main-bazar', openTime: '10:00 PM', closeTime: '02:00 AM' }),
    );
    await expect(
      service.assertBiddable('main-bazar', { now: atIST(23, 0) }),
    ).resolves.toMatchObject({ id: 'main-bazar' });
    try {
      await service.assertBiddable('main-bazar', { now: atIST(21, 59) });
      fail('should throw');
    } catch (e) {
      expect(codeOf(e)).toBe('MARKET_NOT_OPEN');
    }
  });

  it('closes the OPEN leg once open is declared (LEG_CLOSED); CLOSE stays open', async () => {
    prisma.market.findUnique.mockResolvedValue(market());
    prisma.resultRecord.findUnique.mockResolvedValue({
      marketId: 'diamond',
      date: '2026-09-08',
      open: '128',
      jodi: null,
      close: null,
    });
    try {
      await service.assertBiddable('diamond', { now: atIST(12, 0), round: 'OPEN' });
      fail('should throw');
    } catch (e) {
      expect(codeOf(e)).toBe('LEG_CLOSED');
    }
    await expect(
      service.assertBiddable('diamond', { now: atIST(12, 0), round: 'CLOSE' }),
    ).resolves.toMatchObject({ id: 'diamond' });
    expect(await service.isOpenDeclared('diamond')).toBe(true);
  });

  it('exposes per-leg declare flags in the status payload', async () => {
    prisma.market.findUnique.mockResolvedValue(market());
    prisma.resultRecord.findUnique.mockResolvedValue({
      marketId: 'diamond',
      date: '2026-09-08',
      open: '128',
      jodi: null,
      close: null,
    });
    const s = await service.getStatusById('diamond', atIST(12, 0));
    expect(s.status).toBe('OPEN');
    expect(s.canBid).toBe(true);
    expect(s.openDeclared).toBe(true);
    expect(s.closeDeclared).toBe(false);
  });

  it('serves legacy rows with safe defaults when the migration is missing (P2022)', async () => {
    const p2022: any = new Error('The column `Market.timezone` does not exist');
    p2022.code = 'P2022';
    prisma.market.findMany.mockRejectedValueOnce(p2022);
    prisma.$queryRawUnsafe.mockResolvedValue([
      { id: 'diamond', name: 'DIAMOND', result: null, openTime: '10:00 AM', closeTime: '06:00 PM', order: 1 },
    ]);
    const rows = await service.listMarketRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'diamond', timezone: 'Asia/Kolkata', isActive: true });
    // Self-heal DDL ran so the next deploy/query is native.
    expect(prisma.$executeRawUnsafe).toHaveBeenCalled();

    prisma.market.findUnique.mockRejectedValueOnce(p2022);
    prisma.$queryRawUnsafe.mockResolvedValueOnce([
      { id: 'diamond', name: 'DIAMOND', result: null, openTime: '10:00 AM', closeTime: '06:00 PM', order: 1 },
    ]);
    const one = await service.getMarketRow('diamond');
    expect(one).toMatchObject({ id: 'diamond', isActive: true });

    prisma.market.findUnique.mockRejectedValueOnce(p2022);
    prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(service.getMarketRow('nope')).resolves.toBeNull();
  });

  it('rethrows non-P2022 market read errors', async () => {
    prisma.market.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(service.listMarketRows()).rejects.toThrow('db down');
  });
});
