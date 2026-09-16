import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap, from, defer, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { CacheService } from '../cache/cache.service';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly cache: CacheService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req: Request = context.switchToHttp().getRequest();
    const res: Response = context.switchToHttp().getResponse();

    if (req.method !== 'POST') return next.handle();

    const key = (req.headers['idempotency-key'] as string) || '';
    if (!key) return next.handle();

    const userKey = (req as any).user?.id || 'anon';
    const cacheKey = `idem:${userKey}:${key}`;

    return defer(() => from(this.cache.get<{ status: number; body: any }>(cacheKey))).pipe(
      switchMap((cached) => {
        if (cached) {
          res.status(cached.status);
          return of(cached.body);
        }
        return next.handle().pipe(
          tap({
            next: (body) => {
              void this.cache.set(cacheKey, { status: res.statusCode, body }, IDEMPOTENCY_TTL_MS);
            },
          }),
        );
      }),
    );
  }
}