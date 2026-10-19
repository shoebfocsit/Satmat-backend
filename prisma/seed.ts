import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const MARKETS = [
  // ‼️DAY GAME'S TIMING‼️ — exactly as requested, order = display order on Home
  { id: 'sridevi', name: 'SRIDEVI DAY', openTime: '11:30 AM', closeTime: '12:30 PM', order: 1 },
  { id: 'time-bazar-day', name: 'TIME BAZAR', openTime: '01:00 PM', closeTime: '02:00 PM', order: 2 },
  { id: 'madhur-day', name: 'MADHUR DAY', openTime: '01:30 PM', closeTime: '02:30 PM', order: 3 },
  { id: 'rajdhani-day', name: 'RAJDHANI DAY', openTime: '03:15 PM', closeTime: '05:15 PM', order: 4 },
  { id: 'milan-day', name: 'MILAN DAY', openTime: '03:00 PM', closeTime: '05:00 PM', order: 5 },
  { id: 'supreme-day', name: 'SUPREME DAY', openTime: '03:30 PM', closeTime: '05:30 PM', order: 6 },
  { id: 'kalyan', name: 'KALYAN', openTime: '03:45 PM', closeTime: '05:45 PM', order: 7 },
  // ‼️NIGHT GAME'S TIMING‼️
  { id: 'sridevi-night', name: 'SRIDEVI NIGHT', openTime: '07:15 PM', closeTime: '08:15 PM', order: 8 },
  { id: 'madhur-night', name: 'MADHUR NIGHT', openTime: '08:30 PM', closeTime: '10:30 PM', order: 9 },
  { id: 'supreme-night', name: 'SUPREME NIGHT', openTime: '08:30 PM', closeTime: '10:30 PM', order: 10 },
  { id: 'milan-night', name: 'MILAN NIGHT', openTime: '09:00 PM', closeTime: '11:00 PM', order: 11 },
  { id: 'rajdhani-night', name: 'RAJDHANI NIGHT', openTime: '09:30 PM', closeTime: '11:45 PM', order: 12 },
  { id: 'kalyan-night', name: 'KALYAN NIGHT', openTime: '09:40 PM', closeTime: '11:40 PM', order: 13 },
  { id: 'main-bazar', name: 'MAIN BAZAR', openTime: '09:35 PM', closeTime: '12:05 AM', order: 14 },
];

const GAME_RATES = [
  { id: 'gr1', gameType: 'ANK (Single Digit)', rateRange: '10₹ = 95₹', order: 1 },
  { id: 'gr2', gameType: 'JODI', rateRange: '10₹ = 950₹', order: 2 },
  { id: 'gr3', gameType: 'Single Pana (SP)', rateRange: '10₹ = 1500₹', order: 3 },
  { id: 'gr4', gameType: 'Double Pana (DP)', rateRange: '10₹ = 3000₹', order: 4 },
  { id: 'gr5', gameType: 'Triple Pana (TP)', rateRange: '10₹ = 5000₹', order: 5 },
  { id: 'gr6', gameType: 'Cycle Pana (CP)', rateRange: '10₹ = 1500₹/3000₹', order: 6 },
  { id: 'gr7', gameType: 'Half Sangam (HF.S)', rateRange: '10₹ = 10000₹', order: 7 },
  { id: 'gr8', gameType: 'Full Sangam (F.S)', rateRange: '10₹ = 100000₹', order: 8 },
  { id: 'gr9', gameType: 'Motor (7 Ank Allowed)', rateRange: '15/30', order: 9 },
];

// 9 live games exactly as per requested rates — ANK, JODI, SP, DP, TP, CP, HF.S, F.S, MOTOR.
// Titles match GAME_RATES display (ANK/JODI/SP…) and live market algorithm.
// iconName maps to renderGameIcon in MarketSelectionView.
const GAME_TYPES = [
  { key: 'single-digit', title: 'ANK', iconName: '1', code: 'ANK', isOpen: true, order: 1 },
  { key: 'jodi', title: 'JODI', iconName: '2', code: 'JODI', isOpen: true, order: 2 },
  { key: 'single-panna', title: 'SP', iconName: 'panna_1', code: 'SP', isOpen: true, order: 3 },
  { key: 'double-panna', title: 'DP', iconName: 'panna_2', code: 'DP', isOpen: true, order: 4 },
  { key: 'triple-panna', title: 'TP', iconName: 'panna_3', code: 'TP', isOpen: true, order: 5 },
  { key: 'cycle-pana', title: 'CP', iconName: 'panna_1', code: 'CP', isOpen: true, order: 6 },
  { key: 'half-sangam', title: 'HF.S', iconName: 'half_s', code: 'HF', isOpen: true, order: 7 },
  { key: 'full-sangam', title: 'F.S', iconName: 'full_s', code: 'FS', isOpen: true, order: 8 },
  { key: 'motor', title: 'MOTAR', iconName: 'motor', code: 'MOTAR', isOpen: true, order: 9 },
];

const NOTICES = [
  { id: 'notice-new-year', title: 'New Year Special Bonus', content: 'Get 20% extra on your first deposit this month! Limited time offer.', isImportant: true },
  { id: 'notice-market-timing', title: 'Market Timing Update', content: 'Mumbai Morning market timing has been changed. New opening time: 10:00 AM.', isImportant: true },
  { id: 'notice-app-update', title: 'App Update Available', content: 'Version 2.0 is now available with improved performance and new features.', isImportant: false },
  { id: 'notice-new-game', title: 'New Game Type Added', content: "We've added a new game type - Super Jodi! Check it out in the markets section.", isImportant: false },
  { id: 'notice-withdrawal', title: 'Withdrawal Processing Time', content: 'All withdrawal requests are now processed within 2-4 hours on working days.', isImportant: false },
];

// Result markets shown on the Results/Charts screen. Highlight = DAY top picks.
// Order matches the 14 live markets exactly so results + charts stay in sync with Home.
const RESULT_MARKETS = [
  { id: 'sridevi', name: 'SRIDEVI DAY', highlight: true, openTime: '11:30 AM', closeTime: '12:30 PM', order: 1 },
  { id: 'time-bazar-day', name: 'TIME BAZAR', highlight: true, openTime: '01:00 PM', closeTime: '02:00 PM', order: 2 },
  { id: 'madhur-day', name: 'MADHUR DAY', highlight: false, openTime: '01:30 PM', closeTime: '02:30 PM', order: 3 },
  { id: 'rajdhani-day', name: 'RAJDHANI DAY', highlight: false, openTime: '03:15 PM', closeTime: '05:15 PM', order: 4 },
  { id: 'milan-day', name: 'MILAN DAY', highlight: true, openTime: '03:00 PM', closeTime: '05:00 PM', order: 5 },
  { id: 'supreme-day', name: 'SUPREME DAY', highlight: false, openTime: '03:30 PM', closeTime: '05:30 PM', order: 6 },
  { id: 'kalyan', name: 'KALYAN', highlight: true, openTime: '03:45 PM', closeTime: '05:45 PM', order: 7 },
  { id: 'sridevi-night', name: 'SRIDEVI NIGHT', highlight: false, openTime: '07:15 PM', closeTime: '08:15 PM', order: 8 },
  { id: 'madhur-night', name: 'MADHUR NIGHT', highlight: false, openTime: '08:30 PM', closeTime: '10:30 PM', order: 9 },
  { id: 'supreme-night', name: 'SUPREME NIGHT', highlight: false, openTime: '08:30 PM', closeTime: '10:30 PM', order: 10 },
  { id: 'milan-night', name: 'MILAN NIGHT', highlight: true, openTime: '09:00 PM', closeTime: '11:00 PM', order: 11 },
  { id: 'rajdhani-night', name: 'RAJDHANI NIGHT', highlight: false, openTime: '09:30 PM', closeTime: '11:45 PM', order: 12 },
  { id: 'kalyan-night', name: 'KALYAN NIGHT', highlight: true, openTime: '09:40 PM', closeTime: '11:40 PM', order: 13 },
  { id: 'main-bazar', name: 'MAIN BAZAR', highlight: true, openTime: '09:35 PM', closeTime: '12:05 AM', order: 14 },
];

async function main() {
  console.log('Seeding SATMAT database...');

  for (const m of MARKETS) {
    await prisma.market.upsert({
      where: { id: m.id },
      update: { name: m.name, openTime: m.openTime, closeTime: m.closeTime, isLive: (m as any).isLive ?? false, isClosed: (m as any).isClosed ?? false, order: m.order },
      create: { id: m.id, name: m.name, openTime: m.openTime, closeTime: m.closeTime, isLive: (m as any).isLive ?? false, isClosed: (m as any).isClosed ?? false, order: m.order },
    });
  }

  // Remove any Market (and its cascaded chart/game-type/bid rows) that is no
  // longer in the active set — e.g. markets removed from the app — so the UI
  // and API never surface retired markets.
  const activeMarketIds = MARKETS.map((m) => m.id);
  const staleMarkets = await prisma.market.findMany({
    where: { id: { notIn: activeMarketIds } },
    select: { id: true },
  });
  for (const stale of staleMarkets) {
    await prisma.bid.deleteMany({ where: { marketId: stale.id } });
    await prisma.marketGameType.deleteMany({ where: { marketId: stale.id } });
    await prisma.chartRecord.deleteMany({ where: { marketId: stale.id } });
    await prisma.market.delete({ where: { id: stale.id } });
  }

  // Seed the standard set of game types (ANK/JODI/SP/DP/TP/CP/HF.S/F.S/MOTAR)
  // for every active market so the Play Now screen shows correct, clickable
  // buttons per market. Remove any game type no longer in the active set.
  // Batched 3-at-a-time: 126 sequential upserts over the pooler take >10 min
  // and blow Render's preDeploy timeout (deploy then fails and serves stale
  // code+data). Batched it finishes in ~2-3 min.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const m of MARKETS) {
    const marketGameTypeIds = GAME_TYPES.map((g) => `${m.id}:${g.key}`);
    await prisma.marketGameType.deleteMany({
      where: { marketId: m.id, id: { notIn: marketGameTypeIds } },
    });
    for (let j = 0; j < GAME_TYPES.length; j += 3) {
      await Promise.all(
        GAME_TYPES.slice(j, j + 3).map((g) =>
          prisma.marketGameType.upsert({
            where: { id: `${m.id}:${g.key}` },
            update: {
              title: g.title,
              iconName: g.iconName,
              isOpen: g.isOpen,
              code: g.code,
              order: g.order,
              marketId: m.id,
            },
            create: {
              id: `${m.id}:${g.key}`,
              title: g.title,
              iconName: g.iconName,
              isOpen: g.isOpen,
              code: g.code,
              order: g.order,
              marketId: m.id,
            },
          }),
        ),
      );
      await sleep(80);
    }
  }

  for (const r of GAME_RATES) {
    await prisma.gameRate.upsert({
      where: { id: r.id },
      update: { gameType: r.gameType, rateRange: r.rateRange, order: r.order },
      create: { id: r.id, gameType: r.gameType, rateRange: r.rateRange, order: r.order },
    });
  }
  // Remove stale rates not in the new 9-rate set
  const activeRateIds = GAME_RATES.map((r) => r.id);
  await prisma.gameRate.deleteMany({ where: { id: { notIn: activeRateIds } } });

  // Upsert notices by ID (no deleteMany — avoids wiping admin-created notices).
  // Remove any notice whose ID is not in the seed set (old/retired notices).
  const activeNoticeIds = NOTICES.map((n) => n.id);
  await prisma.notice.deleteMany({ where: { id: { notIn: activeNoticeIds } } });
  for (const n of NOTICES) {
    await prisma.notice.upsert({
      where: { id: n.id },
      update: { title: n.title, content: n.content, isImportant: n.isImportant },
      create: { id: n.id, title: n.title, content: n.content, isImportant: n.isImportant },
    });
  }

  await prisma.appConfig.upsert({
    where: { id: 'app' },
    update: {},
    create: {
      id: 'app',
      minAppVersion: '1.0.0',
      forceUpdate: false,
      banners: JSON.stringify([{ id: 'b1', text: 'Welcome to SATMAT' }]),
      supportContacts: JSON.stringify({ email: 'support@satmat.example', whatsapp: '919876543210' }),
    },
  });

  await prisma.howToPlay.upsert({
    where: { id: 'how-to-play' },
    update: {},
    create: {
      id: 'how-to-play',
      sections: JSON.stringify([
        { title: 'Create an Account', body: 'Register with your phone number and start playing.' },
        { title: 'Pick a Market', body: 'Choose from live markets and place your bid before close.' },
        { title: 'Win & Withdraw', body: 'Winnings are credited instantly. Withdraw to bank or UPI.' },
      ]),
    },
  });

  // Results screen markets shown by the Results screen. `highlight` marks the
  // markets the UI emphasizes (yellow). Real result records are hydrated by the
  // scraper (satmat-web adapter); no fabricated/sample data is seeded here.
  // Remove any ResultMarket (and its records) that is no longer in the active
  // set — e.g. markets with no matching provider chart — so the results screen
  // never surfaces stale or fabricated data.
  const activeResultIds = RESULT_MARKETS.map((rm) => rm.id);
  const existingResultMarkets = await prisma.resultMarket.findMany({
    where: { id: { notIn: activeResultIds } },
    select: { id: true },
  });
  for (const stale of existingResultMarkets) {
    await prisma.resultRecord.deleteMany({ where: { marketId: stale.id } });
    await prisma.resultMarket.delete({ where: { id: stale.id } });
  }

  for (const rm of RESULT_MARKETS) {
    await prisma.resultMarket.upsert({
      where: { id: rm.id },
      update: { name: rm.name, highlight: rm.highlight, openTime: rm.openTime, closeTime: rm.closeTime, order: rm.order },
      create: { id: rm.id, name: rm.name, highlight: rm.highlight, openTime: rm.openTime, closeTime: rm.closeTime, order: rm.order },
    });
  }
  console.log('ResultMarkets upserted. Result records are hydrated by the real scraper (satmat-web).');

  // Single SUPER_ADMIN — legacy dummy +910000000000 and any previous admin are
  // removed before upsert to enforce "sirf 1 super admin".
  await prisma.user.deleteMany({
    where: { phone: { in: ['+910000000000', '+918856015973'] } },
  });
  const admin = await prisma.user.upsert({
    where: { phone: '+919527194409' },
    update: {
      name: 'Aarif',
      passwordHash: await bcrypt.hash(requireAdminPassword(), 10),
      roles: 'SUPER_ADMIN,ADMIN',
      isActive: true,
    },
    create: {
      name: 'Aarif',
      phone: '+919527194409',
      passwordHash: await bcrypt.hash(requireAdminPassword(), 10),
      referralCode: 'SUPERADMIN',
      roles: 'SUPER_ADMIN,ADMIN',
      balance: 0,
      isActive: true,
    } as any,
  });

  console.log(`Seeding complete. SUPER_ADMIN phone: ${admin.phone}`);
}

// Require an explicit ADMIN_PASSWORD in production (never fall back to a weak
// default). In local/dev it may be omitted and defaults to 'admin123'.
function requireAdminPassword(): string {
  const isProd = process.env.NODE_ENV === 'production';
  const pw = process.env.ADMIN_PASSWORD;
  if (isProd) {
    if (!pw) {
      throw new Error(
        'ADMIN_PASSWORD is required in production. Set a strong admin password (>=8 chars) in backend/.env (or your host env vars), then re-run the deploy.',
      );
    }
    if (pw.length < 8) {
      throw new Error('ADMIN_PASSWORD must be at least 8 characters in production.');
    }
    return pw;
  }
  return pw || 'admin123';
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });