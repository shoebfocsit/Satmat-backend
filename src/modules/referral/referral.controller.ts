import { Controller, Get, Post, Body } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IsString } from 'class-validator';

class ClaimDto {
  @IsString()
  inviteePhone: string;
}

@Controller('referral')
export class ReferralController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@CurrentUser('id') userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const referrals = await this.prisma.referral.findMany({ where: { referrerId: userId } });
    const totalEarned = referrals.filter((r) => r.bonusCredited).length * 1000;
    return {
      code: user?.referralCode,
      totalReferrals: referrals.length,
      totalEarned: totalEarned / 100,
      link: `${process.env.APP_URL || 'http://localhost:3000'}/register?ref=${user?.referralCode}`,
    };
  }

  private normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
    return `+${digits}`;
  }

  @Post('claim')
  async claim(@CurrentUser('id') userId: string, @Body() dto: ClaimDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { bonusCredited: false };
    const inviteePhone = this.normalizePhone(dto.inviteePhone);
    const invitee = await this.prisma.user.findUnique({ where: { phone: inviteePhone } });
    if (!invitee) return { bonusCredited: false };
    if (user.phone === invitee.phone) return { bonusCredited: false, reason: 'Cannot refer yourself' };
    if (invitee.referredBy !== user.referralCode) return { bonusCredited: false, reason: 'Invitee did not use your referral code' };

    const bonus = 1000;
    try {
      await this.prisma.$transaction(async (tx) => {
        // Check inside tx — eliminates the read-before-write race where two
        // concurrent requests both see "no existing referral" and both credit.
        const existing = await tx.referral.findFirst({
          where: { referrerId: userId, inviteePhone: invitee.phone },
        });
        if (existing) return;

        await tx.user.update({ where: { id: userId }, data: { balance: { increment: bonus } } });
        await tx.walletTransaction.create({
          data: {
            userId,
            type: 'CREDIT',
            amount: bonus,
            title: `Referral bonus for ${invitee.name}`,
            status: 'COMPLETED',
          },
        });
        await tx.referral.create({
          data: { referrerId: userId, inviteePhone: invitee.phone, bonusCredited: true },
        });
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return { bonusCredited: false, reason: 'Already claimed' };
      throw e;
    }
    return { bonusCredited: true, bonus: bonus / 100 };
  }
}