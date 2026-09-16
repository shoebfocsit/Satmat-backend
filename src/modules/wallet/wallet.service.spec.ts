import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalletService } from './wallet.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { MemoryCache } from '../../common/cache/memory-cache';

describe('WalletService', () => {
  let service: WalletService;

  // Mutable env for this spec (MANUAL_PAYMENTS / NODE_ENV per test).
  const env: Record<string, string | undefined> = { PAYMENT_WEBHOOK_SECRET: '' };

  // Named exactly like the real provider so constructor-name checks behave.
  class MockPaymentProvider {
    createDepositOrder = jest.fn().mockResolvedValue({ orderId: 'ORD-1', pgOrderId: 'PG-1', upiIntent: 'upi://', qr: 'qr', expiry: 'now', amount: 5000 });
    verifyDeposit = jest.fn().mockResolvedValue({ status: 'authorized', paid: true });
  }
  const mockPayment = new MockPaymentProvider();

  const tx = {
    user: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    walletTransaction: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    order: { create: jest.fn(), updateMany: jest.fn() },
    withdrawal: { create: jest.fn().mockResolvedValue({ id: 'w1', amount: 5000 }), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    referral: { create: jest.fn(), findFirst: jest.fn() },
  };

  const prisma = {
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    walletTransaction: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    order: { create: jest.fn(), updateMany: jest.fn() },
    withdrawal: { findUnique: jest.fn(), update: jest.fn() },
    bankDetails: { findUnique: jest.fn(), upsert: jest.fn() },
    referral: { findFirst: jest.fn(), create: jest.fn() },
    $transaction: jest.fn().mockImplementation(async (cb) => cb(tx)),
  };

  const mockCache = {
    set: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(undefined),
    has: jest.fn().mockResolvedValue(false),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    delete env.MANUAL_PAYMENTS;
    delete env.NODE_ENV;
    const moduleRef = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: (k: string, d?: any) => env[k] ?? d } },
        { provide: CacheService, useValue: mockCache },
        { provide: MemoryCache, useValue: new MemoryCache() },
        { provide: 'PAYMENT_PROVIDER', useValue: mockPayment },
        { provide: 'SMS_PROVIDER', useValue: { sendOtp: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(WalletService);
  });

  describe('getBalance', () => {
    it('returns balance converted from paise to rupees', async () => {
      prisma.user.findUnique.mockResolvedValue({ balance: 123450 });
      const res = await service.getBalance('u1');
      expect(res.balance).toBe(1234.5);
    });
  });

  describe('deposit', () => {
    it('creates a pending order and transaction', async () => {
      prisma.walletTransaction.create.mockResolvedValue({});
      prisma.order.create.mockResolvedValue({});
      const order = await service.deposit('u1', { amount: 5000, method: 'upi' });
      expect(order.orderId).toBe('ORD-1');
      const txCreate = prisma.walletTransaction.create.mock.calls[0][0];
      expect(txCreate.data.status).toBe('PENDING');
    });
  });

  describe('withdraw', () => {
    it('deducts balance atomically when funds are sufficient', async () => {
      tx.user.findUnique.mockResolvedValue({ balance: 10000 });
      const res = await service.withdraw('u1', { amount: 5000, payout: 'upi', upiId: 'u@upi' });
      expect(res.status).toBe('pending');
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ balance: expect.anything() }) }),
      );
    });

    it('rejects withdrawal when balance is insufficient', async () => {
      tx.user.findUnique.mockResolvedValue({ balance: 1000 });
      await expect(service.withdraw('u1', { amount: 5000, payout: 'upi', upiId: 'u@upi' })).rejects.toThrow();
    });
  });

  describe('depositWebhook', () => {
    it('credits balance for a paid webhook', async () => {
      prisma.walletTransaction.findFirst.mockResolvedValue({ id: 't1', userId: 'u1', amount: 5000, status: 'PENDING' });
      tx.referral.findFirst.mockResolvedValue(null);
      await service.depositWebhook({ order_id: 'ORD-1', status: 'paid' });
      expect(tx.user.update).toHaveBeenCalled();
    });

    it('does not double-credit an already completed deposit', async () => {
      prisma.walletTransaction.findFirst.mockResolvedValue({ id: 't1', userId: 'u1', amount: 5000, status: 'COMPLETED' });
      await service.depositWebhook({ order_id: 'ORD-1', status: 'paid' });
      expect(tx.user.update).not.toHaveBeenCalled();
    });
  });

  describe('manual mode (MANUAL_PAYMENTS=true)', () => {
    it('verifyDeposit credits instantly in manual mode even in production', async () => {
      env.NODE_ENV = 'production';
      env.MANUAL_PAYMENTS = 'true';
      prisma.walletTransaction.findFirst.mockResolvedValue({
        id: 't1', userId: 'u1', amount: 5000, status: 'PENDING', createdAt: new Date(),
      });
      tx.user.findUnique.mockResolvedValue({ id: 'u1' });
      tx.referral.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({ balance: 15000 });
      const res = await service.verifyDeposit('u1', 'ORD-9');
      expect(res.status).toBe('COMPLETED');
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { balance: { increment: 5000 } } }),
      );
    });

    it('blocks mock verify in production when manual mode is off', async () => {
      env.NODE_ENV = 'production';
      prisma.walletTransaction.findFirst.mockResolvedValue({
        id: 't1', userId: 'u1', amount: 5000, status: 'PENDING', createdAt: new Date(),
      });
      await expect(service.verifyDeposit('u1', 'ORD-9')).rejects.toMatchObject({
        response: { code: 'MOCK_DISABLED' },
      });
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('withdraw auto-settles instantly in manual mode', async () => {
      env.MANUAL_PAYMENTS = 'true';
      tx.user.findUnique.mockResolvedValue({ balance: 10000 });
      tx.withdrawal.create.mockResolvedValue({ id: 'w9', amount: 5000 });
      const res = await service.withdraw('u1', { amount: 5000, payout: 'upi', upiId: 'u@upi' });
      expect(res.status).toBe('completed');
      expect(tx.withdrawal.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
      );
      expect(tx.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', reference: 'w9' }) }),
      );
    });
  });

  describe('adminAdjust', () => {
    it('credits with a ledger row and returns the new balance', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u1', balance: 1000 });
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', balance: 51000 });
      const res = await service.adminAdjust('admin1', { phone: '9999999999', amount: 50000, direction: 'credit' });
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { balance: { increment: 50000 } } }),
      );
      expect(tx.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'CREDIT', amount: 50000 }) }),
      );
      expect(res).toMatchObject({ ok: true, userId: 'u1', delta: 500 });
    });

    it('debits atomically and rejects overdraft without touching the ledger', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', balance: 1000 });
      tx.user.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.adminAdjust('admin1', { userId: 'u1', amount: 500, direction: 'debit' });
      expect(res).toMatchObject({ ok: true, delta: -5 });
      expect(tx.walletTransaction.create).toHaveBeenCalled();

      tx.user.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.adminAdjust('admin1', { userId: 'u1', amount: 500000, direction: 'debit' }),
      ).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_BALANCE' } });
    });

    it('requires a user target and a real user', async () => {
      await expect(
        service.adminAdjust('admin1', { amount: 1000, direction: 'credit' } as any),
      ).rejects.toMatchObject({ response: { code: 'USER_REQUIRED' } });
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(
        service.adminAdjust('admin1', { phone: '0000000000', amount: 1000, direction: 'credit' }),
      ).rejects.toMatchObject({ response: { code: 'USER_NOT_FOUND' } });
    });
  });

  describe('settleWithdrawal', () => {
    it('completes a pending withdrawal', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: 'w1', userId: 'u1', amount: 5000, status: 'PENDING' });
      tx.withdrawal.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.settleWithdrawal('admin1', 'w1', 'complete');
      expect(res).toEqual({ ok: true, id: 'w1', status: 'completed' });
      expect(tx.user.update).not.toHaveBeenCalled(); // no money moves on complete
    });

    it('fails with an atomic refund', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: 'w1', userId: 'u1', amount: 5000, status: 'PENDING' });
      tx.withdrawal.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.settleWithdrawal('admin1', 'w1', 'fail');
      expect(res.status).toBe('failed');
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { balance: { increment: 5000 } } }),
      );
    });

    it('rejects double-settle and unknown ids', async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: 'w1', userId: 'u1', amount: 5000, status: 'COMPLETED' });
      await expect(service.settleWithdrawal('admin1', 'w1', 'complete')).rejects.toMatchObject({
        response: { code: 'WITHDRAWAL_NOT_SETTLABLE' },
      });
      prisma.withdrawal.findUnique.mockResolvedValue(null);
      await expect(service.settleWithdrawal('admin1', 'nope', 'complete')).rejects.toMatchObject({
        response: { code: 'WITHDRAWAL_NOT_FOUND' },
      });
    });
  });
});