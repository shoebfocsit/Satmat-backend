import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';

@Injectable()
export class SentryService {
  private readonly logger = new Logger(SentryService.name);
  private initialized = false;

  constructor(private readonly config: ConfigService) {}

  init(): void {
    const dsn = this.config.get<string>('SENTRY_DSN');
    const env = this.config.get<string>('NODE_ENV') || 'development';

    if (!dsn) {
      this.logger.log('Sentry DSN not configured - error tracking disabled');
      return;
    }

    Sentry.init({
      dsn,
      environment: env,
      tracesSampleRate: env === 'production' ? 0.1 : 1.0,
      // Don't send sensitive data
      beforeSend(event) {
        // Remove sensitive data from event
        if (event.request?.cookies) delete event.request.cookies;
        if (event.request?.headers?.authorization) delete event.request.headers.authorization;
        if (event.request?.data) {
          const data = event.request.data as Record<string, any>;
          const sensitiveKeys = ['password', 'token', 'secret', 'key', 'otp', 'refreshToken', 'accessToken'];
          for (const key of sensitiveKeys) {
            if (data[key]) data[key] = '[REDACTED]';
          }
        }
        return event;
      },
    });

    this.initialized = true;
    this.logger.log('Sentry initialized');
  }

  captureException(error: Error, context?: Record<string, any>): void {
    if (!this.initialized) return;
    Sentry.withScope((scope) => {
      if (context) {
        scope.setExtras(context);
      }
      Sentry.captureException(error);
    });
  }

  captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info', context?: Record<string, any>): void {
    if (!this.initialized) return;
    Sentry.withScope((scope) => {
      scope.setLevel(level);
      if (context) {
        scope.setExtras(context);
      }
      Sentry.captureMessage(message);
    });
  }

  setUserContext(user: { id: string; email?: string; username?: string } | null): void {
    if (!this.initialized) return;
    Sentry.setUser(user || null);
  }

  addBreadcrumb(breadcrumb: Sentry.Breadcrumb): void {
    if (!this.initialized) return;
    Sentry.addBreadcrumb(breadcrumb);
  }
}