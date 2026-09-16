import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChartsService } from './charts.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { MemoryCache } from '../../common/cache/memory-cache';
import { SourceAdapterRegistry } from './source/source-adapter';
import { SatmatWebAdapter } from './source/satmat-web.adapter';

describe('ChartsService', () => {
  let service: ChartsService;
  const satmatWebAdapter = { name: 'satmat-web', fetchRecords: jest.fn() };

  const marketRow = {
    id: 'diamond',
    name: 'DIAMOND',
    highlight: true,
    openTime: '01:30 PM',
    closeTime: '03:00 PM',
    order: 1,
  };

  const prisma = {
    resultMarket: { findUnique: jest.fn() },
    market: { findUnique: jest.fn() },
    resultRecord: {
      findMany: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };

  const mockCache = {
    set: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(undefined),
    has: jest.fn().mockResolvedValue(false),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChartsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: mockCache },
        { provide: MemoryCache, useValue: new MemoryCache() },
        SourceAdapterRegistry,
        { provide: SatmatWebAdapter, useValue: satmatWebAdapter },
        { provide: ConfigService, useValue: { get: () => 'satmat-web' } },
      ],
    }).compile();

    service = moduleRef.get(ChartsService);
  });

  describe('validation', () => {
    it('requires a market', async () => {
      await expect(
        service.getChart(undefined, '2026-08-01', '2026-08-14'),
      ).rejects.toMatchObject({ response: { code: 'MARKET_REQUIRED' } });
    });

    it('treats an unknown market as an empty result (graceful)', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(null);
      prisma.market.findUnique.mockResolvedValue(null);
      prisma.resultRecord.findMany.mockResolvedValue([]);
      const res = await service.getChart('nope', '2026-08-01', '2026-08-07');
      expect(res.count).toBe(0);
      expect(res.data).toEqual([]);
    });

    it('requires a startDate', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      await expect(
        service.getChart('diamond', undefined, '2026-08-14'),
      ).rejects.toMatchObject({ response: { code: 'START_DATE_REQUIRED' } });
    });

    it('requires an endDate', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      await expect(
        service.getChart('diamond', '2026-08-01', undefined),
      ).rejects.toMatchObject({ response: { code: 'END_DATE_REQUIRED' } });
    });

    it('rejects an invalid startDate format', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      await expect(
        service.getChart('diamond', '01/08/2026', '2026-08-14'),
      ).rejects.toMatchObject({ response: { code: 'INVALID_DATE' } });
    });

    it('rejects an impossible endDate', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      await expect(
        service.getChart('diamond', '2026-02-01', '2026-02-30'),
      ).rejects.toMatchObject({ response: { code: 'INVALID_DATE' } });
    });

    it('rejects startDate after endDate', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      await expect(
        service.getChart('diamond', '2026-08-14', '2026-08-01'),
      ).rejects.toMatchObject({ response: { code: 'INVALID_RANGE' } });
    });

    it('rejects ranges larger than ~10 years (full history fits)', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      await expect(
        service.getChart('diamond', '2010-01-01', '2026-12-31'),
      ).rejects.toMatchObject({ response: { code: 'RANGE_TOO_LARGE' } });
    });

    it('accepts multi-year ranges (full provider history in one request)', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      prisma.resultRecord.findMany.mockResolvedValue([]);
      const res = await service.getChart('diamond', '2019-01-01', '2020-12-31');
      expect(res.marketId).toBe('diamond');
      expect(res.count).toBe(0);
    });
  });

  describe('happy path', () => {
    it('returns cached records with honest missingDates', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      prisma.resultRecord.findMany.mockResolvedValue([
        { marketId: 'diamond', date: '2026-08-11', jodi: '45', panel: '123', open: '123', close: '789', source: 'satmat-web' },
        { marketId: 'diamond', date: '2026-08-14', jodi: '47', panel: '789', open: '789', close: '453', source: 'satmat-web' },
      ]);

      const res = await service.getChart('diamond', '2026-08-10', '2026-08-14');

      expect(res.market).toBe('DIAMOND');
      expect(res.data).toHaveLength(2);
      // Aug 10, 12, 13 are within range but have no record.
      expect(res.missingDates).toEqual(['2026-08-10', '2026-08-12', '2026-08-13']);
      expect(res.count).toBe(2);
      expect(prisma.resultRecord.upsert).not.toHaveBeenCalled();
    });

    it('does not hydrate from adapter on a DB miss (DB-only read)', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      prisma.resultRecord.findMany.mockResolvedValue([]);
      satmatWebAdapter.fetchRecords.mockResolvedValue([
        { marketId: 'diamond', date: '2026-08-14', jodi: '47', panel: '789', open: '789', close: '453', source: 'satmat-web' },
      ]);

      const res = await service.getChart('diamond', '2026-08-14', '2026-08-14');

      // The request handler must never block on a synchronous provider fetch —
      // population is owned by the background ScrapeScheduler.
      expect(satmatWebAdapter.fetchRecords).not.toHaveBeenCalled();
      expect(prisma.resultRecord.upsert).not.toHaveBeenCalled();
      expect(res.data).toEqual([]);
      expect(res.missingDates).toEqual(['2026-08-14']);
    });

    it('returns empty data with all dates missing outside the dataset', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      prisma.resultRecord.findMany.mockResolvedValue([]);

      const res = await service.getChart('diamond', '2027-01-01', '2027-01-07');

      expect(res.data).toEqual([]);
      expect(res.missingDates).toEqual([
        '2027-01-01',
        '2027-01-02',
        '2027-01-03',
        '2027-01-04',
        '2027-01-05',
        '2027-01-06',
        '2027-01-07',
      ]);
    });
  });

  describe('error types', () => {
    it('throws BadRequestException for validation failures', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(marketRow);
      const err = await service
        .getChart('diamond', '2026-08-14', '2026-08-01')
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
    });

    it('returns an empty 200 (graceful) for unknown markets', async () => {
      prisma.resultMarket.findUnique.mockResolvedValue(null);
      prisma.market.findUnique.mockResolvedValue(null);
      prisma.resultRecord.findMany.mockResolvedValue([]);
      const res = await service.getChart('nope', '2026-08-01', '2026-08-07');
      expect(res.count).toBe(0);
      expect(res.data).toEqual([]);
      expect(res.missingDates).toHaveLength(7);
    });
  });
});
