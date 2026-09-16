import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { SentryService } from './sentry.service';

@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  constructor(private readonly sentry: SentryService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();

    // Only report 5xx errors to Sentry
    if (exception instanceof Error) {
      const status = (exception as any).status || (exception as any).getStatus?.() || 500;
      if (status >= 500) {
        this.sentry.captureException(exception, {
          url: request.url,
          method: request.method,
          userId: request.user?.id,
          requestId: request.requestId,
        });
      }
    }
    // Re-throw so the global AllExceptionsFilter still sends the HTTP response.
    // Without this the request hangs until client timeout.
    throw exception;
  }
}