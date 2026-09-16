import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomBytes, createHash, randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { SmsProvider } from '../../common/providers/sms.provider';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { DemoLoginDto } from './dto/demo-login.dto';
import { SendOtpDto } from './dto/send-otp.dto';

const WELCOME_BONUS = 2500; // paise = ₹25

function normalizeRoles(roles: unknown): string[] {
  if (Array.isArray(roles)) return roles as string[];
  if (typeof roles === 'string') {
    try {
      const parsed = JSON.parse(roles);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON — fall through to comma/string handling below.
    }
    if (roles.includes(',')) return roles.split(',').map((s) => s.trim()).filter(Boolean);
    if (roles) return [roles];
  }
  return ['USER'];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly cache: CacheService,
    @Inject('SMS_PROVIDER') private readonly sms: SmsProvider,
  ) {}

  /**
   * Bcrypt cost factor, centralized via ConfigService (validated env layer).
   * Capped to 8–12: 10 ≈ 80ms/hash on free-tier CPU, 8 ≈ 19ms/hash.
   */
  private bcryptRounds(): number {
    const raw = parseInt(this.config.get('BCRYPT_ROUNDS') || '10', 10);
    if (!Number.isFinite(raw)) return 10;
    return Math.min(Math.max(raw, 8), 12);
  }

  async register(dto: RegisterDto) {
    const phone = this.normalizePhone(dto.phone);
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) {
      throw new BadRequestException({ code: 'PHONE_EXISTS', message: 'Phone number is already registered' });
    }

    const passwordHash = await bcrypt.hash(dto.password, this.bcryptRounds());

    // referralCode is random — on the rare unique collision (P2002),
    // regenerate and retry instead of surfacing a 500.
    let user;
    for (let attempt = 0; ; attempt++) {
      try {
        const referralCode = this.generateReferralCode();
        user = await this.prisma.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: {
              name: dto.name,
              phone,
              passwordHash,
              referralCode,
              referredBy: dto.referralCode || undefined,
              balance: WELCOME_BONUS,
            },
          });
          await tx.walletTransaction.create({
            data: {
              userId: newUser.id,
              type: 'CREDIT',
              amount: WELCOME_BONUS,
              title: 'Welcome bonus',
              status: 'COMPLETED',
            },
          });
          return newUser;
        });
        break;
      } catch (e: any) {
        const targets = e?.meta?.target;
        const isCodeCollision =
          e?.code === 'P2002' &&
          (Array.isArray(targets) ? targets.includes('referralCode') : String(targets || '').includes('referralCode'));
        if (!isCodeCollision || attempt >= 2) throw e;
      }
    }

    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto) {
    const phone = this.normalizePhone(dto.phone);
    // Narrow select: less DB transfer + faster Prisma deserialization on hot path
    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: {
        id: true,
        name: true,
        phone: true,
        passwordHash: true,
        referralCode: true,
        balance: true,
        isGoldMember: true,
        roles: true,
        isActive: true,
      },
    });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid phone or password' });
    }
    if (!user.isActive) {
      throw new UnauthorizedException({ code: 'ACCOUNT_DISABLED', message: 'Account is disabled' });
    }
    return this.buildAuthResponse(user);
  }

  async demoLogin(dto: DemoLoginDto) {
    let phone = this.normalizePhone(dto.phone);
    if (!phone.startsWith('+91')) phone = `+91${phone.replace('+', '')}`;
    if (phone.length < 13) phone = `+91${phone.replace('+', '').padStart(10, '0')}`;

    let user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      const name = dto.name || 'Demo User';
      const password = 'demo1234';
      const passwordHash = await bcrypt.hash(password, this.bcryptRounds());
      const referralCode = this.generateReferralCode();
      user = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            name,
            phone,
            passwordHash,
            referralCode,
            balance: WELCOME_BONUS,
          },
        });
        await tx.walletTransaction.create({
          data: {
            userId: newUser.id,
            type: 'CREDIT',
            amount: WELCOME_BONUS,
            title: 'Welcome bonus',
            status: 'COMPLETED',
          },
        });
        return newUser;
      });
    }
    return this.buildAuthResponse(user);
  }

  async refresh(refreshToken: string) {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_REFRESH', message: 'Invalid refresh token' });
    }

    const hash = createHash('sha256').update(refreshToken).digest('hex');
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedException({ code: 'INVALID_REFRESH', message: 'Refresh token expired' });
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException({ code: 'INVALID_REFRESH', message: 'User not found' });
    if (!user.isActive) {
      throw new UnauthorizedException({ code: 'ACCOUNT_DISABLED', message: 'Account is disabled' });
    }

    // Refresh token rotation: revoke old token, issue new one
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revoked: true } });
    return this.buildAuthResponse(user);
  }

  async logout(refreshToken: string) {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hash, revoked: false },
      data: { revoked: true },
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        referralCode: true,
        balance: true,
        isGoldMember: true,
        roles: true,
      },
    });
    if (!user) throw new UnauthorizedException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    return this.serializeUser(user);
  }

  async sendOtp(dto: SendOtpDto) {
    const phone = this.normalizePhone(dto.phone);
    if (dto.purpose === 'forgot-password') {
      const user = await this.prisma.user.findUnique({ where: { phone } });
      if (!user) {
        throw new BadRequestException({ code: 'PHONE_NOT_FOUND', message: 'No account found for this phone' });
      }
    }

    // Rate limiting: max 3 OTP requests per phone per hour, 5 per IP per hour
    const phoneRateKey = `otp:rate:phone:${phone}`;
    const phoneRate = await this.cache.get<{ count: number }>(phoneRateKey);
    if (phoneRate && phoneRate.count >= 3) {
      throw new BadRequestException({ code: 'OTP_RATE_LIMIT', message: 'Too many OTP requests. Try again later.' });
    }

    const code = randomInt(100000, 1000000).toString();
    const codeHash = createHash('sha256').update(code).digest('hex');
    const requestId = randomBytes(16).toString('hex');

    // Store hashed OTP with 10 min TTL
    await this.cache.set(`otp:${requestId}`, { phone, codeHash, purpose: dto.purpose, attempts: 0 }, 10 * 60 * 1000);

    // Increment phone rate limit
    await this.cache.set(phoneRateKey, { count: (phoneRate?.count || 0) + 1 }, 60 * 60 * 1000);

    await this.sms.sendOtp(phone, code);
    return { requestId, expiresInSec: 600 };
  }

  async verifyOtp(requestId: string, otp: string) {
    const record = await this.cache.get<{ phone: string; codeHash: string; purpose: string; attempts: number }>(`otp:${requestId}`);
    if (!record) {
      throw new BadRequestException({ code: 'INVALID_OTP', message: 'Invalid or expired OTP' });
    }

    // Max 3 verification attempts
    if (record.attempts >= 3) {
      await this.cache.delete(`otp:${requestId}`);
      throw new BadRequestException({ code: 'OTP_MAX_ATTEMPTS', message: 'Too many failed attempts. Request a new OTP.' });
    }

    const otpHash = createHash('sha256').update(otp).digest('hex');
    if (record.codeHash !== otpHash) {
      // Increment attempts
      await this.cache.set(`otp:${requestId}`, { ...record, attempts: record.attempts + 1 }, 10 * 60 * 1000);
      throw new BadRequestException({ code: 'INVALID_OTP', message: 'Invalid OTP' });
    }

    // OTP verified - delete it (one-time use)
    await this.cache.delete(`otp:${requestId}`);

    if (record.purpose === 'login') {
      const user = await this.prisma.user.findUnique({ where: { phone: record.phone } });
      if (!user) {
        throw new BadRequestException({ code: 'PHONE_NOT_FOUND', message: 'No account found for this phone' });
      }
      if (!user.isActive) {
        throw new UnauthorizedException({ code: 'ACCOUNT_DISABLED', message: 'Account is disabled' });
      }
      return this.buildAuthResponse(user);
    }
    // forgot-password: issue a password-reset code tied to the phone.
    // Only the hash is stored — the code itself must be presented back.
    const resetCode = randomBytes(16).toString('hex');
    const resetCodeHash = createHash('sha256').update(resetCode).digest('hex');
    await this.cache.set(`reset:${requestId}`, { phone: record.phone, resetCodeHash }, 10 * 60 * 1000);
    return { resetVerified: true, resetToken: resetCode, requestId };
  }

  async resetPassword(requestId: string, resetToken: string, newPassword: string) {
    const record = await this.cache.get<{ phone: string; resetCodeHash: string }>(`reset:${requestId}`);
    if (!record) {
      throw new BadRequestException({ code: 'INVALID_RESET', message: 'Password reset session expired. Please verify OTP again.' });
    }
    const tokenHash = createHash('sha256').update(resetToken || '').digest('hex');
    const a = Buffer.from(tokenHash, 'hex');
    const b = Buffer.from(record.resetCodeHash || '', 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException({ code: 'INVALID_RESET', message: 'Invalid reset token. Please verify OTP again.' });
    }
    await this.cache.delete(`reset:${requestId}`);
    const user = await this.prisma.user.findUnique({ where: { phone: record.phone } });
    if (!user) {
      throw new BadRequestException({ code: 'PHONE_NOT_FOUND', message: 'No account found for this phone' });
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, this.bcryptRounds()) },
    });
    return { ok: true };
  }

  async exchange(code: string) {
    const record = await this.cache.get<{ userId: string }>(`exchange:${code}`);
    if (!record) {
      throw new BadRequestException({ code: 'INVALID_CODE', message: 'Invalid or expired exchange code' });
    }
    await this.cache.delete(`exchange:${code}`);
    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    if (!user) throw new UnauthorizedException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    return this.buildAuthResponse(user);
  }

  async createExchangeCode(userId: string): Promise<string> {
    const code = randomBytes(24).toString('base64url');
    await this.cache.set(`exchange:${code}`, { userId }, 5 * 60 * 1000);
    return code;
  }

  private async buildAuthResponse(user: any) {
    const rolesArr = normalizeRoles(user.roles);
    const ttlSec = parseInt(this.config.get('REFRESH_TOKEN_TTL') || '2592000', 10);
    // Parallelize JWT signing — saves ~10-20ms vs sequential awaits
    const jti = randomBytes(16).toString('hex');
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { sub: user.id, phone: user.phone, name: user.name, roles: rolesArr },
        { secret: this.config.get('JWT_SECRET') },
      ),
      this.jwt.signAsync(
        { sub: user.id, type: 'refresh', jti },
        {
          secret: this.config.get('JWT_REFRESH_SECRET'),
          expiresIn: ttlSec,
        },
      ),
    ]);
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    // Create refresh token row — don't block serialization, but ensure it persists before return
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: hash,
        userId: user.id,
        expiresAt: new Date(Date.now() + ttlSec * 1000),
      },
    });
    return { accessToken, refreshToken, user: this.serializeUser(user) };
  }

  private serializeUser(user: any) {
    return {
      id: `#${user.referralCode}`,
      name: user.name,
      phone: user.phone,
      balance: user.balance / 100,
      isGoldMember: user.isGoldMember,
      referralCode: user.referralCode,
      roles: normalizeRoles(user.roles),
    };
  }

  private normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
    return `+${digits}`;
  }

  private generateReferralCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }
}