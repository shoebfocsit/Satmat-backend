# SATMAT Backend

Single shared NestJS + Prisma backend serving all three SATMAT apps:

| App | Path | Consumes |
|-----|------|----------|
| SATMAT Web (Next.js) | `web/` | full API (auth, wallet, bids, public reads) |
| SATMAT Website (Vite) | `Website/` | public reads only (markets, results, charts, rates, notices, stats) |

Base URL: `http://localhost:8080/api/v1`

> The Next.js web app (`web/`) is fully wired to this backend — every public
> endpoint (markets, results, charts, notices, game types/rates) is read live,
> with no mock or sample fallbacks. Swagger docs: `/api/v1/docs`.

---

## Requirements

- Node.js 18+ / 20+
- Docker (for local Postgres) **or** an existing Postgres instance

## Quick start

```bash
cd backend

# 1. Install deps
npm install

# 2. Start Postgres
docker compose up -d

# 3. Configure environment
cp .env.example .env   # then edit if needed

# 4. Create schema + seed
npx prisma migrate dev --name init
npm run db:seed

# 5. Run
npm run start:dev      # http://localhost:8080/api/v1
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run start:dev` | Watch mode dev server |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run compiled build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Jest unit tests |
| `npm run db:seed` | Seed markets / game types / rates / notices / admin |
| `npm run prisma:migrate` | Dev migration |

## Demo accounts (seeded)

| Role | Phone | Password |
|------|-------|----------|
| Admin | `+919527194409` | set via `ADMIN_PASSWORD` env |

New players self-register via `POST /auth/register` (gets a ₹25 welcome bonus).

## Environment variables

See `.env.example`. Key points:

- **Providers are mock by default** (`PAYMENT_PROVIDER=mock`, `SMS_PROVIDER=mock`,
  `PUSH_PROVIDER=mock`). Real Razorpay / MSG91 / FCM adapters can be swapped in
  later by flipping these and adding keys — no code change needed.
- `GEMINI_API_KEY` enables `/ai/chat`; if absent the endpoint degrades gracefully.
- OTP codes are **logged to the console** in mock mode (`[MOCK SMS] OTP for ...: 123456`).
- **Realtime scraper** — Results/Charts can be fed by a continuous scraper of
  `sattaindianmatka.com` panel charts (`SOURCE_ADAPTER=satmat-web`,
  `SCRAPE_ENABLED=true`). See [Realtime scraper](#realtime-scraper) below.

## Architecture

```
src/
  main.ts               bootstrap (prefix /api/v1, CORS, validation, global filter)
  app.module.ts         module wiring + global guards (throttler, JWT)
  common/
    cache/              in-memory cache (idempotency keys, OTP, exchange codes)
    decorators/         @Public, @CurrentUser, @Roles
    filters/            unified { error: { code, message, details } } shape
    guards/             JwtAuthGuard, RolesGuard
    interceptors/       IdempotencyInterceptor (money POSTs)
    providers/          Payment / SMS / Push provider adapters (mock)
  prisma/               PrismaService (Postgres)
  modules/
    auth users markets bids orders wallet notices content referral
    support notifications sync ai newsletter admin health
    charts/source/       source-adapter layer (sample + real scraper)
    scraper/             continuous realtime-fetch scheduler + admin endpoint
```

## Realtime scraper

Results & Charts are served exclusively from scraped provider data
(`SOURCE_ADAPTER=satmat-web`) — no sample or mock data exists anywhere.
A real scraper for the provider panel charts is included:

- **Adapter** — `satmat-web` (`charts/source/satmat-web.adapter.ts`). Fetches each
  configured market's panel chart with the axios client in
  `charts/source/scraper-http.ts` (proxy-aware, Cloudflare-interstitial aware),
  parses the week table into `[open panna | jodi | close panna]` and
  tags every record `source: "satmat-web"`. Undeclared days (`***` / empty cells)
  are skipped, never fabricated.
- **Scheduler** — `ScraperModule` runs a continuous fetch cycle on boot and then
  every `SCRAPE_INTERVAL_MS` (default 5 min) while `SCRAPE_ENABLED=true`. Each
  cycle re-scrapes the configured markets over a rolling `SCRAPE_WINDOW_DAYS`
  window and upserts into `ResultRecord`, `ChartRecord` and `Market.result`,
  **overwriting older sample rows** so live results are never shadowed.

```bash
# .env
SOURCE_ADAPTER=satmat-web     # serve real data on-demand via GET /charts
SCRAPE_ENABLED=true           # start the continuous scheduler
SCRAPE_INTERVAL_MS=300000
SCRAPE_WINDOW_DAYS=14
SCRAPE_MARKET_URLS={}         # JSON map: marketId -> provider panel-chart URL
```

`SCRAPE_MARKET_URLS` overrides the built-in default mapping (seeded market ids →
site chart URLs). Admin endpoints to inspect/trigger a cycle:

| Endpoint | Notes |
|----------|-------|
| `GET /admin/scrape/status` | last run, per-market record counts, last error |
| `POST /admin/scrape/run`   | run one cycle on demand |

> Respect the provider's robots.txt / ToS and rate limits. The scraper only runs
> server-side; frontends never touch the provider directly.

### Cross-cutting guarantees

- **Server-authoritative wallet** — every balance check / credit runs in a Prisma
  `$transaction`; client balance is never trusted for bid eligibility.
- **Idempotency** — money POSTs accept an `Idempotency-Key` header; retries are
  deduped (24h window).
- **Rate limits** — global throttler; tighter limits on bid/deposit/withdraw/OTP.
- **Error shape** — all errors return `{ error: { code, message, details } }`.
- **Money is stored as integer paise** (₹×100) to avoid float drift.

## Client SDKs (reference)

| File | Use |
|------|-----|
| `sdks/types.ts` | Shared TypeScript contracts (single source of truth) |
| `sdks/api-client.ts` | Typed fetch client for Web (Next.js) and Website (Vite) |

The Next.js web app uses its own typed client in `web/src/lib/api.ts`, which
follows the same contracts. The `sdks/` files remain as the canonical reference.

## Support chat (REST)

Replace the legacy WebSocket chat with simple REST polling:

- `POST /api/v1/support/chat/messages?ticketId=<id>` body `{ text }` → sends a message.
- `GET  /api/v1/support/chat/messages?ticketId=<id>` → list all messages for the ticket.

Both require `Authorization: Bearer <jwt>`. Clients should poll `GET` every 3–5s
to fetch new agent replies.

## Full API reference

Run the backend and open Swagger at `http://localhost:8080/api/v1/docs`.
Error responses always use the envelope
`{ "success": false, "error": { "code", "message" } }` (see
`src/common/filters/all-exceptions.filter.ts`).

## Production checklist

- `MANUAL_PAYMENTS` must be `false` (see `render.yaml`) — `true` settles
  deposits/withdrawals instantly with no gateway.
- `ADMIN_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `DATABASE_URL`,
  `DIRECT_URL`, `REDIS_URL` come from the host env dashboard, never git.
- `REDIS_URL` is required in production (OTP, idempotency, rate limits).
- Rotate any credential that was ever committed to git history.