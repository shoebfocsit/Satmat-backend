import {
  BadRequestException,
  Body,
  Controller,
  Patch,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Controller('auth')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Patch('me')
  async updateMe(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    const data: any = {};
    if (dto.name) data.name = dto.name;
    if (dto.phone) {
      const digits = dto.phone.replace(/\D/g, '');
      const phone = digits.length === 10 ? `+91${digits}` : `+${digits}`;
      const existing = await this.prisma.user.findUnique({ where: { phone } });
      if (existing && existing.id !== userId) {
        throw new BadRequestException({ code: 'PHONE_EXISTS', message: 'Phone number is already in use' });
      }
      data.phone = phone;
    }
    const user = await this.prisma.user.update({ where: { id: userId }, data });
    return {
      id: `#${user.referralCode}`,
      name: user.name,
      phone: user.phone,
      balance: user.balance / 100,
      isGoldMember: user.isGoldMember,
      referralCode: user.referralCode,
      roles: user.roles,
    };
  }
}