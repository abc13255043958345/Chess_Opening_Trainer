// Throttled, disk-cached HTTP GET used by every API client in the pipeline.
//
// - Every response (status + body text) is cached on disk keyed by sha1(url), so
//   re-running the pipeline against the same positions costs no network calls.
// - Live requests to the same host are spaced at least CONFIG.perHostDelayMs[host]
//   (falling back to CONFIG.requestDelayMs) apart, doubling adaptively after 429s.
// - HTTP 429 waits 65s (or Retry-After, whichever is longer) and retries, up to
//   opts.max429Retries times (default 5; cloudeval.mjs passes 1 - see its header
//   comment and evals.mjs's circuit breaker). A persistent 429 throws with
//   `err.persistentRateLimit = true` rather than a generic Error. Network errors
//   retry twice with linear backoff, then throw.
// - 429 responses are never disk-cached (only the final `return entry` below
//   writes the cache, and it's unreachable from the 429 branch) - a rate-limit
//   ban must never look like a cached "this position has no data" result.
//
// NOTE (flagged deviation, see build-content.mjs / final report): as of this
// build, the Lichess Opening Explorer (explorer.lichess.ovh) requires an
// authenticated request (HTTP 401 for anonymous calls to /masters, /lichess,
// /player - see https://lichess.org/@/thibault/blog/the-opening-explorer-now-requires-authentication/FSWh9Zg3
// and the `security: [OAuth2: []]` block on those endpoints in the lichess-org/api
// spec). This was not the case when DESIGN.md was written. This module supports
// an optional LICHESS_TOKEN environment variable; when set, its value is sent as
// `Authorization: Bearer <token>` on every request (explorer.mjs relies on this).
// Cloud-eval and the raw.githubusercontent.com catalog fetch remain anonymous.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "cache", "http");

/** Live-request / cache-hit counters, read by build-content.mjs for the final report. */
export const counters = { liveRequests: 0, cacheHits: 0 };

const lastRequestAtByHost = new Map();
// Per-host delay multiplier, doubled after every 429 (capped) so sustained runs
// self-tune to whatever rate the API actually tolerates.
const delayMultiplierByHost = new Map();
const MAX_DELAY_MULTIPLIER = 8;

/** Hosts that get `Authorization: Bearer <LICHESS_TOKEN>` when the env var is set.
 *  Authenticated lichess.org requests get materially higher rate limits. */
const LICHESS_HOSTS = new Set(["lichess.org", "explorer.lichess.ovh"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cachePathFor(url) {
  const key = createHash("sha1").update(url).digest("hex");
  return path.join(CACHE_DIR, `${key}.json`);
}

async function readCache(url) {
  try {
    const raw = await readFile(cachePathFor(url), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(url, entry) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePathFor(url), JSON.stringify(entry), "utf8");
}

/** Base per-host delay (ms) before the adaptive 429 multiplier is applied. */
function baseDelayForHost(host) {
  return CONFIG.perHostDelayMs?.[host] ?? CONFIG.requestDelayMs;
}

async function throttle(host) {
  const multiplier = delayMultiplierByHost.get(host) ?? 1;
  const last = lastRequestAtByHost.get(host) ?? 0;
  const wait = last + baseDelayForHost(host) * multiplier - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAtByHost.set(host, Date.now());
}

/**
 * Throttled, disk-cached GET. A cache hit skips both the network call and the
 * per-host throttle delay entirely.
 * @param {string} url
 * @param {{headers?: Record<string,string>, max429Retries?: number, skipNetworkIfMiss?: boolean}} [opts]
 *   max429Retries caps how many times a 429 is retried before giving up (each
 *   retry waits out a full lichess ban window, so callers hitting a host
 *   that's known to be hostile - e.g. cloud-eval, see cloudeval.mjs - should
 *   pass a low number rather than eating the default's multi-minute cost).
 *   skipNetworkIfMiss: on a cache miss, return null instead of ever touching
 *   the network - lets a caller with its own circuit breaker (see
 *   explorer.mjs) skip straight past a host it has already given up on for
 *   this run, without paying max429Retries all over again on every single
 *   uncached position.
 * @returns {Promise<{url: string, status: number, body: string} | null>}
 */
export async function httpGet(url, opts = {}) {
  const max429Retries = opts.max429Retries ?? 5;
  const cached = await readCache(url);
  if (cached) {
    counters.cacheHits++;
    return cached;
  }
  if (opts.skipNetworkIfMiss) return null;

  const host = new URL(url).host;
  let networkAttempt = 0;
  let rateLimitAttempt = 0;

  const headers = { ...(opts.headers ?? {}) };
  if (LICHESS_HOSTS.has(host) && process.env.LICHESS_TOKEN && !headers.Authorization) {
    headers.Authorization = `Bearer ${process.env.LICHESS_TOKEN}`;
  }

  for (;;) {
    await throttle(host);

    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      networkAttempt++;
      if (networkAttempt > 2) {
        throw new Error(`Network error fetching ${url}: ${err.message}`);
      }
      await sleep(500 * networkAttempt);
      continue;
    }

    counters.liveRequests++;

    if (res.status === 429) {
      rateLimitAttempt++;
      // Drain the body so the connection can be reused/closed cleanly.
      await res.text().catch(() => {});
      if (rateLimitAttempt > max429Retries) {
        // Tagged so callers (see evals.mjs's circuit breaker) can catch this
        // specific case without string-matching the message.
        const err = new Error(`Persistent HTTP 429 from ${url} after ${max429Retries} retries`);
        err.persistentRateLimit = true;
        err.host = host;
        throw err;
      }
      // Back off this host for the rest of the run, and wait out the ban:
      // lichess asks for a full minute after a 429 (honor Retry-After if longer).
      const multiplier = Math.min(
        (delayMultiplierByHost.get(host) ?? 1) * 2,
        MAX_DELAY_MULTIPLIER
      );
      delayMultiplierByHost.set(host, multiplier);
      const retryAfterSec = Number(res.headers.get("retry-after")) || 0;
      const waitMs = Math.max(65_000, (retryAfterSec + 5) * 1000);
      console.warn(
        `[http] 429 from ${host} — waiting ${Math.round(waitMs / 1000)}s, ` +
          `host delay now ${baseDelayForHost(host) * multiplier}ms (attempt ${rateLimitAttempt}/${max429Retries})`
      );
      await sleep(waitMs);
      continue;
    }

    const body = await res.text();
    const entry = { url, status: res.status, body };
    await writeCache(url, entry);
    return entry;
  }
}
