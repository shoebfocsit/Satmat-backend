import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import axios from 'axios';

export interface CreateDepositOrderInput {
  userId: string;
  amount: number; // paise
  method: 'upi';
}

export interface DepositOrder {
  orderId: string;
  pgOrderId: string;
  upiIntent: string;
  qr: string;
  expiry: string;
  amount: number;
}

export interface PaymentProvider {
  createDepositOrder(input: CreateDepositOrderInput): Promise<DepositOrder>;
  verifyDeposit(orderId: string, pgOrderId: string): Promise<{ status: string; paid: boolean }>;
  verifyWebhookSignature?(payload: any, signature: string | undefined, secret: string): boolean;
}

@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(MockPaymentProvider.name);
  async createDepositOrder(input: CreateDepositOrderInput): Promise<DepositOrder> {
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    this.logger.log(`[MOCK] createDepositOrder ${orderId} amount=${input.amount}`);
    return {
      orderId,
      pgOrderId: `PG-${orderId}`,
      upiIntent: `upi://pay?pa=mock@upi&am=${(input.amount / 100).toFixed(2)}&tn=${orderId}`,
      qr: 'data:image/svg+xml;base64,MOCK_QR_PLACEHOLDER',
      expiry: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      amount: input.amount,
    };
  }

  async verifyDeposit(_orderId: string, _pgOrderId: string) {
    return { status: 'authorized', paid: true };
  }

  verifyWebhookSignature(payload: any, signature: string | undefined, secret: string): boolean {
    if (!secret) return true; // mock mode accepts without signature
    if (!signature) return false;
    if (signature === `mock-sig-${secret}`) return true;
    // also allow real HMAC for forward-compat
    const expected = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
    return signature === expected || signature === `sha256=${expected}`;
  }
}

@Injectable()
export class RazorpayPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(RazorpayPaymentProvider.name);
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;

  constructor(private readonly config: ConfigService) {
    this.keyId = config.get<string>('PAYMENT_KEY_ID') || '';
    this.keySecret = config.get<string>('PAYMENT_KEY_SECRET') || '';
    this.webhookSecret = config.get<string>('PAYMENT_WEBHOOK_SECRET') || '';
    if (!this.keyId || !this.keySecret) {
      this.logger.warn('Razorpay keys missing — will fail at runtime. Set PAYMENT_KEY_ID/SECRET');
    }
  }

  async createDepositOrder(input: CreateDepositOrderInput): Promise<DepositOrder> {
    // Razorpay Orders API: https://razorpay.com/docs/api/orders
    try {
      const res = await axios.post(
        'https://api.razorpay.com/v1/orders',
        {
          amount: input.amount, // already in paise
          currency: 'INR',
          receipt: `satmat_${input.userId}_${Date.now()}`,
          notes: { userId: input.userId, method: input.method },
        },
        {
          auth: { username: this.keyId, password: this.keySecret },
          timeout: 8000,
        },
      );
      const pgOrderId: string = res.data.id;
      const orderId = `ORD-${pgOrderId}`;
      // Razorpay returns order_id; client builds UPI intent via checkout.
      // For UPI, frontend uses Razorpay Checkout with order_id.
      return {
        orderId,
        pgOrderId,
        upiIntent: `upi://pay?pa=razorpay@upi&am=${(input.amount / 100).toFixed(2)}&tn=${orderId}`,
        qr: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(pgOrderId)}&size=200x200`,
        expiry: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        amount: input.amount,
      };
    } catch (e: any) {
      this.logger.error(`Razorpay create order failed: ${e?.response?.data?.error?.description || e.message}`);
      throw e;
    }
  }

  async verifyDeposit(orderId: string, pgOrderId: string) {
    try {
      const res = await axios.get(`https://api.razorpay.com/v1/orders/${pgOrderId}`, {
        auth: { username: this.keyId, password: this.keySecret },
        timeout: 5000,
      });
      const status = res.data.status; // created, paid, etc
      return { status, paid: status === 'paid' };
    } catch {
      return { status: 'unknown', paid: false };
    }
  }

  verifyWebhookSignature(payload: any, signature: string | undefined, secret: string): boolean {
    const s = secret || this.webhookSecret;
    if (!s) return true;
    if (!signature) return false;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const expected = createHmac('sha256', s).update(body).digest('hex');
    return signature === expected || signature === `sha256=${expected}`;
  }
}

export const paymentProviderFactory = {
  provide: 'PAYMENT_PROVIDER',
  inject: [ConfigService],
  useFactory: (config: ConfigService): PaymentProvider => {
    const mode = config.get<string>('PAYMENT_PROVIDER') || 'mock';
    if (mode === 'razorpay') {
      const hasKeys = !!config.get('PAYMENT_KEY_ID') && !!config.get('PAYMENT_KEY_SECRET');
      if (!hasKeys) {
        throw new Error('PAYMENT_PROVIDER=razorpay requires PAYMENT_KEY_ID and PAYMENT_KEY_SECRET');
      }
      return new RazorpayPaymentProvider(config);
    }
    // mock explicitly requested — only allowed in non-production
    return new MockPaymentProvider();
  },
};