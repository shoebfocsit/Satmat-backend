// Shared SATMAT API types — single source of truth for all three frontends.
// Keep in sync with the NestJS DTOs in ../src/modules/*/dto.

export interface ApiError {
  statusCode: number;
  path: string;
  timestamp: string;
  error: { code: string; message: string; details: Record<string, unknown> };
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface User {
  id: string;
  name: string;
  phone: string;
  balance: number; // ₹
  isGoldMember: boolean;
  referralCode: string;
  roles?: string[];
}

export interface Market {
  id: string;
  name: string;
  result: string;
  openTime: string;
  closeTime: string;
  isLive?: boolean;
  isClosed?: boolean;
}

export interface MarketGameType {
  id: string;
  title: string;
  iconName: string;
  isOpen: boolean;
  code?: string;
}

export interface GameRate {
  id: string;
  gameType: string;
  rateRange: string;
}

export interface ChartRecord {
  id: string;
  marketId: string;
  date: string;
  open: string;
  openAnk: string;
  jodi: string;
  close: string;
  closeAnk: string;
}

export interface LatestResult {
  open: string;
  jodi: string;
  close: string;
  declaredAt: string;
}

// ---- Results & Charts screens ----

export interface ResultMarket {
  id: string;
  name: string;
  highlight: boolean;
  openTime: string;
  closeTime: string;
  result: {
    jodi: string | null;
    panel: string | null;
    date: string;
    source: string;
  } | null;
}

export interface ResultsResponse {
  updatedAt: string;
  markets: ResultMarket[];
}

export interface ChartResultRecord {
  date: string;
  jodi: string | null;
  panel: string | null;
  open: string | null;
  close: string | null;
  source: string;
}

export interface ChartRangeResponse {
  market: string;
  marketId: string;
  startDate: string;
  endDate: string;
  source: string;
  count: number;
  data: ChartResultRecord[];
  /** Calendar dates in [startDate, endDate] with no record — never fabricated. */
  missingDates: string[];
}

export const RESULT_MARKETS: Array<{ id: string; name: string; highlight: boolean; openTime: string; closeTime: string }> = [
  { id: 'sridevi', name: 'SRIDEVI DAY', highlight: true, openTime: '11:40 AM', closeTime: '12:40 PM' },
  { id: 'time-bazar-day', name: 'TIME BAZAR', highlight: true, openTime: '01:10 PM', closeTime: '02:10 PM' },
  { id: 'madhur-day', name: 'MADHUR DAY', highlight: false, openTime: '01:35 PM', closeTime: '02:35 PM' },
  { id: 'rajdhani-day', name: 'RAJDHANI DAY', highlight: false, openTime: '03:10 PM', closeTime: '05:10 PM' },
  { id: 'milan-day', name: 'MILAN DAY', highlight: true, openTime: '03:10 PM', closeTime: '05:10 PM' },
  { id: 'supreme-day', name: 'SUPREME DAY', highlight: false, openTime: '03:35 PM', closeTime: '05:35 PM' },
  { id: 'kalyan', name: 'KALYAN', highlight: true, openTime: '04:00 PM', closeTime: '06:00 PM' },
  { id: 'sridevi-night', name: 'SRIDEVI NIGHT', highlight: false, openTime: '07:15 PM', closeTime: '08:15 PM' },
  { id: 'madhur-night', name: 'MADHUR NIGHT', highlight: false, openTime: '08:35 PM', closeTime: '10:35 PM' },
  { id: 'supreme-night', name: 'SUPREME NIGHT', highlight: false, openTime: '08:40 PM', closeTime: '10:40 PM' },
  { id: 'milan-night', name: 'MILAN NIGHT', highlight: true, openTime: '09:10 PM', closeTime: '11:10 PM' },
  { id: 'rajdhani-night', name: 'RAJDHANI NIGHT', highlight: false, openTime: '09:35 PM', closeTime: '11:40 PM' },
  { id: 'kalyan-night', name: 'KALYAN NIGHT', highlight: true, openTime: '09:40 PM', closeTime: '11:40 PM' },
  { id: 'main-bazar', name: 'MAIN BAZAR', highlight: true, openTime: '09:55 PM', closeTime: '12:05 AM' },
];

export interface Bid {
  id: string;
  marketId: string;
  gameType: string;
  number: string;
  amount: number;
  rate: number;
  status: 'pending' | 'won' | 'lost' | 'cancelled';
  round: 'OPEN' | 'CLOSE';
  date: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page?: number;
  limit?: number;
}

export interface Notice {
  id: string;
  title: string;
  content: string;
  date: string;
  isImportant?: boolean;
}

export interface Transaction {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  title: string;
  date: string;
  status: 'completed' | 'pending' | 'failed';
}

export interface OrderRecord {
  id: string;
  marketName: string | null;
  amount: number;
  status: string;
  type: string;
  date: string;
}

export interface BankDetails {
  accountHolder: string;
  accountNumber: string;
  ifscCode: string;
  bankName: string;
}

export interface Wallet {
  balance: number;
  currency: string;
}

export interface DepositOrder {
  orderId: string;
  pgOrderId: string;
  upiIntent: string;
  qr: string;
  expiry: string;
  amount: number;
}

export interface WithdrawalRequest {
  requestId: string;
  status: string;
  amount: number;
}

export interface Withdrawal {
  id: string;
  amount: number;
  method: 'bank' | 'upi';
  status: string;
  createdAt: string;
}

export interface Winnings {
  totalWinnings: number;
  winningCount: number;
  items: Array<{
    id: string;
    marketName: string;
    gameType: string;
    number: string;
    amount: number;
    wonAmount: number;
    date: string;
  }>;
}

export interface Referral {
  code: string;
  totalReferrals: number;
  totalEarned: number;
  link: string;
}

export interface Ticket {
  ticketId: string;
}

export interface TicketMessages {
  messages: Array<{ text: string; from: string; createdAt: string }>;
}

export interface Notification {
  id: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

export interface AppConfig {
  minAppVersion: string;
  forceUpdate: boolean;
  banners: Array<{ id: string; text: string }>;
  supportContacts: Record<string, string>;
}

export interface SyncPayload {
  user: User | null;
  balance: number;
  markets: Market[];
  notices: Notice[];
  bids: Bid[];
  transactions: Transaction[];
  syncedAt: string;
}

export interface Stats {
  activePlayers: number;
  liveMarkets: number;
  withdrawalTime: string;
  supportHours: string;
}

export interface AdminDashboard {
  totalUsers: number;
  totalDeposits: number;
  totalWithdrawals: number;
  margin: number;
  pendingBidVolume: number;
}