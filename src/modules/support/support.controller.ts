import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

class CreateTicketDto {
  @IsString()
  @MaxLength(100)
  subject: string;

  @IsString()
  @MaxLength(2000)
  message: string;
}

class ChatMessageDto {
  @IsString()
  @MaxLength(2000)
  text: string;
}

@Controller('support')
export class SupportController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('tickets')
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser('id') userId: string, @Body() dto: CreateTicketDto) {
    const ticket = await this.prisma.supportTicket.create({
      data: {
        userId,
        subject: dto.subject,
        messages: { create: { text: dto.message, userId, fromUser: true } },
      },
    });
    return { ticketId: ticket.id };
  }

  @Get('tickets/:id/messages')
  async messages(@CurrentUser('id') userId: string, @Param('id') id: string) {
    const ticket = await this.prisma.supportTicket.findFirst({ where: { id, userId } });
    if (!ticket) return { messages: [] };
    const messages = await this.prisma.supportTicketMessage.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      messages: messages.map((m) => ({
        text: m.text,
        from: m.fromUser ? 'user' : 'agent',
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  @Post('chat/messages')
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(@CurrentUser('id') userId: string, @Body() dto: ChatMessageDto, @Query('ticketId') ticketId: string) {
    if (!ticketId) return { message: 'ticketId query parameter is required' };
    const ticket = await this.prisma.supportTicket.findFirst({ where: { id: ticketId, userId } });
    if (!ticket) return { error: 'Ticket not found' };
    const message = await this.prisma.supportTicketMessage.create({
      data: { ticketId, userId, text: dto.text, fromUser: true },
    });
    return { id: message.id, text: message.text, from: 'user', createdAt: message.createdAt.toISOString() };
  }

  @Get('chat/messages')
  async getMessages(@CurrentUser('id') userId: string, @Query('ticketId') ticketId: string) {
    if (!ticketId) return { messages: [] };
    const ticket = await this.prisma.supportTicket.findFirst({ where: { id: ticketId, userId } });
    if (!ticket) return { messages: [] };
    const messages = await this.prisma.supportTicketMessage.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      messages: messages.map((m) => ({
        id: m.id,
        text: m.text,
        from: m.fromUser ? 'user' : 'agent',
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }
}