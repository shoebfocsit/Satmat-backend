import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, ArrayNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Inject } from '@nestjs/common';
import { PushProvider } from '../../common/providers/push.provider';

class ReadDto {
  @IsArray()
  @ArrayNotEmpty()
  ids: string[];
}

class RegisterDeviceDto {
  @IsString()
  deviceToken: string;

  @IsIn(['android', 'ios'])
  platform: 'android' | 'ios';
}

class ListQueryDto {
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;
}

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('PUSH_PROVIDER') private readonly push: PushProvider,
  ) {}

  @Get()
  async list(@CurrentUser('id') userId: string, @Query() query: ListQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);
    return {
      items: items.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        isRead: n.isRead,
        createdAt: n.createdAt.toISOString(),
      })),
      total,
    };
  }

  @Post('read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(@CurrentUser('id') userId: string, @Body() dto: ReadDto) {
    await this.prisma.notification.updateMany({
      where: { userId, id: { in: dto.ids } },
      data: { isRead: true },
    });
  }

  @Post('device')
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerDevice(@CurrentUser('id') userId: string, @Body() dto: RegisterDeviceDto) {
    await this.prisma.deviceToken.upsert({
      where: { userId_deviceToken: { userId, deviceToken: dto.deviceToken } },
      update: { platform: dto.platform },
      create: { userId, deviceToken: dto.deviceToken, platform: dto.platform },
    });
  }

  @Delete('device')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregisterDevice(@CurrentUser('id') userId: string, @Body() dto: { deviceToken: string }) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, deviceToken: dto.deviceToken } });
  }
}