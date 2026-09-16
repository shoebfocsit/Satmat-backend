import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Purging mock/sample data (source=sample-2026, MOCK_QR, mock@upi)…');

  const r1 = await prisma.resultRecord.deleteMany({ where: { source: { startsWith: 'sample' } } });
  console.log(`Deleted ${r1.count} ResultRecord sample rows`);

  // ChartRecord has no source column — keep existing rows; they will be upserted by real scraper.
  // To force full re-scrape, uncomment:
  // const r2 = await prisma.chartRecord.deleteMany({ where: {} });
  // console.log(`Cleared ${r2.count} ChartRecord rows`);
  console.log('ChartRecords kept (real scraper will upsert satmat-web rows)');

  // Reset Market.result placeholders that are still mock "***"
  const markets = await prisma.market.findMany();
  for (const m of markets) {
    if (m.result && (m.result === '***-**-***' || m.result.includes('***'))) {
      console.log(`Market ${m.id} result is still mock ${m.result} — leave for real declaration`);
    }
  }

  // Optionally purge mock deposit transactions (keep user balances intact)
  // const r3 = await prisma.walletTransaction.deleteMany({ where: { title: { contains: 'Welcome bonus' } } });

  console.log('Purge complete. Next: ensure SOURCE_ADAPTER=satmat-web SCRAPE_ENABLED=true and run scraper.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
