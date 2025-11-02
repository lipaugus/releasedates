// api/list-release.js
// Serverless function: extracts film titles using <meta property="og:title" content="...">
// and removes trailing " (....)" from the title (parentheses at the end).
// Otherwise behavior is the same as before (robust fetching, per-item errors, TMDB lookups).

const cheerio = require('cheerio');

const USER_AGENT = 'Mozilla/5.0 (compatible; list-release-api/1.6)';
const REQUEST_TIMEOUT = 15000;
const MAX_RETRIES = 3;
// default concurrency lowered for stability; override with env LIST_CONCURRENCY
const CONCURRENCY = Number(process.env.LIST_CONCURRENCY || 3);

function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

/**
 * fetch with retries + abort timeout using global fetch (Node 22 supports fetch)
 */
async function fetchWithRetries(url, opts = {}, max = MAX_RETRIES) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'User-Agent': USER_AGENT }, signal: controller.signal });
      clearTimeout(id);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      if (attempt >= max) {
        const e = new Error(`fetchWithRetries failed for ${url} after ${attempt} attempts: ${String(err && (err.message || err))}`);
        e.cause = err;
        throw e;
      }
      const backoff = Math.min(8000, 400 * (2 ** attempt));
      console.warn(`[fetchWithRetries] attempt ${attempt} failed for ${url}: ${err && err.message ? err.message : err}. sleeping ${backoff}ms`);
      await sleep(backoff + Math.random() * 200);
    }
  }
}

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
  const res = await fetchWithRetries(url, { headers: { Authorization: `Bearer ${bearer}`, accept: 'application/json' } });
  return res.json();
}

function extractDatesFromJson(json, countryIso) {
  if (!json || !json.results) return { country_earliest: null, type4_earliest_any_iso: null };
  const results = json.results;

  // country earliest (across all types)
  const entry = results.find(r => String(r.iso_3166_1 || '').toUpperCase() === String(countryIso).toUpperCase());
  const countryDates = [];
  if (entry && Array.isArray(entry.release_dates)) {
    for (const rd of entry.release_dates) {
      if (rd && rd.release_date) {
        const m = rd.release_date.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) countryDates.push(m[1]);
      }
    }
  }
  const country_earliest = countryDates.length ? isoToDDMM(countryDates.sort()[0]) : null;

  // type 4 earliest across any ISO
  const type4Dates = [];
  for (const r of results) {
    for (const rd of (r.release_dates || [])) {
      try {
        const typ = Number(rd.type);
        if (typ === 4 && rd.release_date) {
          const m = rd.release_date.match(/(\d{4}-\d{2}-\d{2})/);
          if (m) type4Dates.push(m[1]);
        }
      } catch (e) { /* ignore */ }
    }
  }
  const type4_earliest_any_iso = type4Dates.length ? isoToDDMM(type4Dates.sort()[0]) : null;

  return { country_earliest, type4_earliest_any_iso };
}

/**
 * asyncMapLimit: map 'inputs' to results using async mapper with concurrency limit.
 * Preserves original order in returned array.
 */
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

/**
 * Clean up title:
 *  - prefer <meta property="og:title" content="...">
 *  - fallback to other selectors if necessary
 *  - remove trailing " (anything)" at the end of the string
 */
function extractCleanTitleFromHtml(html) {
  const $ = cheerio.load(html);
  // prefer og:title meta
  let meta = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content');
  let title = meta && meta.trim();
  if (!title) {
    // fallback to h1[itemprop="name"] or first h1/h2
    title = $('h1[itemprop="name"]').first().text().trim() || $('h1').first().text().trim() || $('h2').first().text().trim() || '';
  }
  // remove trailing space + parentheses content if present, e.g. "Film Title (2021)" -> "Film Title"
  // regex: remove the last occurrence of " ( ... )" at end of string
  title = title.replace(/\s*\([^\)]*\)\s*$/, '').trim();
  return title || null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Only POST allowed');

    const body = req.body || {};
    const username = (body.username || '').trim();
    const listname = (body.listname || '').trim();
    const country = (body.country || '').trim();

    if (!username || !listname || !country) {
      return res.status(400).json({ ok: false, error: 'username, listname and country are required (POST JSON)' });
    }

    const tmdbBearer = process.env.TMDB_BEARER;
    if (!tmdbBearer) {
      console.warn('[startup] TMDB_BEARER missing in env — requests to TMDB will be skipped');
    }

    console.log(`[start] list-release request for username='${username}', list='${listname}', country='${country}', concurrency=${CONCURRENCY}`);

    const base = `https://letterboxd.com/${encodeURIComponent(username)}/list/${encodeURIComponent(listname)}/`;

    // fetch first page
    let firstHtml;
    try {
      console.log('[step] fetching first list page', base);
      const firstResp = await fetchWithRetries(base);
      firstHtml = await firstResp.text();
    } catch (err) {
      console.error('[error] failed fetching first list page', err && err.message ? err.message : err);
      return res.status(502).json({ ok: false, error: 'Failed fetching list first page', detail: String(err && (err.message || err)) });
    }

    let pageCount = 1;
    try {
      pageCount = findPageCount(firstHtml);
      console.log('[info] detected pageCount =', pageCount);
    } catch (err) {
      console.warn('[warn] failed to parse pageCount, defaulting to 1', err && err.message ? err.message : err);
    }

    // collect slugs
    const slugs = new Set();
    try {
      for (const s of parseListPageForSlugs(firstHtml)) slugs.add(s);
    } catch (err) {
      console.warn('[warn] failed to parse slugs on first page', err && err.message ? err.message : err);
    }

    // fetch additional pages
    if (pageCount > 1) {
      console.log(`[step] fetching remaining ${pageCount - 1} pages`);
      for (let p = 2; p <= pageCount; p++) {
        try {
          const pageUrl = `${base}page/${p}/`;
          console.log(`[fetch] page ${p} -> ${pageUrl}`);
          const r = await fetchWithRetries(pageUrl);
          const txt = await r.text();
          for (const s of parseListPageForSlugs(txt)) slugs.add(s);
          // polite pause
          await sleep(120 + Math.random() * 120);
        } catch (pageErr) {
          console.warn(`[warn] failed to fetch/parse page ${p}:`, pageErr && pageErr.message ? pageErr.message : pageErr);
          // keep going
        }
      }
    }

    const slugArray = Array.from(slugs);
    console.log('[info] total unique slugs collected =', slugArray.length);

    // map slugs -> results with concurrency limit
    const results = await asyncMapLimit(slugArray, CONCURRENCY, async (slug) => {
      const filmResult = { film_query: slug, film_name: null, tmdb_id: null, country_release: null, digital_release: null };

      const filmUrl = `https://letterboxd.com/film/${slug}/`;
      try {
        const r = await fetchWithRetries(filmUrl);
        const html = await r.text();
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
          const extracted = extractDatesFromJson(json, country);
          filmResult.country_release = extracted.country_earliest;
          filmResult.digital_release = extracted.type4_earliest_any_iso;
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

      // tiny jitter
      await sleep(40 + Math.random() * 80);
      return filmResult;
    });

    // Sorting: earliest -> newest; nulls go last
    function dateKey(d) { return d ? Number(d.split('-').reverse().join('')) : Number.MAX_SAFE_INTEGER; }
    results.sort((a, b) => {
      const k1 = dateKey(a.country_release) - dateKey(b.country_release);
      if (k1 !== 0) return k1;
      const k2 = dateKey(a.digital_release) - dateKey(b.digital_release);
      if (k2 !== 0) return k2;
      return ( (a.film_name || '').localeCompare(b.film_name || '') );
    });

    console.log('[done] returning results count =', results.length);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ ok: true, results }));
  } catch (err) {
    console.error('[fatal] unexpected error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Unexpected server error', detail: String(err && (err.message || err)) });
  }
};
