// api/list-release.js
// Reworked to read tmdb ids from a Google Sheet (CSV) instead of scraping Letterboxd.
// TMDB logic is preserved. Expects TMDB_BEARER env var for TMDB API access.

const REQUEST_TIMEOUT = 15000;
const MAX_RETRIES = 4;
const DEFAULT_CONCURRENCY = 1; // polite default; can increase with LIST_CONCURRENCY env
const CONCURRENCY = Number(process.env.LIST_CONCURRENCY || DEFAULT_CONCURRENCY);

// Optional proxy: if set, we'll request `${SCRAPER_PROXY}?url=${encodeURIComponent(url)}`
const SCRAPER_PROXY = process.env.SCRAPER_PROXY || null;

const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:119.0) Gecko/20100101 Firefox/119.0"
];

function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

async function fetchWithRetriesRaw(url, opts = {}, maxAttempts = MAX_RETRIES) {
  const proxy = SCRAPER_PROXY;
  const targetUrl = proxy ? `${proxy}?url=${encodeURIComponent(url)}` : url;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const ua = UA_LIST[(attempt - 1) % UA_LIST.length];
      const defaultHeaders = {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
      };
      const headers = { ...(opts.headers || {}), ...defaultHeaders };

      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const res = await fetch(targetUrl, { ...opts, headers, signal: controller.signal });
      clearTimeout(id);

      if (!res.ok) {
        const status = res.status;
        const bodyText = await res.text().catch(() => '');
        if ((status === 403 || status === 429) && attempt < maxAttempts) {
          const backoff = Math.min(4000, 300 * (2 ** attempt));
          console.warn(`[fetchWithRetriesRaw] got ${status} for ${url} (attempt ${attempt}). Retrying after ${backoff}ms. UA=${ua}`);
          await sleep(backoff + Math.random() * 200);
          continue;
        }
        const err = new Error(`HTTP ${status} for ${url} (proxy=${Boolean(proxy)}). Response snippet: ${bodyText.slice(0,200)}`);
        err.status = status;
        throw err;
      }

      return res;
    } catch (err) {
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

// Convert Google Sheet URL -> CSV export URL for sheet "Hoja 1" by default
function googleSheetToCsvUrl(sheetUrl, sheetName = 'Hoja 1') {
  const match = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return null;
  const sheetId = match[1];
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

// Robust-ish CSV line parser (handles quoted fields and doubled quotes)
function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (const rawLine of lines) {
    if (!rawLine || !rawLine.trim()) continue;
    const line = rawLine;
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          fields.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      }
    }
    fields.push(cur.trim());
    rows.push(fields);
  }
  return rows;
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
    const sheetUrl = (body.sheetUrl || '').trim();
    const country = (body.country || '').trim();
    const excludePremieres = !!body.excludePremieres;

    if (!sheetUrl || !country) {
      return res.status(400).json({ ok: false, error: 'sheetUrl and country are required (POST JSON)' });
    }

    const tmdbBearer = process.env.TMDB_BEARER;
    if (!tmdbBearer) {
      console.warn('[startup] TMDB_BEARER missing in env — TMDB lookups skipped');
    }

    console.log(`[start] sheet=${sheetUrl} country=${country} excludePremieres=${excludePremieres} concurrency=${CONCURRENCY}`);

    const csvUrl = googleSheetToCsvUrl(sheetUrl, 'Hoja 1');
    if (!csvUrl) {
      return res.status(400).json({ ok: false, error: 'Invalid Google Sheets URL' });
    }

    let csvText;
    try {
      const resp = await fetchWithRetriesRaw(csvUrl, { headers: { 'Accept': 'text/csv' } });
      csvText = await resp.text();
    } catch (err) {
      console.error('[error] failed fetching sheet CSV: ', err && (err.message || err));
      return res.status(502).json({ ok: false, error: 'Failed fetching Google Sheet CSV', detail: String(err && (err.message || err)) });
    }

    const parsed = parseCsv(csvText);
    // parsed rows: [ [title, tmdb_id, ...], ... ]
    // keep rows where second column is numeric (tmdb id)
    const dataRows = parsed
      .map(r => [ (r[0] || '').trim(), (r[1] || '').trim() ])
      .filter(r => {
        const id = parseInt(String(r[1]).replace(/\D/g, ''), 10);
        return Number.isFinite(id);
      })
      .map(r => [r[0], String(parseInt(r[1].replace(/\D/g, ''), 10))]);

    if (dataRows.length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid rows (tmdb ids) found in sheet' });
    }

    const allowedTypesForCountry = excludePremieres ? [3,4,5,6] : null;

    const results = await asyncMapLimit(dataRows, CONCURRENCY, async ([filmName, tmdbId]) => {
      const filmResult = {
        film_query: null,
        film_name: filmName || null,
        tmdb_id: Number(tmdbId),
        country_release: null,
        country_release_type: null,
        digital_release: null,
        digital_release_type: null
      };

      if (!tmdbBearer) {
        filmResult.error = ['TMDB_BEARER env missing; skipped TMDB lookup'];
        return filmResult;
      }

      try {
        const json = await tmdbReleaseDates(filmResult.tmdb_id, tmdbBearer);
        const extracted = extractDatesFromJsonWithTypes(json, country, allowedTypesForCountry);
        filmResult.country_release = extracted.country_earliest;
        filmResult.country_release_type = extracted.country_earliest_type;
        filmResult.digital_release = extracted.type4_earliest_any_iso;
        filmResult.digital_release_type = extracted.type4_type;
      } catch (tmdbErr) {
        const msg = `TMDB error for id ${filmResult.tmdb_id}: ${tmdbErr && (tmdbErr.message || tmdbErr)}`;
        console.warn('[warn]', msg);
        filmResult.error = filmResult.error || [];
        filmResult.error.push(msg);
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
    console.error('[fatal] unexpected error', err && (err.stack || err));
    return res.status(500).json({ ok:false, error:'Unexpected server error', detail: String(err && (err.message || err)) });
  }
};
