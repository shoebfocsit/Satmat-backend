import axios from 'axios';
import { Logger } from '@nestjs/common';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

const logger = new Logger('ScraperHttp');

/**
 * Backend-only HTTP client for scraping result providers.
 *
 * Single axios path (cloudscraper was removed: deprecated, unmaintained, and
 * it pulled `request` → `form-data` critical CVEs with no fix available — for
 * zero benefit, since cloudscraper 4.x cannot solve Cloudflare Turnstile /
 * Managed Challenge anyway). Provider fetches are stateless panel-chart GETs,
 * so no cookie jar is needed. All traffic happens exclusively server-side;
 * nothing ever runs inside a browser or CLI client.
 *
 * NOTE: Cloudflare Turnstile / Managed Challenge (the "Just a moment..."
 * interstitial with `challenges.cloudflare.com`) returns 403 and must be
 * handled by switching to a reachable mirror (e.g. dpbossss.com) or routing
 * through a residential proxy via SCRAPE_PROXY_URL. This client detects that
 * interstitial and surfaces an actionable error instead of silently retrying.
 */

export const SCRAPER_DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface FetchHtmlOptions {
  /** Politeness delay applied before the request (ms). */
  delayMs?: number;
  timeoutMs?: number;
  userAgent?: string;
  /**
   * Optional HTTP/HTTPS proxy URL (e.g. `http://user:pass@host:port`). When set,
   * the request routes through the proxy. Useful for providers whose Cloudflare
   * layer challenges datacenter IPs — the proxy's exit IP is used instead of
   * the server's, so the scrape succeeds.
   */
  proxyUrl?: string;
  /** Max retry attempts for transient failures (default: 2). */
  retries?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isCloudflareChallengeText(text: string): boolean {
  // Matches the Turnstile / Managed Challenge interstitial (returns 403 with
  // this HTML). Detected in prod as: title "Just a moment...", meta robots
  // noindex, challenges.cloudflare.com
  return (
    text.includes('Just a moment') ||
    text.includes('challenges.cloudflare.com') ||
    text.includes('Enable JavaScript and cookies to continue') ||
    text.includes('_cf_chl_opt') ||
    text.includes('cf_chl_tk')
  );
}

function isCloudflareError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return (
    msg.includes('403') &&
    (msg.includes('Just a moment') ||
      msg.includes('challenges.cloudflare.com') ||
      msg.includes('cloudflare') ||
      msg.includes('_cf_chl_opt') ||
      msg.includes('Enable JavaScript'))
  );
}

function isRetriable(err: unknown): boolean {
  // Cloudflare Turnstile is NOT retriable from the same datacenter IP — it will
  // fail identically on every retry and just waste cycle time.
  if (isCloudflareError(err)) return false;
  const msg = (err as Error)?.message ?? String(err);
  // Timeouts / 5xx / ECONNRESET are retriable.
  return (
    msg.includes('timeout') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  );
}

export async function fetchHtml(
  url: string,
  options: FetchHtmlOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRetries = options.retries ?? 2;
  const headers = {
    'User-Agent': options.userAgent ?? SCRAPER_DEFAULT_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  if (options.delayMs) await sleep(options.delayMs);

  const proxyUrl = options.proxyUrl?.trim() ? options.proxyUrl.trim() : undefined;
  const useProxy = !!proxyUrl;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Don't retry Cloudflare Turnstile at all — it will fail the same way.
      if (lastError && !isRetriable(lastError)) {
        break;
      }
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 5000);
      logger.warn(`retry ${attempt}/${maxRetries} for ${url} (waiting ${backoffMs}ms)`);
      await sleep(backoffMs);
    }

    try {
      const isHttps = url.startsWith('https:');
      const agent = proxyUrl
        ? isHttps
          ? new HttpsProxyAgent(proxyUrl)
          : new HttpProxyAgent(proxyUrl)
        : undefined;
      const res = await axios.get<string>(url, {
        ...(agent
          ? {
              httpsAgent: isHttps ? agent : undefined,
              httpAgent: !isHttps ? agent : undefined,
              proxy: false,
            }
          : {}),
        headers,
        timeout: timeoutMs,
        // 403 bodies carry the Cloudflare interstitial HTML — accept them so we
        // can detect it below instead of throwing a bare "status 403".
        validateStatus: (status) => status === 200 || status === 403,
      });
      if (isCloudflareChallengeText(res.data)) {
        throw new Error(
          'axios: 403 - Cloudflare Turnstile / Managed Challenge (Just a moment...). ' +
            'Fix: use a reachable mirror or set SCRAPE_PROXY_URL to a residential proxy.',
        );
      }
      if (res.status === 403) {
        throw new Error(`axios: 403 Forbidden for ${url} (no Cloudflare challenge markers in body)`);
      }
      return res.data;
    } catch (err) {
      lastError = err as Error;
      if (!isRetriable(err)) {
        break;
      }
    }
  }

  const proxyInfo = useProxy ? ' (via proxy)' : ' (direct)';
  const hint =
    lastError && isCloudflareError(lastError)
      ? ' — Cloudflare Turnstile blocked this datacenter IP. Fix: switch market to a mirror (dpbossss.com) or set SCRAPE_PROXY_URL.'
      : '';
  throw new Error(
    `scraper fetch failed after ${maxRetries + 1} attempts${proxyInfo} for ${url}${hint}: ${lastError?.message}`,
  );
}

/**
 * Quick proxy connectivity check. Returns the exit IP or throws.
 * Useful for verifying SCRAPE_PROXY_URL is working before a scrape cycle.
 */
export async function checkProxyIp(proxyUrl: string): Promise<string> {
  const agent = proxyUrl.startsWith('https')
    ? new HttpsProxyAgent(proxyUrl)
    : new HttpProxyAgent(proxyUrl);
  const res = await axios.get<{ origin: string }>(
    'https://httpbin.org/ip',
    {
      httpsAgent: agent,
      proxy: false,
      timeout: 10000,
    },
  );
  return res.data.origin;
}
