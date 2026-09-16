import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { IsEmail } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../../common/decorators/public.decorator';

class SubscribeDto {
  @IsEmail()
  email: string;
}

@Controller('newsletter')
export class NewsletterController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Post('subscribe')
  @HttpCode(HttpStatus.CREATED)
  async subscribe(@Body() dto: SubscribeDto) {
    const existing = await this.prisma.newsletterSubscriber.findUnique({
      where: { email: dto.email },
    });
    if (!existing) {
      await this.prisma.newsletterSubscriber.create({ data: { email: dto.email } });
    }
    return { ok: true };
  }
}