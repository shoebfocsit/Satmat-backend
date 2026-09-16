import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { randomUUID } from 'crypto';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req: Request = context.switchToHttp().getRequest();
    const res: Response = context.switchToHttp().getResponse();

    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    const startTime = Date.now();

    // Attach requestId to request for use in controllers/services
    req['requestId'] = requestId;
    res.setHeader('x-request-id', requestId);

    const { method, url, ip } = req;
    const userAgent = req.get('user-agent') || '';

    this.logger.log(`→ ${method} ${url} - ${ip} - ${userAgent}`, requestId);

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startTime;
          this.logger.log(`← ${method} ${url} - ${res.statusCode} - ${duration}ms`, requestId);
        },
        error: (err: any) => {
          const duration = Date.now() - startTime;
          this.logger.error(`← ${method} ${url} - ${err?.status || 500} - ${duration}ms - ${err?.message || 'Error'}`, requestId);
        },
      }),
    );
  }
}