import { Controller, Get, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ListOrdersQueryDto } from './dto/orders.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser('id') userId: string, @Query() query: ListOrdersQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where: { userId } }),
    ]);
    return {
      items: items.map((o) => ({
        id: o.id,
        marketName: o.marketName,
        amount: o.amount / 100,
        status: o.status,
        type: o.type,
        date: o.createdAt.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }
}