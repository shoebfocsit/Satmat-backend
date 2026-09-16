import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { MemoryCache } from '../../common/cache/memory-cache';

describe('AuthService', () => {
  let service: AuthService;

  const mockUser = {
    id: 'u1',
    name: 'Player',
    phone: '+919999999999',
    passwordHash: '$2a$10$mockhashmockhashmockhashmockhashmockhashmockhash',
    balance: 2500,
    isGoldMember: false,
    referralCode: 'ABC123',
    roles: ['player'],
    isActive: true,
  };

  const prisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    refreshToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    walletTransaction: {
      create: jest.fn(),
    },
    // Mirrors Prisma's $transaction callback API used by register/demoLogin
    $transaction: jest.fn(async (cb: any) =>
      cb({
        user: {
          findUnique: (...a: any[]) => (prisma.user.findUnique as jest.Mock)(...a),
          create: (...a: any[]) => (prisma.user.create as jest.Mock)(...a),
          update: (...a: any[]) => (prisma.user.update as jest.Mock)(...a),
        },
        walletTransaction: {
          create: (...a: any[]) => (prisma.walletTransaction.create as jest.Mock)(...a),
        },
      }),
    ),
  };

  const mockCache = {
    set: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(undefined),
    has: jest.fn().mockResolvedValue(false),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string, d?: any) =>
              ({ JWT_SECRET: 's', JWT_REFRESH_SECRET: 'r', REFRESH_TOKEN_TTL: '2592000' })[k] ?? d,
          },
        },
        { provide: JwtService, useValue: { signAsync: jest.fn().mockResolvedValue('token'), verifyAsync: jest.fn() } },
        { provide: CacheService, useValue: mockCache },
        { provide: MemoryCache, useValue: new MemoryCache() },
        { provide: 'SMS_PROVIDER', useValue: { sendOtp: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('me', () => {
    it('returns serialized user with balance in rupees', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      const result = await service.me('u1');
      expect(result.balance).toBe(25);
      expect(result.id).toBe('#ABC123');
    });

    it('throws if user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.me('missing')).rejects.toThrow();
    });
  });

  describe('register', () => {
    it('rejects duplicate phone', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      await expect(
        service.register({ name: 'X', phone: '9999999999', password: 'pass1234' }),
      ).rejects.toThrow('already registered');
    });

    it('creates a new user with a welcome bonus', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ ...mockUser, balance: 2500 });
      const result = await service.register({ name: 'X', phone: '9999999999', password: 'pass1234' });
      expect(result.user.balance).toBe(25);
      const createArgs = prisma.user.create.mock.calls[0][0];
      expect(createArgs.data.balance).toBe(2500); // welcome bonus in paise
    });
  });
});