import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import compression from 'compression';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ConfigService } from '@nestjs/config';

/**
 * Canonicalize an origin for allowlist comparison: trim, drop trailing slash,
 * assume https:// for bare hostnames (matches env.validation.ts handling).
 * Returns null when the value cannot be interpreted as an origin.
 */
function normalizeOrigin(raw: string): string | null {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Lowercase hostname of an origin-like string, or null when unparseable. */
function hostOf(origin: string): string | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(origin) ? origin : `https://${origin}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function maskDbUrl(url: string): string {
  try {
    const u = new URL(String(url || ''));
    const host = u.host;
    const hasPgbouncer = String(url).includes('pgbouncer=true') ? ' +pgbouncer' : '';
    const port = u.port ? `:${u.port}` : '';
    return `${u.protocol}//***@${host}${port}${u.pathname}${hasPgbouncer}`;
  } catch {
    const s = String(url || '');
    return s ? s.slice(0, 30) + '...' : '(empty)';
  }
}

async function bootstrap() {
  // Pre-log masked DB targets so Render logs show which host is being dialled even if app crashes before Nest logger starts
  console.log(`[Bootstrap] NODE_ENV=${process.env.NODE_ENV} PORT=${process.env.PORT || 8080}`);
  console.log(`[Bootstrap] DATABASE_URL=${maskDbUrl(process.env.DATABASE_URL || '')}`);
  console.log(`[Bootstrap] DIRECT_URL=${maskDbUrl(process.env.DIRECT_URL || '')}`);
  console.log(`[Bootstrap] REDIS_URL=${process.env.REDIS_URL ? process.env.REDIS_URL.split('@').pop()?.slice(-30) || '(set)' : '(empty)'}`);
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

  // Trust proxy when behind Nginx/Cloudflare/ELB
  const httpAdapter = app.getHttpAdapter();
  const instance: any = httpAdapter.getInstance();
  if (instance?.set) instance.set('trust proxy', 1);

  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: false,
    }),
  );
  // Faster JSON + compression: lower threshold to 512b to compress auth responses faster,
  // and use level 6 (default is 6) explicitly for predictable latency.
  app.use(compression({ threshold: 512, level: 6 }));
  // Disable etag generation for auth routes (saves a few ms hashing bodies)
  if (instance?.disable) instance.disable('etag');
  // Tune keep-alive to survive Vercel -> Render proxy idle timeouts (~60s on Render)
  // Without this, the proxy closes the socket after each request and next request
  // pays TCP+TLS handshake (80-120ms).
  if (instance?.keepAliveTimeout !== undefined) {
    // Will be applied after listen via server object; set early hint
  }

  // CORS allowlist: this API authenticates with per-request Bearer tokens
  // (Authorization header) — there are NO session cookies anywhere, so CORS is
  // defense-in-depth rather than the auth boundary, but reflecting *every*
  // origin is still needlessly permissive. Allowed browser origins are:
  //   1. exact entries in CORS_ORIGINS (comma-separated, bare hostnames OK),
  //   2. any *.vercel.app host (prod + preview deployments get fresh hostnames),
  //   3. localhost / 127.0.0.1 / [::1] over http(s) (local dev, any port),
  //   4. requests with NO Origin header (curl, mobile apps, server-to-server).
  // Everything else gets no ACAO header (browser blocks, no 500). Denied
  // origins are logged as warnings so a missing entry is debuggable — add it
  // to CORS_ORIGINS in the host dashboard, no code change needed.
  // credentials stay OFF: browsers never send cookies, CSRF surface unchanged.
  const corsExact = new Set(
    String(config.get<string>('CORS_ORIGINS') || '')
      .split(',')
      .map((s) => normalizeOrigin(s))
      .filter((s): s is string => !!s),
  );
  const corsLogger = new Logger('Cors');
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // non-browser: no CORS to enforce
      const normalized = normalizeOrigin(origin);
      if (normalized && corsExact.has(normalized)) return cb(null, true);
      const host = hostOf(normalized || origin);
      if (host && (host.endsWith('.vercel.app') || host.endsWith('.vercel.com'))) {
        return cb(null, true);
      }
      if (normalized && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(normalized)) {
        return cb(null, true);
      }
      corsLogger.warn(`CORS denied for origin: ${origin} (add to CORS_ORIGINS if legitimate)`);
      return cb(null, false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'x-webhook-signature'],
    exposedHeaders: ['Content-Length'],
  });

  // Keep root /health (and the bare root "/") outside the prefix for LB probes
  // and quick sanity checks; the controller also aliases /api/v1/health.
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'api/v1/health', '/'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const enableDocs =
    config.get<string>('ENABLE_SWAGGER') === 'true' ||
    config.get<string>('NODE_ENV') !== 'production';
  if (enableDocs) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('SATMAT API')
      .setDescription('Shared backend for SATMAT Web, Mobile and Website apps')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/v1/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log('Swagger docs enabled at /api/v1/docs');
  }

  const port = Number(config.get<string>('PORT') || 8080);
  await app.listen(port, '0.0.0.0');
  // Tune Node HTTP keep-alive to exceed Render's load-balancer timeout (65s)
  // so Vercel's Next.js proxy can reuse a single TLS connection for all /api/* calls.
  const server: any = app.getHttpServer();
  if (server) {
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    // Also bump max header size for JWT (large bearer tokens)
    if (server.maxHeaderSize === undefined) server.maxHeaderSize = 16384;
  }
  logger.log(`SATMAT backend listening on 0.0.0.0:${port}/api/v1 (env=${config.get('NODE_ENV')})`);
  if (enableDocs) logger.log(`Swagger docs on http://localhost:${port}/api/v1/docs`);
}
bootstrap().catch((err) => {
  console.error('Failed to start SATMAT backend');
  console.error('ERROR_NAME:', (err as any)?.name);
  console.error('ERROR_MESSAGE:', (err as any)?.message);
  console.error('ERROR_STACK:', (err as any)?.stack);
  try { console.error('ERROR_FULL:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2).slice(0, 8000)); } catch { void 0; }
  // Ensure logs flush before exit so Render captures them (was truncating before)
  setTimeout(() => process.exit(1), 800);
});