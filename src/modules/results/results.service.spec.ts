import { Test } from '@nestjs/testing';
import { ResultsService } from './results.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';

describe('ResultsService', () => {
  let service: ResultsService;

  const prisma = {
    resultMarket: { findMany: jest.fn() },
    resultRecord: { findMany: jest.fn() },
  };

  const mockCache = {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ResultsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();

    service = moduleRef.get(ResultsService);
  });

  it('returns markets ordered, with the latest result per market', async () => {
    prisma.resultMarket.findMany.mockResolvedValue([
      { id: 'diamond', name: 'DIAMOND', highlight: true, openTime: '01:30 PM', closeTime: '03:00 PM', order: 1 },
      { id: 'prabhat', name: 'PRABHAT', highlight: true, openTime: '01:35 PM', closeTime: '03:05 PM', order: 2 },
    ]);
    prisma.resultRecord.findMany.mockResolvedValue([
      { marketId: 'diamond', date: '2026-08-14', jodi: '47', panel: '789', open: '789', close: '453', source: 'satmat-web' },
      { marketId: 'diamond', date: '2026-08-13', jodi: '12', panel: '345', open: '345', close: '678', source: 'satmat-web' },
      { marketId: 'prabhat', date: '2026-08-14', jodi: '11', panel: '560', open: '560', close: '992', source: 'satmat-web' },
    ]);

    const res = await service.getResults();

    expect(res.markets).toHaveLength(2);
    expect(res.markets[0].result).toEqual({
      jodi: '47',
      panel: '789',
      open: '789',
      close: '453',
      date: '2026-08-14',
      source: 'satmat-web',
    });
    // Diamond's earlier record must not win the "latest" slot.
    expect(res.markets[0].result?.date).toBe('2026-08-14');
    expect(res.markets[0].highlight).toBe(true);
  });

  it('returns null result for markets with no records yet', async () => {
    prisma.resultMarket.findMany.mockResolvedValue([
      { id: 'madhur-day', name: 'MADHUR DAY', highlight: false, openTime: '01:30 PM', closeTime: '02:30 PM', order: 4 },
    ]);
    prisma.resultRecord.findMany.mockResolvedValue([]);

    const res = await service.getResults();

    expect(res.markets[0].result).toBeNull();
  });
});
