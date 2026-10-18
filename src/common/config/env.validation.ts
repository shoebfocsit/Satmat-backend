const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

const OPTIONAL_ENUMS: Record<string, string[]> = {
  PAYMENT_PROVIDER: ['mock', 'razorpay'],
  SMS_PROVIDER: ['mock', 'msg91', 'twilio'],
  PUSH_PROVIDER: ['mock', 'fcm'],
  SOURCE_ADAPTER: ['satmat-web'],
  NODE_ENV: ['development', 'production', 'test'],
};

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const isProd = config.NODE_ENV === 'production';
  const errors: string[] = [];

  if (isProd) {
    for (const key of REQUIRED_IN_PRODUCTION) {
      const val = config[key];
      if (!val || String(val).trim() === '') {
        errors.push(`${key} is required in production`);
      }
    }
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      const val = String(config[key] || '');
      if (val && val.length < 32) {
        errors.push(`${key} must be at least 32 characters in production (got ${val.length})`);
      }
      if (val.includes('change-me')) {
        errors.push(`${key} still contains default placeholder value`);
      }
    }
    const dbUrl = String(config.DATABASE_URL || '');
    const isSqlite = dbUrl.startsWith('file:');
    if (dbUrl && !isSqlite && !dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
      errors.push('DATABASE_URL must be a valid postgresql:// or file: (SQLite) URL');
    }
    if (dbUrl.includes('localhost') && String(config.SUPABASE_URL || '') === '') {
      // warn only, not error - localhost DB is okay for dev but suspicious in prod
    }
    // Single-DB Supabase: DIRECT_URL (direct 5432) is required in prod when
    // DATABASE_URL uses pgbouncer (pooler 6543). Migrations run via DIRECT_URL.
    const directUrl = String(config.DIRECT_URL || '');
    if (isProd) {
      if (dbUrl.includes('pgbouncer=true') && !directUrl) {
        errors.push('DIRECT_URL is required in production when DATABASE_URL uses pgbouncer (Supabase pooler)');
      }
      if (directUrl && !directUrl.startsWith('postgresql://') && !directUrl.startsWith('postgres://')) {
        errors.push('DIRECT_URL must be a valid postgresql:// URL');
      }
      if (directUrl && directUrl.includes('pgbouncer=true')) {
        errors.push('DIRECT_URL must be direct connection (port 5432), not pooler (pgbouncer=true belongs only in DATABASE_URL)');
      }
    }
  }

  for (const [key, allowed] of Object.entries(OPTIONAL_ENUMS)) {
    const val = config[key];
    if (val != null && String(val) !== '' && !allowed.includes(String(val))) {
      errors.push(`${key} must be one of ${allowed.join(', ')} (got ${String(val)})`);
    }
  }

  // Real-provider keys required when provider=real (fail fast, no silent mock fallback)
  const paymentProvider = String(config.PAYMENT_PROVIDER || '');
  if (paymentProvider === 'razorpay') {
    if (!config.PAYMENT_KEY_ID) errors.push('PAYMENT_KEY_ID required when PAYMENT_PROVIDER=razorpay');
    if (!config.PAYMENT_KEY_SECRET) errors.push('PAYMENT_KEY_SECRET required when PAYMENT_PROVIDER=razorpay');
    if (!config.PAYMENT_WEBHOOK_SECRET) errors.push('PAYMENT_WEBHOOK_SECRET required when PAYMENT_PROVIDER=razorpay');
  }
  if (paymentProvider === 'mock' && isProd) {
    // Mock is allowed to boot for initial staging/verification. Replace with razorpay
    // (and PAYMENT_KEY_ID/SECRET/WEBHOOK_SECRET) before enabling real deposits.
  }

  const smsProvider = String(config.SMS_PROVIDER || '');
  if (smsProvider === 'msg91') {
    if (!config.MSG91_AUTH_KEY) errors.push('MSG91_AUTH_KEY required when SMS_PROVIDER=msg91');
    if (!config.SMS_SENDER_ID) errors.push('SMS_SENDER_ID required when SMS_PROVIDER=msg91');
  } else if (smsProvider === 'twilio') {
    if (!config.TWILIO_SID) errors.push('TWILIO_SID required when SMS_PROVIDER=twilio');
    if (!config.TWILIO_AUTH_TOKEN) errors.push('TWILIO_AUTH_TOKEN required when SMS_PROVIDER=twilio');
    if (!config.TWILIO_FROM) errors.push('TWILIO_FROM required when SMS_PROVIDER=twilio');
  }
  if (smsProvider === 'mock' && isProd) {
    // Mock is allowed to boot for initial staging/verification. Replace with msg91 or
    // twilio (and their keys) before real OTP delivery matters.
  }

  const pushProvider = String(config.PUSH_PROVIDER || '');
  if (pushProvider === 'fcm') {
    const hasKey = !!config.FCM_SERVER_KEY || !!config.FCM_SERVICE_ACCOUNT_JSON;
    if (!hasKey) errors.push('FCM_SERVER_KEY or FCM_SERVICE_ACCOUNT_JSON required when PUSH_PROVIDER=fcm');
    if (!config.FCM_PROJECT_ID) errors.push('FCM_PROJECT_ID required when PUSH_PROVIDER=fcm');
  }
  if (pushProvider === 'mock' && isProd) {
    // Mock is allowed to boot for initial staging/verification. Replace with fcm (and
    // FCM_PROJECT_ID + FCM_SERVICE_ACCOUNT_JSON) before real push notifications.
  }

  if (String(config.SOURCE_ADAPTER || '') === 'satmat-web' && String(config.SCRAPE_ENABLED || '') === 'true') {
    // SCRAPE_MARKET_URLS is optional (defaults baked in), but warn if REDIS_URL missing for multi-instance
  }

  const port = config.PORT;
  if (port != null && String(port) !== '') {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      errors.push(`PORT must be integer 1-65535 (got ${String(port)})`);
    }
  }

  // Bcrypt cost factor is read centrally via ConfigService (AuthService).
  // Validate range here so a typo (e.g. 100) fails fast instead of hanging auth.
  const rounds = config.BCRYPT_ROUNDS;
  if (rounds != null && String(rounds) !== '') {
    const n = Number(rounds);
    if (!Number.isInteger(n) || n < 4 || n > 15) {
      errors.push(`BCRYPT_ROUNDS must be integer 4-15 (got ${String(rounds)})`);
    }
  }

  // Validate CORS_ORIGINS as comma-separated URLs or empty.
  // A bare hostname (no scheme) is accepted and treated as https:// so a value
  // like "satmat-web.onrender.com" or a bare "satmat-web" hostname passes.
  //
  // Invalid entries (typos, stray spaces, etc.) are WARNED and dropped instead
  // of crashing the whole API. CORS is a security feature, but one bad origin
  // in the list should not take down the service for every other client.
  const cors = String(config.CORS_ORIGINS || '');
  if (cors) {
    const sanitized: string[] = [];
    for (const rawOrigin of cors.split(',')) {
      const origin = rawOrigin.trim();
      if (!origin) continue;
      if (origin === '*') {
        if (isProd) {
          errors.push('CORS_ORIGINS=* not allowed in production');
          continue;
        }
        sanitized.push('*');
        continue;
      }
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(origin) ? origin : `https://${origin}`;
      try {
        new URL(candidate);
        sanitized.push(origin);
      } catch {
        console.warn(`[env] CORS_ORIGINS dropping invalid origin: "${rawOrigin}"`);
      }
    }
    if (sanitized.length > 0) {
      config.CORS_ORIGINS = sanitized.join(',');
    }
  }

  // Validate Redis URL format
  const redisUrl = String(config.REDIS_URL || '');
  if (redisUrl && !redisUrl.startsWith('redis://') && !redisUrl.startsWith('rediss://')) {
    errors.push('REDIS_URL must be a valid redis:// or rediss:// URL');
  }

  // Validate APP_URL format. A bare hostname is accepted and treated as https://.
  const appUrl = String(config.APP_URL || '');
  if (appUrl) {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(appUrl) ? appUrl : `https://${appUrl}`;
    try {
      new URL(candidate);
    } catch {
      errors.push('APP_URL must be a valid URL');
    }
  }

  if (errors.length) {
    throw new Error(`Environment validation failed:\n - ${errors.join('\n - ')}`);
  }

  return config;
}
