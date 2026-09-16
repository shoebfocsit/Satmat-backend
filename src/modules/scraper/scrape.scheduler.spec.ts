import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ScrapeScheduler } from './scrape.scheduler';
import { PrismaService } from '../../prisma/prisma.service';
import { SatmatWebAdapter } from '../charts/source/satmat-web.adapter';

describe('ScrapeScheduler', () => {
  let scheduler: ScrapeScheduler;

  const record = {
    marketId: 'kalyan',
    date: '2026-08-14',
    jodi: '60',
    panel: '114',
    open: '114',
    close: '460',
    source: 'satmat-web',
  };

  const prisma = {
    market: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    resultMarket: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    resultRecord: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    chartRecord: {
      upsert: jest.fn(),
    },
  };

  const adapter = {
    marketIds: jest.fn(),
    fetchRecords: jest.fn(),
    fetchLiveSnapshot: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ScrapeScheduler,
        { provide: PrismaService, useValue: prisma },
        { provide: SatmatWebAdapter, useValue: adapter },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'SCRAPE_ENABLED' ? 'false' : undefined) },
        },
      ],
    }).compile();

    scheduler = moduleRef.get(ScrapeScheduler);
  });

  it('is disabled by default', async () => {
    await scheduler.onModuleInit();
    expect(scheduler.status.enabled).toBe(false);
  });

  it('persists fetched records into ResultRecord and ChartRecord', async () => {
    adapter.marketIds.mockReturnValue(['kalyan']);
    adapter.fetchRecords.mockResolvedValue([record]);
    prisma.market.findUnique.mockResolvedValue({
      id: 'kalyan',
      name: 'KALYAN',
      result: '***-**-***',
      openTime: '04:30 PM',
      closeTime: '06:30 PM',
      isLive: false,
      isClosed: false,
      order: 6,
    });
    prisma.resultMarket.findUnique.mockResolvedValue({
      id: 'kalyan',
      name: 'KALYAN',
      highlight: false,
      openTime: '04:30 PM',
      closeTime: '06:30 PM',
      result: '***-**-***',
      order: 6,
    });
    prisma.chartRecord.upsert.mockResolvedValue({});

    const status = await scheduler.runCycle();

    expect(status.lastError).toBeNull();
    expect(status.runsCompleted).toBe(1);
    expect(status.lastResult).toEqual([
      {
        marketId: 'kalyan',
        records: 1,
        resultRecord: 1,
        chartRecord: 1,
        latestResult: '114-60-460',
      },
    ]);
    expect(prisma.resultRecord.upsert).toHaveBeenCalledWith({
      where: { marketId_date: { marketId: 'kalyan', date: '2026-08-14' } },
      update: {
        jodi: '60',
        panel: '114',
        open: '114',
        close: '460',
        source: 'satmat-web',
      },
      create: {
        marketId: 'kalyan',
        date: '2026-08-14',
        jodi: '60',
        panel: '114',
        open: '114',
        close: '460',
        source: 'satmat-web',
      },
    });
    expect(prisma.market.update).toHaveBeenCalledWith({
      where: { id: 'kalyan' },
      data: { result: '114-60-460' },
    });
  });

  it('skips persistence when the provider returns nothing', async () => {
    adapter.marketIds.mockReturnValue(['kalyan']);
    adapter.fetchRecords.mockResolvedValue([]);

    const status = await scheduler.runCycle();

    expect(status.lastError).toBeNull();
    expect(status.lastResult[0]).toEqual({
      marketId: 'kalyan',
      records: 0,
      resultRecord: 0,
      chartRecord: 0,
      latestResult: null,
    });
    expect(prisma.resultRecord.upsert).not.toHaveBeenCalled();
  });

  it('heals exact-duplicate full rows, keeping the earliest date', async () => {
    adapter.marketIds.mockReturnValue(['kalyan']);
    adapter.fetchRecords.mockResolvedValue([]);
    (prisma.resultRecord.findMany as jest.Mock).mockResolvedValue([
      { id: 'old', marketId: 'kalyan', date: '2026-09-04', open: '336', jodi: '21', close: '245' },
      { id: 'new', marketId: 'kalyan', date: '2026-09-07', open: '336', jodi: '21', close: '245' },
      // Partial rows are never healed.
      { id: 'part', marketId: 'kalyan', date: '2026-09-07', open: '139', jodi: null, close: null },
    ]);

    await scheduler.runCycle();

    expect(prisma.resultRecord.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['new'] } } });
  });

  it('records a failure instead of throwing', async () => {
    adapter.marketIds.mockReturnValue(['kalyan']);
    adapter.fetchRecords.mockRejectedValue(new Error('provider down'));

    const status = await scheduler.runCycle();

    expect(status.lastError).toContain('provider down');
    expect(status.runsCompleted).toBe(0);
  });

  it('applies the homepage live snapshot before the panel cycle', async () => {
    adapter.marketIds.mockReturnValue(['kalyan']);
    adapter.fetchLiveSnapshot.mockResolvedValue([
      { marketId: 'kalyan', open: '150', jodi: null, close: null },
    ]);
    (prisma.market.findMany as jest.Mock).mockResolvedValue([
      { id: 'kalyan', openTime: '12:00 AM', closeTime: '11:59 PM' },
    ]);
    // Recompute reads back the stored snapshot row for the display string.
    (prisma.resultRecord.findMany as jest.Mock).mockResolvedValue([
      { id: 'rr1', marketId: 'kalyan', date: '2026-09-07', open: '150', jodi: null, close: null },
    ]);
    adapter.fetchRecords.mockResolvedValue([]);
    prisma.market.findUnique.mockResolvedValue({
      id: 'kalyan',
      name: 'KALYAN',
      result: '***-**-***',
      openTime: '04:30 PM',
      closeTime: '06:30 PM',
      isLive: false,
      isClosed: false,
      order: 6,
    });

    const status = await scheduler.runCycle();

    expect(status.liveSnapshot).toEqual(
      expect.objectContaining({ count: 1 }),
    );
    // Partial live row stored (open only), market result reflects OPEN declare.
    expect(prisma.resultRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          marketId: 'kalyan',
          open: '150',
          jodi: null,
          close: null,
          source: 'vip-live',
        }),
      }),
    );
    expect(prisma.market.update).toHaveBeenCalledWith({
      where: { id: 'kalyan' },
      data: { result: '150-**-***' },
    });
  });

  describe('backfillHistory (full provider history)', () => {
    const marketRow = (id: string) => ({
      id,
      name: id.toUpperCase(),
      result: '***-**-***',
      openTime: '10:00 AM',
      closeTime: '06:00 PM',
      isLive: false,
      isClosed: false,
      order: 1,
    });

    beforeEach(() => {
      (scheduler as any).enabled = true;
      adapter.marketIds.mockReturnValue(['kalyan', 'milan-day']);
      adapter.fetchRecords.mockResolvedValue([record]);
      prisma.market.findUnique.mockImplementation(async ({ where }: any) => marketRow(where.id));
      prisma.resultMarket.findUnique.mockImplementation(async ({ where }: any) => ({
        ...marketRow(where.id),
        highlight: false,
      }));
      prisma.chartRecord.upsert.mockResolvedValue({});
    });

    it('fills only shallow markets, skipping ones that already hold deep history', async () => {
      prisma.resultRecord.findFirst
        .mockResolvedValueOnce({ date: '2019-07-15' }) // kalyan: deep -> skip
        .mockResolvedValueOnce({ date: '2026-09-01' }); // milan-day: shallow -> fill
      const res = await scheduler.backfillHistory();
      expect(res.markets).toBe(1);
      expect(res.records).toBe(1);
      expect(adapter.fetchRecords).toHaveBeenCalledTimes(1);
      expect(adapter.fetchRecords).toHaveBeenCalledWith(
        'milan-day',
        '2019-01-01',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        { mergeFallback: true },
      );
      expect(scheduler.status.lastBackfill).toMatchObject({ markets: 1, records: 1 });
    });

    it('force refills every market without checking oldest dates', async () => {
      const res = await scheduler.backfillHistory(true);
      expect(res.markets).toBe(2);
      expect(prisma.resultRecord.findFirst).not.toHaveBeenCalled();
      expect(scheduler.status.lastBackfill).toMatchObject({ markets: 2 });
    });

    it('does nothing when disabled', async () => {
      (scheduler as any).enabled = false;
      const res = await scheduler.backfillHistory(true);
      expect(res).toEqual({ markets: 0, records: 0 });
      expect(adapter.fetchRecords).not.toHaveBeenCalled();
    });
  });

  describe('syncMarketSchedules (site table is the only source of truth)', () => {
    beforeEach(() => {
      (adapter as any).fetchMarketSchedule = jest.fn().mockResolvedValue([
        { marketId: 'milan-day', openTime: '3:00 PM', closeTime: '5:00 PM' },
        { marketId: 'kalyan', openTime: '03:10 PM', closeTime: '05:10 PM' },
        { marketId: 'day-bombay', openTime: '12:00 PM', closeTime: '2:00 PM' },
        { marketId: 'milan-night', openTime: 'nope', closeTime: '11:00 PM' },
      ]);
    });

    it('updates stale Market + ResultMarket timings to site-exact values', async () => {
      prisma.market.findUnique.mockImplementation(async ({ where }: any) =>
        ['milan-day', 'kalyan'].includes(where.id)
          ? { id: where.id, openTime: '03:10 PM', closeTime: '05:10 PM' }
          : null,
      );
      prisma.resultMarket.findUnique.mockImplementation(async ({ where }: any) =>
        where.id === 'milan-day'
          ? { id: 'milan-day', openTime: '03:10 PM', closeTime: '05:10 PM' }
          : null,
      );
      const updated = await scheduler.syncMarketSchedules();
      // Canonicalized (3:00 PM -> 03:00 PM), both tables, unknown/invalid skipped.
      expect(prisma.market.update).toHaveBeenCalledWith({
        where: { id: 'milan-day' },
        data: { openTime: '03:00 PM', closeTime: '05:00 PM' },
      });
      expect(prisma.resultMarket.update).toHaveBeenCalledWith({
        where: { id: 'milan-day' },
        data: { openTime: '03:00 PM', closeTime: '05:00 PM' },
      });
      expect(updated).toContain('milan-day(market)');
      expect(updated).toContain('milan-day(results)');
      expect(updated.find((u) => u.startsWith('day-bombay'))).toBeUndefined();
      expect(updated.find((u) => u.startsWith('milan-night'))).toBeUndefined();
      expect(scheduler.status.lastScheduleSync).toMatchObject({ updated });
    });

    it('is a no-op when timings already match (no write spam)', async () => {
      prisma.market.findUnique.mockResolvedValue({ id: 'kalyan', openTime: '03:10 PM', closeTime: '05:10 PM' });
      prisma.resultMarket.findUnique.mockResolvedValue(null);
      (adapter as any).fetchMarketSchedule.mockResolvedValue([
        { marketId: 'kalyan', openTime: '03:10 PM', closeTime: '05:10 PM' },
      ]);
      expect(await scheduler.syncMarketSchedules()).toEqual([]);
      expect(prisma.market.update).not.toHaveBeenCalled();
    });

    it('never throws when the schedule fetch dies', async () => {
      (adapter as any).fetchMarketSchedule.mockRejectedValue(new Error('blocked'));
      await expect(scheduler.syncMarketSchedules()).resolves.toEqual([]);
    });
  });
});
