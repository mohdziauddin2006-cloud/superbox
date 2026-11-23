/* tmdb-client.js - Non-blocking TMDB client with AbortController timeouts,
   local disk + memory caching, exponential retry-with-backoff, public DNS
   resolution, full multi-season episode pagination, and graceful fallback
   to provider metadata so TMDB outages never block page loads or search. */
'use strict';

const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 3500;
const MAX_RETRIES = 2;
const BACKOFF_MS = [250, 600];
const MEM_LIMIT = 400;
const DISK_LIMIT = 1200;

const CACHE_DIR = path.resolve(os.tmpdir(), 'superbox-tmdb-cache');
const DNS_STATE = { at: 0, ips: [] };
const memCache = new Map();
const inflight = new Map();

function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (e) {}
}

function cacheHash(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function cacheFilePath(key) {
  const file = path.resolve(CACHE_DIR, cacheHash(key) + '.json');
  if (!file.startsWith(CACHE_DIR + path.sep)) return '';
  return file;
}

function ttlForUrl(rawUrl) {
  const s = String(rawUrl || '');
  if (/\/tv\/\d+\/season\/\d+/i.test(s)) return 24 * 60 * 60 * 1000;
  if (/\/(movie|tv)\/\d+(\?|$)/i.test(s)) return 12 * 60 * 60 * 1000;
  if (/\/recommendations|\/similar/i.test(s)) return 6 * 60 * 60 * 1000;
  if (/\/search\//i.test(s)) return 10 * 60 * 1000;
  return 20 * 60 * 1000;
}

function canonicalKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('api_key');
    const entries = Array.from(u.searchParams.entries()).sort(function (a, b) {
      return a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1);
    });
    const qs = entries.map(function (kv) { return kv[0] + '=' + kv[1]; }).join('&');
    return u.pathname + (qs ? '?' + qs : '');
  } catch (e) {
    return String(rawUrl || '');
  }
}

function readCache(key, allowStale) {
  const now = Date.now();
  const m = memCache.get(key);
  if (m) {
    if (allowStale || (now - m.at) <= m.ttl) return m;
  }
  const fp = cacheFilePath(key);
  if (!fp) return null;
  try {
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.body !== 'string') return null;
    const entry = {
      at: Number(parsed.at) || 0,
      ttl: Number(parsed.ttl) || 600000,
      status: Number(parsed.status) || 200,
      headers: parsed.headers || { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from(parsed.body, 'utf8')
    };
    if (!allowStale && (now - entry.at) > entry.ttl) return null;
    memCache.set(key, entry);
    return entry;
  } catch (e) {
    return null;
  }
}

function pruneDiskCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    if (files.length <= DISK_LIMIT) return;
    const stats = files.map(function (f) {
      const p = path.resolve(CACHE_DIR, f);
      if (!p.startsWith(CACHE_DIR + path.sep)) return null;
      try { return { p: p, mt: fs.statSync(p).mtimeMs }; } catch (e) { return null; }
    }).filter(Boolean).sort(function (a, b) { return a.mt - b.mt; });
    const drop = Math.max(100, stats.length - Math.floor(DISK_LIMIT * 0.8));
    for (let i = 0; i < drop && i < stats.length; i++) {
      try { fs.unlinkSync(stats[i].p); } catch (e) {}
    }
  } catch (e) {}
}

function writeCache(key, status, headers, bodyBuf, ttl) {
  if (status !== 200 || !bodyBuf || !bodyBuf.length) return;
  const entry = {
    at: Date.now(),
    ttl: ttl || 600000,
    status: status,
    headers: headers || { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.isBuffer(bodyBuf) ? bodyBuf : Buffer.from(String(bodyBuf), 'utf8')
  };
  if (memCache.size >= MEM_LIMIT) {
    const oldest = memCache.keys().next().value;
    if (oldest) memCache.delete(oldest);
  }
  memCache.set(key, entry);
  ensureCacheDir();
  const fp = cacheFilePath(key);
  if (!fp) return;
  try {
    fs.writeFile(fp, JSON.stringify({
      at: entry.at,
      ttl: entry.ttl,
      status: entry.status,
      headers: { 'content-type': entry.headers['content-type'] || 'application/json; charset=utf-8' },
      body: entry.body.toString('utf8')
    }), 'utf8', function () {
      if (Math.random() < 0.04) pruneDiskCache();
    });
  } catch (e) {}
}

async function resolveTmdbIps() {
  if (DNS_STATE.ips.length && (Date.now() - DNS_STATE.at) < 300000) return DNS_STATE.ips;
  try {
    const ips = await Promise.race([
      dns.promises.resolve4('api.themoviedb.org'),
      new Promise(function (res) { setTimeout(function () { res([]); }, 1400); })
    ]);
    if (Array.isArray(ips) && ips.length) {
      DNS_STATE.at = Date.now();
      DNS_STATE.ips = ips;
    }
  } catch (e) {}
  return DNS_STATE.ips;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function httpsGetWithAbort(rawUrl, timeoutMs, ips) {
  return new Promise(function (resolve, reject) {
    const u = new URL(rawUrl);
    const ctl = new AbortController();
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      try { ctl.abort(); } catch (e) {}
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    const lookup = function (host, opts, cb) {
      if (!ips || !ips.length) return dns.lookup(host, opts, cb);
      if (opts && opts.all) {
        return cb(null, ips.map(function (a) { return { address: a, family: 4 }; }));
      }
      cb(null, ips[0], 4);
    };

    const req = https.get(u, {
      lookup: lookup,
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, function (r) {
      const chunks = [];
      let total = 0;
      r.on('data', function (c) {
        total += c.length;
        if (total <= 12 * 1024 * 1024) chunks.push(c);
      });
      r.on('end', function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status: r.statusCode || 0,
          ok: r.statusCode >= 200 && r.statusCode < 300,
          body: Buffer.concat(chunks),
          headers: r.headers || {}
        });
      });
      r.on('error', function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });

    req.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function fallbackPayloadFor(rawUrl, providerMeta) {
  const s = String(rawUrl || '');
  const meta = providerMeta && typeof providerMeta === 'object' ? providerMeta : {};
  if (/\/season\/\d+/i.test(s)) {
    const sm = s.match(/\/season\/(\d+)/i);
    return {
      season_number: sm ? Number(sm[1]) : 1,
      episodes: Array.isArray(meta.episodes) ? meta.episodes : [],
      fallback: true
    };
  }
  if (/\/(movie|tv)\/\d+(\?|$)/i.test(s)) {
    const isTv = /\/tv\/\d+/i.test(s);
    const idm = s.match(/\/(?:movie|tv)\/(\d+)/i);
    return {
      id: idm ? Number(idm[1]) : 0,
      title: meta.title || meta.t || '',
      name: meta.title || meta.t || '',
      overview: meta.desc || meta.overview || '',
      poster_path: null,
      backdrop_path: null,
      genres: Array.isArray(meta.genres) ? meta.genres.map(function (g, i) {
        return typeof g === 'string' ? { id: i + 1, name: g } : g;
      }) : [],
      seasons: isTv ? (Array.isArray(meta.seasons) ? meta.seasons : [{ season_number: 1, name: 'Season 1', episode_count: Number(meta.parts) || 0 }]) : undefined,
      fallback: true
    };
  }
  return {
    page: 1,
    total_pages: 1,
    total_results: 0,
    results: [],
    fallback: true
  };
}

/* Main non-blocking TMDB JSON fetch:
   1. Immediate memory/disk cache hit
   2. Deduplicated in-flight request with AbortController timeout + retry backoff
   3. Stale cache fallback on upstream failure
   4. Clean provider metadata fallback if no cache exists (never blocks UI) */
async function tmdbJson(rawUrl, opts) {
  const o = typeof opts === 'number' ? { timeoutMs: opts } : (opts || {});
  const timeoutMs = Math.max(1500, Math.min(10000, Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const retries = o.retries != null ? Math.max(0, Math.min(3, Number(o.retries))) : MAX_RETRIES;
  const key = canonicalKey(rawUrl);

  if (!o.bypassCache) {
    const hit = readCache(key, false);
    if (hit) {
      return {
        status: hit.status,
        ok: true,
        body: hit.body,
        headers: Object.assign({}, hit.headers, { 'x-tmdb-cache': 'HIT' }),
        cached: true
      };
    }
  }

  if (inflight.has(key)) return inflight.get(key);

  const work = (async function () {
    const ips = await resolveTmdbIps();
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await httpsGetWithAbort(rawUrl, timeoutMs, ips);
        if (r.ok) {
          writeCache(key, r.status, r.headers, r.body, ttlForUrl(rawUrl));
          return Object.assign({}, r, { cached: false });
        }
        /* Do not retry permanent 4xx errors (except 429 rate-limit). */
        if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          return r;
        }
        lastErr = new Error('TMDB HTTP ' + r.status);
      } catch (err) {
        lastErr = err;
      }
      if (attempt < retries) {
        const wait = (BACKOFF_MS[attempt] || 700) + Math.floor(Math.random() * 140);
        await sleep(wait);
      }
    }

    /* Upstream failed: serve stale cache immediately if available. */
    const stale = readCache(key, true);
    if (stale) {
      return {
        status: 200,
        ok: true,
        body: stale.body,
        headers: Object.assign({}, stale.headers, { 'x-tmdb-cache': 'STALE' }),
        cached: true,
        stale: true
      };
    }

    /* Final graceful fallback: never crash or stall caller when fallback mode enabled. */
    if (o.allowFallback !== false) {
      const fb = fallbackPayloadFor(rawUrl, o.providerMeta);
      return {
        status: 200,
        ok: true,
        fallback: true,
        error: String((lastErr && lastErr.message) || lastErr || 'tmdb unavailable'),
        body: Buffer.from(JSON.stringify(fb), 'utf8'),
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-tmdb-fallback': '1' }
      };
    }
    throw lastErr || new Error('tmdb unavailable');
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

/* Paginate ALL seasons & episodes for a TMDB TV/Anime show (no 6-10 or 200 cap).
   Supports shows with 65+, 200+, or 1,000+ episodes across all seasons with
   bounded concurrency and disk caching per season. */
async function fetchAllEpisodes(tvId, apiKey, opts) {
  const id = String(tvId || '').trim();
  if (!/^\d+$/.test(id)) return { ok: false, id: id, seasons: [] };
  const baseUrl = 'https://api.themoviedb.org/3/tv/' + encodeURIComponent(id);
  const o = opts || {};

  let show = null;
  try {
    const r = await tmdbJson(baseUrl + '?api_key=' + encodeURIComponent(apiKey), {
      timeoutMs: o.timeoutMs || 4000,
      allowFallback: false
    });
    if (r && r.ok) show = JSON.parse(r.body.toString('utf8'));
  } catch (e) {
    show = null;
  }
  if (!show) return { ok: false, id: id, name: '', seasons: [], fallback: true };

  const seasons = (Array.isArray(show.seasons) ? show.seasons : [])
    .filter(function (s) { return s && Number(s.season_number) >= 0 && Number(s.episode_count) > 0; })
    .sort(function (a, b) { return Number(a.season_number) - Number(b.season_number); })
    .slice(0, 60);

  const results = new Array(seasons.length);
  let cursor = 0;
  const concurrency = Math.min(4, Math.max(1, seasons.length));

  async function worker() {
    while (cursor < seasons.length) {
      const idx = cursor++;
      const s = seasons[idx];
      const n = Number(s.season_number);
      const label = String(s.name || ('Season ' + n));
      try {
        const rr = await tmdbJson(baseUrl + '/season/' + n + '?api_key=' + encodeURIComponent(apiKey), {
          timeoutMs: o.timeoutMs || 4500,
          allowFallback: true
        });
        const sd = rr && rr.ok ? JSON.parse(rr.body.toString('utf8')) : null;
        let eps = (sd && Array.isArray(sd.episodes) ? sd.episodes : [])
          .filter(function (e2) { return e2 && Number(e2.episode_number) > 0; })
          .sort(function (a, b) { return Number(a.episode_number) - Number(b.episode_number); })
          .slice(0, 2000)
          .map(function (e2) {
            return {
              n: Number(e2.episode_number),
              name: String(e2.name || ('Episode ' + e2.episode_number)),
              air: String(e2.air_date || ''),
              runtime: Number(e2.runtime) || 0
            };
          });
        /* If TMDB season endpoint returned empty but episode_count is known, synthesize slots so 65+ shows remain browsable */
        if (!eps.length && Number(s.episode_count) > 0) {
          const cap = Math.min(2000, Number(s.episode_count));
          eps = [];
          for (let epNum = 1; epNum <= cap; epNum++) {
            eps.push({ n: epNum, name: 'Episode ' + epNum, air: '', runtime: 0 });
          }
        }
        results[idx] = { n: n, name: label, count: eps.length, eps: eps };
      } catch (e) {
        results[idx] = { n: n, name: label, count: 0, eps: [] };
      }
    }
  }

  const pool = [];
  for (let w = 0; w < concurrency; w++) pool.push(worker());
  await Promise.all(pool);

  const totalEpisodes = results.reduce(function (acc, s) { return acc + ((s && s.eps) ? s.eps.length : 0); }, 0);
  return {
    ok: totalEpisodes > 0,
    id: id,
    name: String(show.name || ''),
    totalEpisodes: totalEpisodes,
    seasons: results
  };
}

module.exports = {
  tmdbJson: tmdbJson,
  fetchAllEpisodes: fetchAllEpisodes,
  fallbackPayloadFor: fallbackPayloadFor,
  canonicalKey: canonicalKey
};
