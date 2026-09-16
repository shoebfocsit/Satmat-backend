import { sessionDateForRow, resolveSessionDate } from './market-time';
import {
  getMarketStatus,
  marketWindowInstants,
  parseTimeToMinutes,
  resolveTimezone,
} from './market-time';

// Times are minutes-since-midnight IST injected explicitly (no TZ dependence).
const T = (h: number, m: number) => h * 60 + m;
const TODAY = '2026-09-07';
const YESTERDAY = '2026-09-06';

describe('sessionDateForRow', () => {
  it('dates a full day-market row today after close', () => {
    // MADHUR DAY 01:35-02:35, observed 16:51 IST
    expect(sessionDateForRow('01:35 PM', '02:35 PM', true, TODAY, T(16, 51))).toBe('today');
  });

  it('dates a full night-market row yesterday before close (leftover display)', () => {
    // RAJDHANI NIGHT 09:35 PM-11:40 PM, observed 16:51 IST — tonight hasn't run
    expect(sessionDateForRow('09:35 PM', '11:40 PM', true, TODAY, T(16, 51))).toBe('yesterday');
  });

  it('dates a full night-market row today after close', () => {
    expect(sessionDateForRow('09:35 PM', '11:40 PM', true, TODAY, T(23, 45))).toBe('today');
  });

  it('accepts a live open-only partial as today', () => {
    // MILAN DAY 03:10-05:10, observed 16:51 IST (session live)
    expect(sessionDateForRow('03:10 PM', '05:10 PM', false, TODAY, T(16, 51))).toBe('today');
  });

  it('skips a stale partial outside session hours', () => {
    expect(sessionDateForRow('03:10 PM', '05:10 PM', false, TODAY, T(10, 0))).toBe('skip');
  });

  it('honours the 30-min grace for provider-early declares (KALYAN 04:00-06:00 @ 05:45)', () => {
    expect(sessionDateForRow('04:00 PM', '06:00 PM', true, TODAY, T(17, 45))).toBe('today');
    expect(sessionDateForRow('04:00 PM', '06:00 PM', true, TODAY, T(17, 20))).toBe('yesterday');
  });

  it('always dates overnight full rows yesterday (MAIN BAZAR 09:55 PM-12:05 AM)', () => {
    expect(sessionDateForRow('09:55 PM', '12:05 AM', true, TODAY, T(16, 51))).toBe('yesterday');
    expect(sessionDateForRow('09:55 PM', '12:05 AM', true, TODAY, T(22, 30))).toBe('yesterday');
  });

  it('dates overnight partials by live window', () => {
    expect(sessionDateForRow('09:55 PM', '12:05 AM', false, TODAY, T(22, 30))).toBe('today');
    expect(sessionDateForRow('09:55 PM', '12:05 AM', false, TODAY, T(0, 3))).toBe('yesterday');
    expect(sessionDateForRow('09:55 PM', '12:05 AM', false, TODAY, T(16, 51))).toBe('skip');
  });

  it('resolveSessionDate maps to concrete dates or null', () => {
    expect(resolveSessionDate('09:35 PM', '11:40 PM', true, TODAY, T(16, 51))).toBe(YESTERDAY);
    expect(resolveSessionDate('01:35 PM', '02:35 PM', true, TODAY, T(16, 51))).toBe(TODAY);
    expect(resolveSessionDate('03:10 PM', '05:10 PM', false, TODAY, T(10, 0))).toBeNull();
  });
});

describe('getMarketStatus (server bidding window: open <= now < close)', () => {
  // IST = UTC+5:30, so 10:00 IST == 04:30Z. Absolute instants keep the tests
  // independent of whatever TZ the server/CI runs in.
  const atIST = (h: number, m: number, day = 8) =>
    new Date(Date.UTC(2026, 8, day, h - 5, m - 30));
  const OPEN = '10:00 AM';
  const CLOSE = '06:00 PM';

  it('rejects one minute before open (SCHEDULED)', () => {
    const w = getMarketStatus(OPEN, CLOSE, { now: atIST(9, 59) });
    expect(w.status).toBe('SCHEDULED');
    expect(w.canBid).toBe(false);
    expect(w.reason).toBe('NOT_OPEN_YET');
  });

  it('accepts exactly at opening time', () => {
    const w = getMarketStatus(OPEN, CLOSE, { now: atIST(10, 0) });
    expect(w.status).toBe('OPEN');
    expect(w.canBid).toBe(true);
  });

  it('accepts during the open period', () => {
    expect(getMarketStatus(OPEN, CLOSE, { now: atIST(14, 30) }).canBid).toBe(true);
  });

  it('accepts one minute before close', () => {
    const w = getMarketStatus(OPEN, CLOSE, { now: atIST(17, 59) });
    expect(w.status).toBe('OPEN');
    expect(w.canBid).toBe(true);
  });

  it('rejects exactly at close time', () => {
    const w = getMarketStatus(OPEN, CLOSE, { now: atIST(18, 0) });
    expect(w.status).toBe('CLOSED');
    expect(w.canBid).toBe(false);
    expect(w.reason).toBe('CLOSED');
  });

  it('rejects after close', () => {
    expect(getMarketStatus(OPEN, CLOSE, { now: atIST(18, 1) }).canBid).toBe(false);
    expect(getMarketStatus(OPEN, CLOSE, { now: atIST(23, 0) }).canBid).toBe(false);
  });

  it('accepts 24h-format schedules identically', () => {
    expect(getMarketStatus('10:00', '18:00', { now: atIST(10, 0) }).canBid).toBe(true);
    expect(getMarketStatus('10:00', '18:00', { now: atIST(18, 0) }).canBid).toBe(false);
  });

  it('fails CLOSED on invalid schedules (never fails open)', () => {
    const w = getMarketStatus('not-a-time', CLOSE, { now: atIST(12, 0) });
    expect(w.canBid).toBe(false);
    expect(w.reason).toBe('INVALID_SCHEDULE');
  });

  describe('overnight window 22:00 -> 02:00', () => {
    const O = '10:00 PM';
    const C = '02:00 AM';
    it('is SCHEDULED in the evening gap', () => {
      const w = getMarketStatus(O, C, { now: atIST(21, 59) });
      expect(w.canBid).toBe(false);
      expect(w.overnight).toBe(true);
    });
    it('opens exactly at 22:00', () => {
      expect(getMarketStatus(O, C, { now: atIST(22, 0) }).canBid).toBe(true);
    });
    it('stays open after midnight', () => {
      expect(getMarketStatus(O, C, { now: atIST(0, 30, 9) }).canBid).toBe(true);
    });
    it('closes exactly at 02:00', () => {
      expect(getMarketStatus(O, C, { now: atIST(2, 0, 9) }).canBid).toBe(false);
    });
  });

  it('uses the market timezone, not the server timezone', () => {
    // 10:00-18:00 in New York: 15:00Z in January is 10:00 EST -> OPEN,
    // while the same instant is 20:30 IST (after an IST 10-18 close).
    const jan = new Date(Date.UTC(2026, 0, 8, 15, 0, 0));
    expect(
      getMarketStatus('10:00', '18:00', { now: jan, timezone: 'America/New_York' }).canBid,
    ).toBe(true);
    expect(getMarketStatus('10:00', '18:00', { now: jan }).canBid).toBe(false);
  });

  it('falls back to IST for unknown timezones (fail-safe)', () => {
    expect(resolveTimezone('Mars/Olympus')).toBe('Asia/Kolkata');
    const w = getMarketStatus(OPEN, CLOSE, { now: atIST(12, 0), timezone: 'Mars/Olympus' });
    expect(w.canBid).toBe(true);
    expect(w.timezone).toBe('Asia/Kolkata');
  });
});

describe('marketWindowInstants', () => {
  it('emits ordered ISO instants for countdown sync', () => {
    const now = new Date(Date.UTC(2026, 8, 8, 6, 30, 0)); // 12:00 IST
    const r = marketWindowInstants('10:00 AM', '06:00 PM', { now });
    expect(r.serverTime).toBe(now.toISOString());
    expect(r.opensAt).toBe('2026-09-08T04:30:00.000Z');
    expect(r.closesAt).toBe('2026-09-08T12:30:00.000Z');
  });

  it('rolls an overnight close into the next day', () => {
    const now = new Date(Date.UTC(2026, 8, 8, 17, 0, 0)); // 22:30 IST
    const r = marketWindowInstants('10:00 PM', '02:00 AM', { now });
    expect(r.opensAt).toBe('2026-09-08T16:30:00.000Z');
    expect(r.closesAt).toBe('2026-09-08T20:30:00.000Z');
  });

  it('returns nulls for invalid schedules', () => {
    const r = marketWindowInstants('xx', '06:00 PM', {});
    expect(r.opensAt).toBeNull();
    expect(r.closesAt).toBeNull();
    expect(typeof r.serverTime).toBe('string');
  });
});

describe('parseTimeToMinutes formats', () => {
  it('parses 12h and 24h forms', () => {
    expect(parseTimeToMinutes('10:00 AM')).toBe(600);
    expect(parseTimeToMinutes('06:00 PM')).toBe(1080);
    expect(parseTimeToMinutes('10:00')).toBe(600);
    expect(parseTimeToMinutes('18:00')).toBe(1080);
    expect(parseTimeToMinutes('12:00 AM')).toBe(0);
    expect(parseTimeToMinutes('12:00 PM')).toBe(720);
  });
  it('rejects garbage', () => {
    expect(parseTimeToMinutes('nope')).toBeNull();
    expect(parseTimeToMinutes('25:00')).toBeNull();
    expect(parseTimeToMinutes('10:61')).toBeNull();
  });
});
