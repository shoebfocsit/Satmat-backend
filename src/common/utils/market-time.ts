/**
 * IST-aware market open/closed calculation.
 * Times are stored as "11:40 AM" / "09:55 PM" strings (IST).
 * Status is computed live on every request so the UI is always accurate
 * without needing a cron to flip isLive/isClosed flags.
 */

export function parseTimeToMinutes(timeStr: string): number | null {
  const raw = (timeStr || '').trim();
  // 12h format: "11:40 AM" / "09:55 PM" (existing market data, IST wall-clock)
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const mins = parseInt(m[2], 10);
    const ap = m[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    if (h < 0 || h > 23 || mins < 0 || mins > 59) return null;
    return h * 60 + mins;
  }
  // 24h format: "10:00" / "18:00" (admin-configured schedules)
  const h24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const mins = parseInt(h24[2], 10);
    if (h < 0 || h > 23 || mins < 0 || mins > 59) return null;
    return h * 60 + mins;
  }
  return null;
}

/** Default market timezone (Indian markets). */
export const DEFAULT_MARKET_TIMEZONE = 'Asia/Kolkata';

/** Minutes-since-midnight -> canonical display "03:00 PM" (matches seed style). */
export function formatTimeMinutes(minutes: number): string {
  const h24 = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(h24 / 60);
  const m = h24 % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
}

/**
 * Validate a market timezone. Unknown/empty values fall back to the default
 * so a bad admin write can never break the bidding gate (fail-safe).
 */
export function resolveTimezone(tz: unknown): string {
  if (typeof tz !== 'string' || tz.trim() === '') return DEFAULT_MARKET_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_MARKET_TIMEZONE;
  }
}

/** YYYY-MM-DD in the market timezone regardless of server TZ (Render = UTC). */
export function todayIST(date = new Date(), timezone = DEFAULT_MARKET_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

export function nowMinutesIST(date = new Date(), timezone = DEFAULT_MARKET_TIMEZONE): number {
  // Use Intl to get market-tz wall-clock time regardless of server TZ (Render = UTC)
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: resolveTimezone(timezone),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const h = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
  const m = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
  return h * 60 + m;
}

export function computeLiveStatus(
  openTime: string,
  closeTime: string,
  nowMinutes = nowMinutesIST(),
): { isLive: boolean; isClosed: boolean } {
  const open = parseTimeToMinutes(openTime);
  const close = parseTimeToMinutes(closeTime);
  if (open === null || close === null) return { isLive: false, isClosed: false };

  const overnight = close <= open; // e.g. 09:55 PM (1315) -> 12:05 AM (5) wraps midnight
  if (overnight) {
    // Live window wraps midnight: [open, 24h) U [0, close)
    const isLive = nowMinutes >= open || nowMinutes < close;
    // For overnight markets, "closed" means early-morning after close (00:05-12:00) — the previous
    // session's result is declared and betting is closed for a few hours. Evening before next
    // open (12:00-21:55) is "upcoming" not "closed" so users can still place bets for tonight.
    // This matches typical matka UX: you can bid for MAIN BAZAR at 19:00 even though 00:05-12:00 is closed.
    const isClosed = !isLive && nowMinutes >= close && nowMinutes < open && nowMinutes < 12 * 60;
    return { isLive, isClosed };
  }
  const isLive = nowMinutes >= open && nowMinutes < close;
  const isClosed = nowMinutes >= close;
  return { isLive, isClosed };
}

/**
 * Grace (minutes) for close-time comparison in session dating. Provider
 * declares often land up to ~30 min before OUR configured close (e.g. our
 * KALYAN 06:00 PM vs provider 05:45 PM). Without grace, a genuine 05:45 PM
 * declare would be misdated to yesterday and then eaten by the healer.
 */
export const SESSION_CLOSE_GRACE_MIN = 30;

function addDaysIso(iso: string, n: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export type SessionDate = 'today' | 'yesterday' | 'skip';

/**
 * Which IST session-date a freshly observed homepage row belongs to.
 * This is the core anti-pollution rule for go-live correctness:
 * - FULL row (open+jodi+close): belongs to the most recently CLOSED session.
 *   A full row for a session that hasn't closed yet is yesterday's leftover
 *   still displayed on the provider homepage (observed daily on night
 *   markets) — dating it today would pollute charts with wrong dates.
 * - PARTIAL row (open, close pending): belongs to today only while its
 *   session is live; otherwise it's a stale display → skip.
 * Overnight sessions (close <= open, e.g. MAIN BAZAR) always closed "last
 * night", so full rows are always yesterday's; partials follow the live
 * window. The weekend/holiday edge (no session opened) resolves via the
 * duplicate healer, which collapses exact-duplicate full rows to the
 * earliest date.
 */
export function sessionDateForRow(
  openTime: string,
  closeTime: string,
  isFull: boolean,
  // Named for positional-call readability (callers/tests pass TODAY here);
  // the function itself returns relative labels ('today'/'yesterday'/'skip').
  _today: string = todayIST(),
  nowMinutes: number = nowMinutesIST(),
): SessionDate {
  const open = parseTimeToMinutes(openTime);
  const close = parseTimeToMinutes(closeTime);
  if (open === null || close === null) return 'skip';

  if (close <= open) {
    // Overnight: tonight's session can never have closed yet.
    if (isFull) return 'yesterday';
    const live = nowMinutes >= open || nowMinutes < close;
    if (!live) return 'skip';
    return nowMinutes >= open ? 'today' : 'yesterday';
  }

  const closedAt = Math.max(open, close - SESSION_CLOSE_GRACE_MIN);
  if (isFull) {
    return nowMinutes >= closedAt ? 'today' : 'yesterday';
  }
  const live = nowMinutes >= open && nowMinutes < close;
  return live ? 'today' : 'skip';
}

export function resolveSessionDate(
  openTime: string,
  closeTime: string,
  isFull: boolean,
  today: string = todayIST(),
  nowMinutes: number = nowMinutesIST(),
): string | null {
  const s = sessionDateForRow(openTime, closeTime, isFull, today, nowMinutes);
  if (s === 'skip') return null;
  return s === 'today' ? today : addDaysIso(today, -1);
}

// ---------------------------------------------------------------------------
// Server-authoritative bidding window
// (SCHEDULED -> OPEN -> CLOSED; RESULT_DECLARED is resolved by the status
// service on top of this pure time rule.)
// ---------------------------------------------------------------------------

export type MarketWindowStatus = 'SCHEDULED' | 'OPEN' | 'CLOSED';
export type MarketWindowReason = 'NOT_OPEN_YET' | 'CLOSED' | 'INVALID_SCHEDULE' | null;

export interface MarketWindow {
  status: MarketWindowStatus;
  /** Single gate the bidding flow must use. */
  canBid: boolean;
  reason: MarketWindowReason;
  openMinutes: number | null;
  closeMinutes: number | null;
  /** True when the window crosses midnight (e.g. 22:00 -> 02:00). */
  overnight: boolean;
  nowMinutes: number;
  timezone: string;
}

export interface MarketWindowOptions {
  now?: Date;
  timezone?: string;
}

/**
 * The ONE bidding-window rule for the whole backend:
 *
 *   openTime <= now < closeTime  =>  OPEN (canBid)
 *
 * Boundaries (10:00 open, 18:00 close):
 *   09:59 -> SCHEDULED, 10:00 -> OPEN, 17:59 -> OPEN, 18:00 -> CLOSED.
 * Overnight (22:00 -> 02:00) is a wrapped window, never invalid.
 * Unparseable schedules fail CLOSED (never fail open).
 *
 * Pure function of server time + market config. Never takes client input.
 */
export function getMarketStatus(
  openTime: string,
  closeTime: string,
  opts: MarketWindowOptions = {},
): MarketWindow {
  const timezone = resolveTimezone(opts.timezone);
  const now = opts.now ?? new Date();
  const nowMinutes = nowMinutesIST(now, timezone);
  const open = parseTimeToMinutes(openTime);
  const close = parseTimeToMinutes(closeTime);

  if (open === null || close === null) {
    return {
      status: 'CLOSED',
      canBid: false,
      reason: 'INVALID_SCHEDULE',
      openMinutes: open,
      closeMinutes: close,
      overnight: false,
      nowMinutes,
      timezone,
    };
  }

  const overnight = close <= open;
  const inWindow = overnight
    ? nowMinutes >= open || nowMinutes < close
    : nowMinutes >= open && nowMinutes < close;

  if (inWindow) {
    return {
      status: 'OPEN',
      canBid: true,
      reason: null,
      openMinutes: open,
      closeMinutes: close,
      overnight,
      nowMinutes,
      timezone,
    };
  }
  // Before today's open (day markets) or in the daytime gap (overnight
  // markets) the session is upcoming, not finished — but bidding is closed
  // either way.
  const beforeOpen = overnight ? nowMinutes >= close && nowMinutes < open : nowMinutes < open;
  return {
    status: beforeOpen ? 'SCHEDULED' : 'CLOSED',
    canBid: false,
    reason: beforeOpen ? 'NOT_OPEN_YET' : 'CLOSED',
    openMinutes: open,
    closeMinutes: close,
    overnight,
    nowMinutes,
    timezone,
  };
}

/** IANA-tz offset in minutes (east of UTC) for a given instant. */
export function tzOffsetMinutes(timezone: string, at: Date): number {
  const tz = resolveTimezone(timezone);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const asUTC = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')) % 24,
    Number(get('minute')),
    Number(get('second')),
  );
  return Math.round((asUTC - at.getTime()) / 60000);
}

export interface MarketWindowInstants {
  serverTime: string;
  today: string;
  opensAt: string | null;
  closesAt: string | null;
}

/**
 * Absolute open/close instants for the *current* session date so the frontend
 * can render a server-synchronised countdown:
 *   remaining = (closesAt - serverTime) - (Date.now() - fetchedAt)
 * Returns nulls when the schedule is invalid.
 */
export function marketWindowInstants(
  openTime: string,
  closeTime: string,
  opts: MarketWindowOptions = {},
): MarketWindowInstants {
  const timezone = resolveTimezone(opts.timezone);
  const now = opts.now ?? new Date();
  const serverTime = now.toISOString();
  const today = todayIST(now, timezone);
  const open = parseTimeToMinutes(openTime);
  const close = parseTimeToMinutes(closeTime);
  if (open === null || close === null) {
    return { serverTime, today, opensAt: null, closesAt: null };
  }
  // Anchor at local noon so the offset lookup never straddles a DST edge.
  const dayBase = Date.parse(`${today}T00:00:00Z`);
  const offset = tzOffsetMinutes(timezone, new Date(dayBase + 12 * 3600 * 1000));
  const opensAt = new Date(dayBase + open * 60000 - offset * 60000).toISOString();
  const closeDay = close <= open ? addDaysIso(today, 1) : today;
  const closesAt = new Date(
    Date.parse(`${closeDay}T00:00:00Z`) + close * 60000 - offset * 60000,
  ).toISOString();
  return { serverTime, today, opensAt, closesAt };
}
