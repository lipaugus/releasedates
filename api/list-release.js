// api/list-release.js
// Improved anti-blocking: UA rotation, richer headers, optional proxy fallback (SCRAPER_PROXY?url=...).
const cheerio = require('cheerio');

const REQUEST_TIMEOUT = 15000;
const MAX_RETRIES = 4;
const DEFAULT_CONCURRENCY = 1; // polite default; raise with env LIST_CONCURRENCY
const CONCURRENCY = Number(process.env.LIST_CONCURRENCY || DEFAULT_CONCURRENCY);

// Optional proxy: if set, we'll request `${SCRAPER_PROXY}?url=${encodeURIComponent(url)}`
// Example: SCRAPER_PROXY="https://my-proxy.example/scrape"
const SCRAPER_PROXY = process.env.SCRAPER_PROXY || null;

const UA_LIST = [
  // a small rotation of common UAs
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:119.0) Gecko/20100101 Firefox/119.0"
];

function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

async function fetchWithRetriesRaw(url, opts = {}, maxAttempts = MAX_RETRIES) {
  // If a proxy is configured, transform the target URL to the proxy route
  const proxy = SCRAPER_PROXY;
  const targetUrl = proxy ? `${proxy}?url=${encodeURIComponent(url)}` : url;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      // Build headers with rotating UA and standard headers
      const ua = UA_LIST[(attempt - 1) % UA_LIST.length];
      const defaultHeaders = {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://letterboxd.com/',
        'Connection': 'keep-alive'
      };
      const headers = { ...(opts.headers || {}), ...defaultHeaders };

      // Use AbortController for timeout
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const res = await fetch(targetUrl, { ...opts, headers, signal: controller.signal });
      clearTimeout(id);

      // If using a proxy, the proxy is expected to return 200 with scraped HTML.
      // If proxy returns an error code, treat accordingly.
      if (!res.ok) {
        // If direct request was blocked with 403 and we didn't yet try all UA strings, try again
        const status = res.status;
        const bodyText = await res.text().catch(() => '');
        // Special handling: if 403 and we can still switch UA, retry without counting as final attempt yet
        if ((status === 403 || status === 429) && attempt < maxAttempts) {
          const backoff = Math.min(4000, 300 * (2 ** attempt));
          console.warn(`[fetchWithRetriesRaw] got ${status} for ${url} (attempt ${attempt}). Retrying after ${backoff}ms. UA=${ua}`);
          await sleep(backoff + Math.random() * 200);
          continue;
        }
        // final: throw with helpful context
        const err = new Error(`HTTP ${status} for ${url} (proxy=${Boolean(proxy)}). Response snippet: ${bodyText.slice(0,200)}`);
        err.status = status;
        throw err;
      }

      // success
      return res;
    } catch (err) {
      // timeout or network error
      if (attempt >= maxAttempts) {
        const e = new Error(`fetchWithRetries failed for ${url} after ${attempt} attempts: ${String(err && (err.message || err))}`);
        e.cause = err;
        throw e;
      }
      const backoff = Math.min(8000, 300 * (2 ** attempt));
      console.warn(`[fetchWithRetriesRaw] attempt ${attempt} failed for ${url}: ${err && (err.message || err)}; sleeping ${backoff}ms`);
      await sleep(backoff + Math.random() * 300);
    }
  }
}

// Convenience wrapper which returns text directly and logs a little context
async function fetchHtml(url) {
  const resp = await fetchWithRetriesRaw(url);
  const txt = await resp.text();
  return txt;
}

/* --- reuse the same helpers used previously --- */

function parseListPageForSlugs(html) {
  const $ = cheerio.load(html);
  const arr = [];
  $('[data-item-slug]').each((i, el) => {
    const v = $(el).attr('data-item-slug');
    if (v) arr.push(v.trim());
  });
  return [...new Set(arr)];
}

function findPageCount(html) {
  const $ = cheerio.load(html);
  const items = $('li.paginate-page');
  if (!items || items.length === 0) return 1;
  const last = items.last();
  const a = last.find('a').first();
  const txt = a.text().trim();
  const n = parseInt(txt, 10);
  return Number.isFinite(n) ? n : 1;
}

function extractTmdbFromFilmHtml(html) {
  const $ = cheerio.load(html);
  const el = $('[data-tmdb-id]').first();
  if (!el || el.length === 0) return null;
  const raw = el.attr('data-tmdb-id');
  if (!raw) return null;
  const num = parseInt(String(raw).trim(), 10);
  return Number.isFinite(num) ? num : null;
}

function isoToDDMM(iso) {
  if (!iso) return null;
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

async function tmdbReleaseDates(tmdbId, bearer) {
  if (!tmdbId) return null;
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}/release_dates`;
  const res = await fetchWithRetriesRaw(url, { headers: { Authorization: `Bearer ${bearer}`, accept: 'application/json' } }, MAX_RETRIES);
  return res.json();
}

function extractDatesFromJsonWithTypes(json, countryIso, allowedTypesForCountry = null) {
  if (!json || !json.results) return {
    country_earliest: null, country_earliest_type: null,
    type4_earliest_any_iso: null, type4_type: null
  };

  const results = json.results;

  let bestCountryDate = null;
  let bestCountryType = null;
  const entry = results.find(r => String(r.iso_3166_1 || '').toUpperCase() === String(countryIso).toUpperCase());
  if (entry && Array.isArray(entry.release_dates)) {
    for (const rd of entry.release_dates) {
      const rdType = Number.isFinite(Number(rd.type)) ? Number(rd.type) : null;
      if (!rd.release_date) continue;
      if (allowedTypesForCountry && Array.isArray(allowedTypesForCountry) && rdType !== null) {
        if (!allowedTypesForCountry.includes(rdType)) continue;
      }
      const m = rd.release_date.match(/(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      const isoDate = m[1];
      if (!bestCountryDate || isoDate < bestCountryDate) {
        bestCountryDate = isoDate;
        bestCountryType = rdType;
      }
    }
  }
  const country_earliest = bestCountryDate ? isoToDDMM(bestCountryDate) : null;
  const country_earliest_type = bestCountryType !== undefined ? bestCountryType : null;

  // type 4 earliest across any ISO
  let bestType4 = null;
  for (const r of results) {
    for (const rd of (r.release_dates || [])) {
      const rdType = Number.isFinite(Number(rd.type)) ? Number(rd.type) : null;
      if (rdType !== 4) continue;
      if (!rd.release_date) continue;
      const m = rd.release_date.match(/(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      const isoDate = m[1];
      if (!bestType4 || isoDate < bestType4) bestType4 = isoDate;
    }
  }
  const type4_earliest_any_iso = bestType4 ? isoToDDMM(bestType4) : null;
  const type4_type = type4_earliest_any_iso ? 4 : null;

  return {
    country_earliest,
    country_earliest_type,
    type4_earliest_any_iso,
    type4_type
  };
}

function extractCleanTitleFromHtml(html) {
  const $ = cheerio.load(html);
  let meta = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content');
  let title = meta && meta.trim();
  if (!title) {
    title = $('h1[itemprop="name"]').first().text().trim() || $('h1').first().text().trim() || $('h2').first().text().trim() || '';
  }
  title = title.replace(/\s*\([^\)]*\)\s*$/, '').trim();
  return title || null;
}

async function asyncMapLimit(inputs, limit, mapper) {
  const results = new Array(inputs.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= inputs.length) return;
      try {
        results[i] = await mapper(inputs[i], i);
      } catch (err) {
        results[i] = { error: String(err && (err.message || err)) };
      }
    }
  }

  const workers = [];
  const n = Math.min(limit, inputs.length || 1);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Only POST allowed');
    const body = req.body || {};
    const username = (body.username || '').trim();
    const listname = (body.listname || '').trim();
    const country = (body.country || '').trim();
    const excludePremieres = !!body.excludePremieres;

    if (!username || !listname || !country) {
      return res.status(400).json({ ok: false, error: 'username, listname and country are required (POST JSON)' });
    }

    const tmdbBearer = process.env.TMDB_BEARER;
    if (!tmdbBearer) {
      console.warn('[startup] TMDB_BEARER missing in env — TMDB lookups skipped');
    }

    console.log(`[start] ${username} / ${listname} country=${country} excludePremises=${excludePremieres} concurrency=${CONCURRENCY}`);

    const base = `https://letterboxd.com/${encodeURIComponent(username)}/list/${encodeURIComponent(listname)}/`;

    // try to fetch first page. If blocked with 403 we will rotate UA and/or rely on proxy if provided.
    let firstHtml;
    try {
      firstHtml = await fetchHtml(base);
    } catch (err) {
      console.error('[error] failed fetching first list page: ', err && err.message ? err.message : err);
      return res.status(502).json({ ok: false, error: 'Failed fetching list first page', detail: String(err && (err.message || err)) });
    }

    let pageCount = 1;
    try { pageCount = findPageCount(firstHtml); } catch(e){ pageCount = 1; }

    const slugs = new Set();
    try { for (const s of parseListPageForSlugs(firstHtml)) slugs.add(s); } catch(e){}

    if (pageCount > 1) {
      for (let p = 2; p <= pageCount; p++) {
        try {
          const pageUrl = `${base}page/${p}/`;
          const pageHtml = await fetchHtml(pageUrl);
          for (const s of parseListPageForSlugs(pageHtml)) slugs.add(s);
          await sleep(150 + Math.random()*200);
        } catch (err) {
          console.warn(`[warn] page ${p} fetch failed: ${err && err.message ? err.message : err}`);
        }
      }
    }

    const slugArray = Array.from(slugs);
    console.log('[info] collected slugs=', slugArray.length);

    const allowedTypesForCountry = excludePremieres ? [3,4,5,6] : null;

    const results = await asyncMapLimit(slugArray, CONCURRENCY, async (slug) => {
      const filmResult = {
        film_query: slug, film_name: null, tmdb_id: null,
        country_release: null, country_release_type: null,
        digital_release: null, digital_release_type: null
      };

      const filmUrl = `https://letterboxd.com/film/${slug}/`;
      try {
        const html = await fetchHtml(filmUrl);
        const cleanTitle = extractCleanTitleFromHtml(html);
        if (cleanTitle) filmResult.film_name = cleanTitle;
        const parsedTmdb = extractTmdbFromFilmHtml(html);
        if (parsedTmdb) filmResult.tmdb_id = parsedTmdb;
      } catch (filmErr) {
        const msg = `failed fetching film page for ${slug}: ${filmErr && filmErr.message ? filmErr.message : filmErr}`;
        console.warn('[warn]', msg);
        filmResult.error = filmResult.error || [];
        filmResult.error.push(msg);
      }

      if (filmResult.tmdb_id && tmdbBearer) {
        try {
          const json = await tmdbReleaseDates(filmResult.tmdb_id, tmdbBearer);
          const extracted = extractDatesFromJsonWithTypes(json, country, allowedTypesForCountry);
          filmResult.country_release = extracted.country_earliest;
          filmResult.country_release_type = extracted.country_earliest_type;
          filmResult.digital_release = extracted.type4_earliest_any_iso;
          filmResult.digital_release_type = extracted.type4_type;
        } catch (tmdbErr) {
          const msg = `TMDB error for id ${filmResult.tmdb_id}: ${tmdbErr && tmdbErr.message ? tmdbErr.message : tmdbErr}`;
          console.warn('[warn]', msg);
          filmResult.error = filmResult.error || [];
          filmResult.error.push(msg);
        }
      } else {
        if (!filmResult.tmdb_id) {
          filmResult.error = filmResult.error || [];
          filmResult.error.push('tmdb_id not found on film page');
        } else if (!tmdbBearer) {
          filmResult.error = filmResult.error || [];
          filmResult.error.push('TMDB_BEARER env missing; skipped TMDB lookup');
        }
      }

      await sleep(40 + Math.random()*60);
      return filmResult;
    });

    // sort by earliest available date (country or digital), then by name
    function dateKey(d) { return d ? Number(d.split('-').reverse().join('')) : Number.MAX_SAFE_INTEGER; }
    function earliestKey(item) {
      const a = dateKey(item.country_release);
      const b = dateKey(item.digital_release);
      return Math.min(a,b);
    }

    results.sort((a,b) => {
      const ka = earliestKey(a), kb = earliestKey(b);
      if (ka !== kb) return ka - kb;
      return (a.film_name || '').localeCompare(b.film_name || '');
    });

    res.setHeader('Content-Type','application/json');
    return res.status(200).send(JSON.stringify({ ok:true, results }));
  } catch (err) {
    console.error('[fatal] unexpected error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok:false, error:'Unexpected server error', detail: String(err && (err.message || err)) });
  }
};
