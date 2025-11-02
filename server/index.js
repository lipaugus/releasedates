// server/index.js
// Express server for scraping Letterboxd lists and querying TMDB release_dates
// Deploy to Vercel/Render/Heroku. Set env var TMDB_BEARER (Bearer token).
// npm i express node-fetch cheerio p-limit cors

const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const pLimit = require("p-limit");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

const TMDB_BEARER = process.env.TMDB_BEARER;
if (!TMDB_BEARER) {
  console.warn("Warning: TMDB_BEARER not set — TMDB calls will fail.");
}

const USER_AGENT = "Mozilla/5.0 (compatible; list-release-api/1.0)";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const CONCURRENCY = 6; // adjust for politeness

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function fetchWithRetries(url, opts={}, maxRetries=MAX_RETRIES) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const r = await fetch(url, {
        ...opts,
        headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) },
        timeout: REQUEST_TIMEOUT_MS
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const backoff = Math.min(8000, 500 * Math.pow(2, attempt));
      await sleep(backoff + Math.random() * 300);
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
  // unique preserve order
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

function isoDateToDDMMYYYY(iso) {
  if (!iso) return null;
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

async function tmdbReleaseDates(tmdbId) {
  if (!TMDB_BEARER) return null;
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}/release_dates`;
  const r = await fetchWithRetries(url, { headers: { "Authorization": `Bearer ${TMDB_BEARER}`, "accept":"application/json" }});
  return await r.json();
}

function extractDatesFromTmdbResp(json, countryIso) {
  if (!json || !json.results) return { country_earliest: null, type4_earliest_any_iso: null };
  // country earliest (across all types)
  let countryEntry = json.results.find(r => r.iso_3166_1 === countryIso);
  let countryDates = [];
  if (countryEntry && countryEntry.release_dates) {
    for (const rd of countryEntry.release_dates) {
      if (rd.release_date) {
        const m = rd.release_date.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) countryDates.push(m[1]);
      }
    }
  }
  const country_earliest = countryDates.length ? isoDateToDDMMYYYY(countryDates.sort()[0]) : null;

  // type 4 earliest across any iso
  const type4Dates = [];
  for (const r of json.results) {
    for (const rd of (r.release_dates || [])) {
      if (String(rd.type) === '4' && rd.release_date) {
        const m = rd.release_date.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) type4Dates.push(m[1]);
      }
    }
  }
  const type4_earliest_any_iso = type4Dates.length ? isoDateToDDMMYYYY(type4Dates.sort()[0]) : null;

  return { country_earliest, type4_earliest_any_iso };
}

app.post("/api/list-release", async (req, res) => {
  try {
    const { username, listname, country } = req.body || {};
    if (!username || !listname || !country) return res.status(400).send("username,listname,country are required");

    const base = `https://letterboxd.com/${encodeURIComponent(username)}/list/${encodeURIComponent(listname)}/`;
    const first = await fetchWithRetries(base);
    const firstHtml = await first.text();

    const pageCount = findPageCount(firstHtml);
    const slugs = new Set(parseListPageForSlugs(firstHtml));

    // fetch the rest pages (1..pageCount)
    const pages = [];
    for (let p=2; p<=pageCount; p++) pages.push(p);
    for (const p of pages) {
      try {
        const url = `${base}page/${p}/`;
        const r = await fetchWithRetries(url);
        const h = await r.text();
        for (const s of parseListPageForSlugs(h)) slugs.add(s);
        // small polite sleep
        await sleep(200 + Math.random()*300);
      } catch (err) {
        console.warn("Failed page", p, err);
      }
    }

    const slugArray = Array.from(slugs);
    // For each slug, we want: film_query, film_name, tmdb_id, country_earliest, type4_earliest_any_iso
    const limit = pLimit(CONCURRENCY);
    const tasks = slugArray.map((slug, idx) => limit(async () => {
      // fetch film page to extract film_name and tmdb id
      const filmUrl = `https://letterboxd.com/film/${slug}/`;
      let filmName = slug;
      let tmdbId = null;
      try {
        const r = await fetchWithRetries(filmUrl);
        const html = await r.text();
        const $ = cheerio.load(html);
        const h2 = $('h1, h2').first();
        if (h2 && h2.text()) filmName = h2.text().trim();
        const fromHtml = extractTmdbFromFilmHtml(html);
        if (fromHtml) tmdbId = fromHtml;
      } catch (err) {
        // ignore single film errors
      }

      let country_earliest = null;
      let type4_earliest_any_iso = null;

      if (tmdbId) {
        try {
          const json = await tmdbReleaseDates(tmdbId);
          const extracted = extractDatesFromTmdbResp(json, country.toUpperCase());
          country_earliest = extracted.country_earliest;
          type4_earliest_any_iso = extracted.type4_earliest_any_iso;
        } catch (err) {
          console.warn("TMDB error for", tmdbId, err);
        }
      }

      // small jitter
      await sleep(80 + Math.random() * 100);
      return {
        film_query: slug,
        film_name: filmName,
        tmdb_id: tmdbId,
        country_release: country_earliest,
        digital_release: type4_earliest_any_iso
      };
    }));

    const results = await Promise.all(tasks);

    // Sorting: per your requirement:
    // - Primary by country_release (earliest -> newest), nulls last
    // - Secondary by digital_release (earliest->newest), nulls last
    // - Tertiary by film_name alphabetical
    function dateKey(d) {
      if (!d) return Infinity; // nulls go last
      // d is DD-MM-YYYY -> convert to YYYYMMDD numeric
      const [dd,mm,yy] = d.split("-");
      return Number(`${yy}${mm}${dd}`);
    }
    results.sort((a,b) => {
      const k1 = dateKey(a.country_release) - dateKey(b.country_release);
      if (k1 !== 0) return k1;
      const k2 = dateKey(a.digital_release) - dateKey(b.digital_release);
      if (k2 !== 0) return k2;
      return ( (a.film_name||"").localeCompare(b.film_name || "") );
    });

    return res.json(results);
  } catch (err) {
    console.error(err);
    return res.status(500).send(String(err && err.message ? err.message : err));
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("list-release api listening on", port);
});
