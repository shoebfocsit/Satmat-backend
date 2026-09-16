// Reference typed API client for SATMAT Web (Next.js src/) and SATMAT Website (Vite).
// This is a standalone, framework-free client — copy it into each app's lib/ and
// point API_BASE_URL at the backend. The mock-data UIs are NOT swapped yet; this
// client is the contract to use in the upcoming "wire the UI" pass.

import type {
  AppConfig,
  AuthResponse,
  BankDetails,
  Bid,
  ChartRecord,
  ChartRangeResponse,
  DepositOrder,
  GameRate,
  LatestResult,
  Market,
  MarketGameType,
  Notice,
  Notification,
  OrderRecord,
  Paged,
  Referral,
  ResultMarket,
  ResultsResponse,
  Stats,
  SyncPayload,
  Transaction,
  User,
  Wallet,
  Winnings,
  Withdrawal,
  WithdrawalRequest,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken: () => string | null;
  onRefresh?: (tokens: { accessToken: string; refreshToken: string }) => void;
  onUnauthorized?: () => void;
}

const DEFAULT_BASE =
  (typeof process !== 'undefined' && process.env?.API_BASE_URL) ||
  'http://localhost:8080/api/v1';

export class ApiClient {
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly options: ApiClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl || DEFAULT_BASE;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { idempotencyKey?: string; auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.auth !== false) {
      const token = this.options.getAccessToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && opts.auth !== false && this.options.onRefresh) {
      if (!this.refreshing) {
        this.refreshing = this.tryRefresh().finally(() => {
          this.refreshing = null;
        });
      }
      const ok = await this.refreshing;
      if (ok) return this.request<T>(method, path, body, opts);
      this.options.onUnauthorized?.();
      throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = data?.error;
      throw new ApiError(res.status, err?.code || 'ERROR', err?.message || res.statusText, err?.details);
    }
    return data as T;
  }

  private async tryRefresh(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.getRefreshToken() }),
      });
      if (!res.ok) return false;
      const tokens = (await res.json()) as AuthResponse;
      this.options.onRefresh?.({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      return true;
    } catch {
      return false;
    }
  }

  private getRefreshToken(): string | null {
    // Replace with your storage (localStorage / secure storage / cookie).
    try {
      return localStorage.getItem('satmat_refresh_token');
    } catch {
      return null;
    }
  }

  // ---- Auth ----
  register(body: { name: string; phone: string; password: string; referralCode?: string }) {
    return this.request<AuthResponse>('POST', '/auth/register', body, { auth: false });
  }
  login(body: { phone: string; password: string }) {
    return this.request<AuthResponse>('POST', '/auth/login', body, { auth: false });
  }
  logout(refreshToken: string) {
    return this.request<void>('POST', '/auth/logout', { refreshToken }, { auth: false });
  }
  me() {
    return this.request<User>('GET', '/auth/me');
  }
  updateMe(body: { name?: string; phone?: string }) {
    return this.request<User>('PATCH', '/auth/me', body);
  }
  sendOtp(body: { phone: string; purpose: 'login' | 'forgot-password' }) {
    return this.request<{ requestId: string; expiresInSec: number }>('POST', '/auth/otp/send', body, { auth: false });
  }
  verifyOtp(body: { requestId: string; otp: string }) {
    return this.request<AuthResponse>('POST', '/auth/otp/verify', body, { auth: false });
  }
  exchangeCode(code: string) {
    return this.request<AuthResponse>('GET', `/auth/exchange?code=${encodeURIComponent(code)}`, undefined, { auth: false });
  }
  issueExchangeCode() {
    return this.request<{ code: string }>('POST', '/auth/exchange/issue');
  }

  // ---- Markets ----
  markets() {
    return this.request<Market[]>('GET', '/markets', undefined, { auth: false });
  }
  market(id: string) {
    return this.request<Market>('GET', `/markets/${id}`, undefined, { auth: false });
  }
  chart(id: string, from?: string, to?: string) {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return this.request<ChartRecord[]>('GET', `/markets/${id}/chart?${q}`, undefined, { auth: false });
  }
  latestResult(id: string) {
    return this.request<LatestResult>('GET', `/markets/${id}/results/latest`, undefined, { auth: false });
  }
  gameTypes() {
    return this.request<MarketGameType[]>('GET', '/game-types', undefined, { auth: false });
  }
  gameRates() {
    return this.request<GameRate[]>('GET', '/game-rates', undefined, { auth: false });
  }

  // ---- Results & Charts screens ----
  results() {
    return this.request<ResultsResponse>('GET', '/results', undefined, { auth: false });
  }
  chartRange(params: { market: string; startDate: string; endDate: string }) {
    const q = new URLSearchParams(params);
    return this.request<ChartRangeResponse>('GET', `/charts?${q}`, undefined, { auth: false });
  }

  // ---- Bids ----
  placeBid(body: { marketId: string; gameType: string; number: string; amount: number }, idemKey: string) {
    return this.request<{ bid: Bid }>('POST', '/bids', body, { idempotencyKey: idemKey });
  }
  placeBulkBid(body: { marketId: string; gameType: string; round: 'OPEN' | 'CLOSE'; items: Array<{ number: string; amount: number }> }, idemKey: string) {
    return this.request<{ bids: Bid[]; totalAmount: number }>('POST', '/bids/bulk', body, { idempotencyKey: idemKey });
  }
  bids(params: { status?: string; page?: number; limit?: number } = {}) {
    const q = new URLSearchParams(params as Record<string, string>);
    return this.request<Paged<Bid>>('GET', `/bids?${q}`);
  }
  bid(id: string) {
    return this.request<Bid>('GET', `/bids/${id}`);
  }
  cancelBid(id: string, idemKey: string) {
    return this.request<Bid>('POST', `/bids/${id}/cancel`, {}, { idempotencyKey: idemKey });
  }

  // ---- Orders ----
  orders(params: { page?: number; limit?: number } = {}) {
    const q = new URLSearchParams(params as Record<string, string>);
    return this.request<Paged<OrderRecord>>('GET', `/orders?${q}`);
  }

  // ---- Wallet ----
  wallet() {
    return this.request<Wallet>('GET', '/wallet');
  }
  deposit(body: { amount: number; method: 'upi' }, idemKey: string) {
    return this.request<DepositOrder>('POST', '/wallet/deposit', body, { idempotencyKey: idemKey });
  }
  verifyDeposit(orderId: string, idemKey: string) {
    return this.request<{ status: string; balance: number }>('POST', `/wallet/deposit/${orderId}/verify`, {}, { idempotencyKey: idemKey });
  }
  withdraw(body: { amount: number; payout: 'bank' | 'upi'; upiId?: string; bankDetailsId?: string }, idemKey: string) {
    return this.request<WithdrawalRequest>('POST', '/wallet/withdraw', body, { idempotencyKey: idemKey });
  }
  withdrawals(params: { status?: string; page?: number; limit?: number } = {}) {
    const q = new URLSearchParams(params as Record<string, string>);
    return this.request<Paged<Withdrawal>>('GET', `/wallet/withdrawals?${q}`);
  }
  transactions(params: { type?: string; search?: string; page?: number; limit?: number } = {}) {
    const q = new URLSearchParams(params as Record<string, string>);
    return this.request<Paged<Transaction>>('GET', `/transactions?${q}`);
  }
  bankDetails() {
    return this.request<BankDetails | null>('GET', '/bank-details');
  }
  saveBankDetails(body: BankDetails) {
    return this.request<BankDetails>('POST', '/bank-details', body);
  }
  winnings(params: { page?: number } = {}) {
    return this.request<Winnings>('GET', `/winnings?${new URLSearchParams(params as Record<string, string>)}`);
  }

  // ---- Content ----
  notices() {
    return this.request<Notice[]>('GET', '/notices', undefined, { auth: false });
  }
  howToPlay() {
    return this.request<{ sections: Array<{ title: string; body: string }> }>('GET', '/how-to-play', undefined, { auth: false });
  }
  stats() {
    return this.request<Stats>('GET', '/stats', undefined, { auth: false });
  }
  referral() {
    return this.request<Referral>('GET', '/referral');
  }
  claimReferral(inviteePhone: string) {
    return this.request<{ bonusCredited: boolean; bonus?: number }>('POST', '/referral/claim', { inviteePhone });
  }

  // ---- Support ----
  createTicket(body: { subject: string; message: string }) {
    return this.request<{ ticketId: string }>('POST', '/support/tickets', body);
  }
  ticketMessages(id: string) {
    return this.request<{ messages: Array<{ text: string; from: string; createdAt: string }> }>('GET', `/support/tickets/${id}/messages`);
  }

  // ---- Notifications ----
  notifications(params: { page?: number; limit?: number } = {}) {
    return this.request<Paged<Notification>>('GET', `/notifications?${new URLSearchParams(params as Record<string, string>)}`);
  }
  markNotificationsRead(ids: string[]) {
    return this.request<void>('POST', '/notifications/read', { ids });
  }
  registerDevice(deviceToken: string, platform: 'android' | 'ios') {
    return this.request<void>('POST', '/notifications/device', { deviceToken, platform });
  }
  unregisterDevice(deviceToken: string) {
    return this.request<void>('DELETE', '/notifications/device', { deviceToken });
  }

  // ---- Mobile sync ----
  serverTime() {
    return this.request<{ iso: string }>('GET', '/server-time', undefined, { auth: false });
  }
  appConfig() {
    return this.request<AppConfig>('GET', '/app-config', undefined, { auth: false });
  }
  sync(since?: string) {
    return this.request<SyncPayload>('GET', `/sync${since ? `?since=${since}` : ''}`);
  }

  // ---- AI ----
  aiChat(prompt: string, context?: string) {
    return this.request<{ reply: string }>('POST', '/ai/chat', { prompt, context });
  }
}

export type {
  AuthResponse,
  User,
  Market,
  MarketGameType,
  GameRate,
  ChartRecord,
  LatestResult,
  Bid,
  Notice,
  Transaction,
  OrderRecord,
  BankDetails,
  Wallet,
  DepositOrder,
  WithdrawalRequest,
  Withdrawal,
  Winnings,
  Referral,
  Notification,
  AppConfig,
  SyncPayload,
  Stats,
};