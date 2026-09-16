import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SatmatWebAdapter } from './satmat-web.adapter';
import { fetchHtml } from './scraper-http';
import { parsePanelChart } from './satmat-web.parser';

jest.mock('./scraper-http', () => ({ fetchHtml: jest.fn() }));
jest.mock('./satmat-web.parser', () => ({ parsePanelChart: jest.fn() }));

const fetchHtmlMock = fetchHtml as jest.Mock;
const parseMock = parsePanelChart as jest.Mock;

const day = (date: string, open: string) => ({
  date,
  jodi: '47',
  open,
  close: '460',
});

describe('SatmatWebAdapter fallback merge (backfill enrichment)', () => {
  let adapter: SatmatWebAdapter;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SatmatWebAdapter,
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    adapter = moduleRef.get(SatmatWebAdapter);

    // Primary (sattaindianmatka legacy for kalyan) vs fallback (VIP mirror).
    fetchHtmlMock.mockImplementation(async (url: string) =>
      url.includes('sattaindianmatka') ? 'PRIMARY_HTML' : 'FALLBACK_HTML',
    );
    parseMock.mockImplementation((html: string) =>
      html === 'PRIMARY_HTML'
        ? [day('2024-01-05', '128'), day('2024-01-06', '129')]
        : [day('2024-01-06', '999'), day('2024-01-04', '127')],
    );
  });

  it('fetches only the primary by default (rolling cycle cost unchanged)', async () => {
    const recs = await adapter.fetchRecords('kalyan', '2024-01-01', '2024-12-31');
    expect(recs).toHaveLength(2);
    expect(fetchHtmlMock).toHaveBeenCalledTimes(1);
  });

  it('merges fallback-only dates with primary winning overlaps', async () => {
    const recs = await adapter.fetchRecords('kalyan', '2024-01-01', '2024-12-31', {
      mergeFallback: true,
    });
    expect(recs.map((r) => r.date)).toEqual(['2024-01-04', '2024-01-05', '2024-01-06']);
    // Overlap keeps the PRIMARY row, never the mirror's.
    expect(recs.find((r) => r.date === '2024-01-06')).toMatchObject({ open: '129' });
    expect(fetchHtmlMock).toHaveBeenCalledTimes(2);
  });

  it('degrades to primary when the mirror is dead', async () => {
    fetchHtmlMock.mockImplementation(async (url: string) => {
      if (url.includes('sattaindianmatka')) return 'PRIMARY_HTML';
      throw new Error('mirror down');
    });
    const recs = await adapter.fetchRecords('kalyan', '2024-01-01', '2024-12-31', {
      mergeFallback: true,
    });
    expect(recs).toHaveLength(2);
  });
});
