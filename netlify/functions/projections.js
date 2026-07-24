// Netlify Function: /api/projections
// Proxies Sleeper's weekly projection data with a 1-hour server-side cache.
// Query params:
//   week  (integer, 0 = season totals)
//   year  (integer, defaults to current year)
//   scoring (ppr | half_ppr | std, defaults to ppr)

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

let _cache = null;
let _cacheKey = '';
let _cacheAt = 0;

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const week    = parseInt(p.week  ?? 1);
  const year    = parseInt(p.year  ?? new Date().getFullYear());
  const scoring = p.scoring || 'ppr';

  const cacheKey = `${year}-${week}-${scoring}`;
  const now = Date.now();

  if (_cache && _cacheKey === cacheKey && now - _cacheAt < CACHE_TTL) {
    return ok(_cache);
  }

  try {
    // Sleeper public projections endpoint — no auth required
    const url = week === 0
      ? `https://api.sleeper.app/v1/stats/nfl/${year}?season_type=regular&position[]=${POSITIONS.join('&position[]=')}`
      : `https://api.sleeper.app/v1/projections/nfl/${year}/${week}?season_type=regular&position[]=${POSITIONS.join('&position[]=')}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Sleeper returned ${res.status}`);
    const raw = await res.json();

    // Normalize: extract pts_ppr / pts_half_ppr / pts_std keyed by player_id
    const result = {};
    for (const [pid, stats] of Object.entries(raw || {})) {
      if (!stats) continue;
      const ppr     = stats.pts_ppr      ?? stats.pts_half_ppr ?? stats.pts_std ?? null;
      const halfPpr = stats.pts_half_ppr ?? null;
      const std     = stats.pts_std      ?? null;
      if (ppr === null && halfPpr === null && std === null) continue;
      result[pid] = { ppr, half_ppr: halfPpr, std };
    }

    _cache    = result;
    _cacheKey = cacheKey;
    _cacheAt  = now;

    return ok(result);
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};

function ok(data) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
    body: JSON.stringify(data),
  };
}
