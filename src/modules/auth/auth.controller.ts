import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { DemoLoginDto } from './dto/demo-login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ExchangeDto } from './dto/exchange.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Post('demo-login')
  @HttpCode(HttpStatus.OK)
  async demoLogin(@Body() dto: DemoLoginDto) {
    if (this.config.get('NODE_ENV') === 'production') {
      throw new BadRequestException({ code: 'DISABLED', message: 'Demo login is disabled in production' });
    }
    return this.auth.demoLogin(dto);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() dto: SendOtpDto) {
    return this.auth.sendOtp(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.requestId, dto.otp);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.requestId, dto.otp, dto.newPassword);
  }

  @Get('me')
  async me(@CurrentUser('id') userId: string) {
    return this.auth.me(userId);
  }

  @Post('exchange/issue')
  @HttpCode(HttpStatus.OK)
  async issueExchangeCode(@CurrentUser('id') userId: string) {
    return { code: await this.auth.createExchangeCode(userId) };
  }

  @Public()
  @Get('exchange')
  @HttpCode(HttpStatus.OK)
  async exchange(@Query() query: ExchangeDto) {
    return this.auth.exchange(query.code);
  }
}