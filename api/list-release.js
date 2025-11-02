// api/list-release.js
const cheerio = require('cheerio');
const pLimit = require('p-limit');

const USER_AGENT = 'Mozilla/5.0 (compatible; list-release-api/1.3)';
const REQUEST_TIMEOUT = 15000;
const MAX_RETRIES = 3;
const CONCURRENCY = 6;

function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

async function fetchWithRetries(url, opts={}, max=MAX_RETRIES){
  let attempt = 0;
  while(true){
    attempt++;
    try {
      // use AbortController to time out (Vercel Node 22 supports global fetch)
      const controller = new AbortController();
      const id = setTimeout(()=>controller.abort(), REQUEST_TIMEOUT);
      const res = await fetch(url, {...opts, headers: {...(opts.headers||{}), 'User-Agent': USER_AGENT}, signal: controller.signal});
      clearTimeout(id);
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err){
      if(attempt >= max) throw err;
      const backoff = Math.min(8000, 400 * Math.pow(2, attempt));
      await sleep(backoff + Math.random()*200);
    }
  }
}

function parseListPageForSlugs(html){
  const $ = cheerio.load(html);
  const arr = [];
  $('[data-item-slug]').each((i, el) => {
    const v = $(el).attr('data-item-slug');
    if(v) arr.push(v.trim());
  });
  return [...new Set(arr)];
}

function findPageCount(html){
  const $ = cheerio.load(html);
  const items = $('li.paginate-page');
  if(!items || items.length === 0) return 1;
  const last = items.last();
  const a = last.find('a').first();
  const txt = a.text().trim();
  const n = parseInt(txt, 10);
  return Number.isFinite(n) ? n : 1;
}

function extractTmdbFromFilmHtml(html){
  const $ = cheerio.load(html);
  const el = $('[data-tmdb-id]').first();
  if(!el || el.length === 0) return null;
  const raw = el.attr('data-tmdb-id');
  if(!raw) return null;
  const num = parseInt(String(raw).trim(), 10);
  return Number.isFinite(num) ? num : null;
}

function isoToDDMM(iso){
  if(!iso) return null;
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  if(!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

async function tmdbReleaseDates(tmdbId, bearer){
  if(!tmdbId) return null;
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}/release_dates`;
  const res = await fetchWithRetries(url, { headers: { Authorization: `Bearer ${bearer}`, accept: 'application/json' } });
  return res.json();
}

function extractDatesFromJson(json, countryIso){
  if(!json || !json.results) return { country_earliest: null, type4_earliest_any_iso: null };
  const results = json.results;

  // country earliest (across all types)
  const entry = results.find(r => String(r.iso_3166_1 || '').toUpperCase() === String(countryIso).toUpperCase());
  const countryDates = [];
  if(entry && Array.isArray(entry.release_dates)){
    for(const rd of entry.release_dates){
      if(rd && rd.release_date){
        const m = rd.release_date.match(/(\d{4}-\d{2}-\d{2})/);
        if(m) countryDates.push(m[1]);
      }
    }
  }
  const country_earliest = countryDates.length ? isoToDDMM(countryDates.sort()[0]) : null;

  // type 4 earliest across any ISO
  const type4Dates = [];
  for(const r of results){
    for(const rd of (r.release_dates || [])){
      try {
        const typ = Number(rd.type);
        if(typ === 4 && rd.release_date){
          const m = rd.release_date.match(/(\d{4}-\d{2}-\d{2})/);
          if(m) type4Dates.push(m[1]);
        }
      } catch(e){}
    }
  }
  const type4_earliest_any_iso = type4Dates.length ? isoToDDMM(type4Dates.sort()[0]) : null;

  return { country_earliest, type4_earliest_any_iso };
}

module.exports = async (req, res) => {
  try {
    if(req.method !== 'POST') return res.status(405).send('Only POST allowed');
    const { username, listname, country } = req.body || {};
    if(!username || !listname || !country) return res.status(400).send('username, listname and country are required');

    const base = `https://letterboxd.com/${encodeURIComponent(username)}/list/${encodeURIComponent(listname)}/`;
    const first = await fetchWithRetries(base);
    const firstHtml = await first.text();

    const pageCount = findPageCount(firstHtml);
    const slugs = new Set(parseListPageForSlugs(firstHtml));

    // fetch remaining pages (if any)
    for(let p = 2; p <= pageCount; p++){
      try {
        const pageUrl = `${base}page/${p}/`;
        const r = await fetchWithRetries(pageUrl);
        const txt = await r.text();
        for(const s of parseListPageForSlugs(txt)) slugs.add(s);
        await sleep(120 + Math.random()*120);
      } catch(err){
        console.warn('page error', p, err);
      }
    }

    const slugArray = Array.from(slugs);
    const limit = pLimit(CONCURRENCY);
    const bearer = process.env.TMDB_BEARER;

    const tasks = slugArray.map(slug => limit(async () => {
      const filmUrl = `https://letterboxd.com/film/${slug}/`;
      let filmName = slug;
      let tmdbId = null;
      try {
        const r = await fetchWithRetries(filmUrl);
        const html = await r.text();
        const $ = cheerio.load(html);
        // attempt better title selector (itemprop/name or first h1/h2)
        const title = $('h1[itemprop="name"]').first().text().trim() || $('h1').first().text().trim() || $('h2').first().text().trim();
        if(title) filmName = title;
        const parsed = extractTmdbFromFilmHtml(html);
        if(parsed) tmdbId = parsed;
      } catch(err){
        console.warn('film page error for', slug, err);
      }

      let country_release = null;
      let digital_release = null;
      if(tmdbId && bearer){
        try {
          const json = await tmdbReleaseDates(tmdbId, bearer);
          const dd = extractDatesFromJson(json, country);
          country_release = dd.country_earliest;
          digital_release = dd.type4_earliest_any_iso;
        } catch(err){
          console.warn('tmdb error', tmdbId, err);
        }
      }

      // tiny jitter so we don't hammer Letterboxd
      await sleep(60 + Math.random()*80);
      return { film_query: slug, film_name: filmName, tmdb_id: tmdbId, country_release, digital_release };
    }));

    const results = await Promise.all(tasks);

    // sort: country_earliest (asc), then digital_release (asc), then film_name; nulls last
    function dateKey(d){ return d ? Number(d.split('-').reverse().join('')) : Number.MAX_SAFE_INTEGER; }
    results.sort((a,b) => {
      const k1 = dateKey(a.country_release) - dateKey(b.country_release);
      if(k1 !== 0) return k1;
      const k2 = dateKey(a.digital_release) - dateKey(b.digital_release);
      if(k2 !== 0) return k2;
      return ( (a.film_name||'').localeCompare(b.film_name||'') );
    });

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify(results));
  } catch (err) {
    console.error(err);
    return res.status(500).send(String(err && err.message ? err.message : err));
  }
};
