import { Body, Controller, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { IsOptional, IsString } from 'class-validator';

class ChatDto {
  @IsString()
  prompt: string;

  @IsOptional()
  @IsString()
  context?: string;
}

@Controller('ai')
export class AiController {
  private genAI: GoogleGenerativeAI | null = null;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get('GEMINI_API_KEY');
    if (key) this.genAI = new GoogleGenerativeAI(key);
  }

  @Post('chat')
  async chat(@Body() dto: ChatDto) {
    if (!this.genAI) {
      return { reply: 'AI support is currently unavailable. Please contact support.' };
    }
    try {
      // gemini-1.5-flash is deprecated (404) – use current stable 2.5-flash (verified with all 3 provided keys)
      const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const prompt = dto.context ? `${dto.context}\n\n${dto.prompt}` : dto.prompt;
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      return { reply: text };
    } catch {
      return { reply: 'Sorry, I could not generate a response right now. Please try again.' };
    }
  }
}