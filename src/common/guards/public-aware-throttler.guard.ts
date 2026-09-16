import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModuleOptions } from '@nestjs/throttler';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Custom ThrottlerGuard that skips rate-limiting for routes decorated
 * with @Public(). The built-in ThrottlerGuard only honours @SkipThrottle(),
 * so public endpoints (charts, results, health, etc.) were being throttled
 * alongside authenticated ones.  With a 60-req/min default, three frontends
 * loading simultaneously easily exhausted the limit and returned 429 errors,
 * causing the UIs to show "Backend offline — showing mock data".
 */
@Injectable()
export class PublicAwareThrottlerGuard extends ThrottlerGuard {
  private readonly reflector_: Reflector;

  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
    this.reflector_ = reflector;
  }

  async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector_.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Only safe GET endpoints skip throttling. State-changing public routes
    // (register, login, otp/*, newsletter/subscribe, webhooks) MUST stay
    // throttled — otherwise @Throttle() on them is dead and OTP/login
    // brute-force is unlimited.
    if (isPublic) {
      const req = context.switchToHttp().getRequest();
      if (req?.method === 'GET') return true;
    }
    return super.shouldSkip(context);
  }
}
