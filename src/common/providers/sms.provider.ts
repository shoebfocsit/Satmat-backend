import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

@Injectable()
export class MockSmsProvider implements SmsProvider {
  private readonly logger = new Logger(MockSmsProvider.name);
  async sendOtp(phone: string, code: string): Promise<void> {
    this.logger.log(`[MOCK SMS] OTP for ${phone}: ${code}`);
  }
}

@Injectable()
export class Msg91SmsProvider implements SmsProvider {
  private readonly logger = new Logger(Msg91SmsProvider.name);
  private readonly apiKey: string;
  private readonly senderId: string;
  private readonly templateId: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = config.get<string>('MSG91_AUTH_KEY') || '';
    this.senderId = config.get<string>('SMS_SENDER_ID') || 'SATMAT';
    this.templateId = config.get<string>('SMS_TEMPLATE_ID') || '';
    if (!this.apiKey) {
      this.logger.warn('MSG91_AUTH_KEY not configured');
    }
  }

  async sendOtp(phone: string, code: string): Promise<void> {
    try {
      await axios.post(
        'https://control.msg91.com/api/v5/otp',
        {
          template_id: this.templateId || undefined,
          mobile: phone.replace('+', ''),
          otp: code,
          sender: this.senderId,
        },
        { headers: { authkey: this.apiKey, 'Content-Type': 'application/json' }, timeout: 5000 },
      );
    } catch (e: any) {
      this.logger.error(`MSG91 SMS send failed: ${e?.response?.data?.message || e.message}`);
      throw e;
    }
  }
}

@Injectable()
export class TwilioSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TwilioSmsProvider.name);
  private readonly sid: string;
  private readonly token: string;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.sid = config.get<string>('TWILIO_SID') || '';
    this.token = config.get<string>('TWILIO_AUTH_TOKEN') || '';
    this.from = config.get<string>('TWILIO_FROM') || '';
    if (!this.sid || !this.token) {
      this.logger.warn('Twilio credentials not configured');
    }
  }

  async sendOtp(phone: string, code: string): Promise<void> {
    try {
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`,
        new URLSearchParams({ To: phone, From: this.from, Body: `Your SATMAT OTP is ${code}. Valid 10 min.` }),
        { auth: { username: this.sid, password: this.token }, timeout: 5000 },
      );
    } catch (e: any) {
      this.logger.error(`Twilio SMS send failed: ${e?.response?.data?.message || e.message}`);
      throw e;
    }
  }
}

export const smsProviderFactory = {
  provide: 'SMS_PROVIDER',
  inject: [ConfigService],
  useFactory: (config: ConfigService): SmsProvider => {
    const mode = config.get<string>('SMS_PROVIDER') || 'mock';
    if (mode === 'msg91') {
      const hasKey = !!config.get('MSG91_AUTH_KEY');
      if (!hasKey) {
        throw new Error('SMS_PROVIDER=msg91 requires MSG91_AUTH_KEY');
      }
      return new Msg91SmsProvider(config);
    }
    if (mode === 'twilio') {
      const hasKey = !!config.get('TWILIO_SID') && !!config.get('TWILIO_AUTH_TOKEN');
      if (!hasKey) {
        throw new Error('SMS_PROVIDER=twilio requires TWILIO_SID and TWILIO_AUTH_TOKEN');
      }
      return new TwilioSmsProvider(config);
    }
    // mock explicitly requested — only allowed in non-production
    return new MockSmsProvider();
  },
};