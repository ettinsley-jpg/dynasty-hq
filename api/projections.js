// Vercel Function: /api/projections
// Fetches FantasyPros weekly projections (falls back from Sleeper/ESPN).
// Query params: week, year, scoring (ppr|half_ppr|standard), source (sleeper|espn|fp)

const CACHE_TTL_LIVE      = 15 * 60 * 1000;
const CACHE_TTL_OFFSEASON = 6  * 60 * 60 * 1000;
const POSITIONS = ['qb', 'rb', 'wr', 'te', 'k', 'dst'];
let _cache = {};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { week = '1', year, scoring = 'ppr', source = 'fp' } = req.query;
  const yr       = parseInt(year ?? new Date().getFullYear());
  const wk       = parseInt(week);
  const cacheKey = `${source}-${yr}-${wk}-${scoring}`;
  const now      = Date.now();
  const cached   = _cache[cacheKey];

  if (cached && (now - cached.at) < (cached.offSeason ? CACHE_TTL_OFFSEASON : CACHE_TTL_LIVE)) {
    return res.status(200).json(cached.data);
  }

  try {
    let result = null, offSeason = false;

    if (source === 'sleeper') result = await fetchSleeper(yr, wk, scoring);
    else if (source === 'espn') result = await fetchESPN(yr, wk, scoring);

    if (!result || !Object.keys(result).length) {
      offSeason = source === 'sleeper' || source === 'espn';
      result = await fetchFantasyPros(wk, yr, scoring);
    }

    if (!result || !Object.keys(result).length) {
      return res.status(502).json({ error: 'No projection data available', offSeason: true });
    }

    _cache[cacheKey] = { data: { data: result, offSeason }, at: now, offSeason };
    res.status(200).json({ data: result, offSeason });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

async function fetchSleeper(year, week, scoring) {
  const posQ = ['QB','RB','WR','TE','K','DEF'].map(p => `position[]=${p}`).join('&');
  const r    = await fetch(`https://api.sleeper.app/v1/projections/nfl/${year}/${week}?season_type=regular&${posQ}`);
  if (!r.ok) return null;
  const raw = await r.json();
  const result = {};
  for (const [pid, stats] of Object.entries(raw || {})) {
    if (!stats) continue;
    const val = scoring === 'standard' ? stats.pts_std : scoring === 'half_ppr' ? stats.pts_half_ppr : stats.pts_ppr;
    if (val == null || val <= 0) continue;
    result[pid] = { ppr: stats.pts_ppr, half_ppr: stats.pts_half_ppr, std: stats.pts_std, source: 'sleeper' };
  }
  return Object.keys(result).length ? result : null;
}

async function fetchESPN(year, week, scoring) {
  const slotIds = [0, 2, 4, 6, 17, 16];
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/0?view=kona_player_info&scoringPeriodId=${week}`;
  const filter = JSON.stringify({ players: { filterStatus: { value: ['FREEAGENT','WAIVERS','ONTEAM'] }, filterSlotIds: { value: slotIds }, limit: 500, sortPercOwned: { sortPriority: 1, sortAsc: false } } });
  const r = await fetch(url, { headers: { 'X-Fantasy-Filter': filter, 'X-Fantasy-Platform': 'kona-PROD-6cdb78f9f2e1d48bb42ee6a27af80c90b71f5e30' } });
  if (!r.ok) return null;
  const data = await r.json();
  const result = {};
  for (const entry of data?.players || []) {
    const info = entry?.playerPoolEntry?.player;
    const pts  = entry?.playerPoolEntry?.playerRatings?.totalRating;
    if (!info || !pts || pts <= 0) continue;
    result[normName(info.fullName)] = { ppr: pts, half_ppr: pts, std: pts, source: 'espn', name: info.fullName };
  }
  return Object.keys(result).length ? result : null;
}

async function fetchFantasyPros(week, year, scoring) {
  const scoringParam = scoring === 'standard' ? 'STD' : scoring === 'half_ppr' ? 'HALF' : 'PPR';
  const pages = await Promise.allSettled(POSITIONS.map(pos => fetchFPPage(pos, week, scoringParam)));
  const result = {};
  for (const r of pages) {
    if (r.status === 'fulfilled' && r.value) Object.assign(result, r.value);
  }
  return Object.keys(result).length ? result : null;
}

async function fetchFPPage(pos, week, scoring) {
  const url = `https://www.fantasypros.com/nfl/projections/${pos}.php?scoring=${scoring}&week=${week}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://www.fantasypros.com/',
    },
  });
  if (!r.ok) return null;
  const html = await r.text();
  const posLabel = pos.toUpperCase() === 'DST' ? 'DEF' : pos.toUpperCase();
  const result = {};
  const rowRe = /<tr[^>]*?data-player-id="(\d+)"[^>]*?>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const nameMatch = m[2].match(/<a[^>]+>([^<]+)<\/a>/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const tds  = [...m[2].matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(t => t[1].trim());
    const pts  = parseFloat(tds[tds.length - 1]);
    if (!name || isNaN(pts) || pts <= 0) continue;
    result[normName(name)] = { ppr: pts, half_ppr: pts * 0.9, std: pts * 0.8, pos: posLabel, name, source: 'fantasypros' };
  }
  return Object.keys(result).length ? result : null;
}

function normName(name) {
  return (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}
