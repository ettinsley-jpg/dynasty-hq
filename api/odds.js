// Vercel Function: /api/odds
// Fetches NFL player props and futures from The Odds API (free tier).
// Requires ODDS_API_KEY env var set in Vercel dashboard.

const CACHE_TTL = 6 * 60 * 60 * 1000;
let _cache = {};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_KEY = process.env.ODDS_API_KEY;
  if (!API_KEY) return res.status(503).json({ error: 'ODDS_API_KEY not configured' });

  const { market = 'player_rush_yds', week = '1' } = req.query;
  const cacheKey = `${market}-${week}`;
  const now = Date.now();

  if (_cache[cacheKey] && now - _cache[cacheKey].at < CACHE_TTL) {
    return res.status(200).json(_cache[cacheKey].data);
  }

  try {
    const data = market === 'futures' ? await fetchFutures(API_KEY) : await fetchProps(API_KEY, market);
    _cache[cacheKey] = { data, at: now };
    res.status(200).setHeader('Cache-Control', 'public, max-age=21600').json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

async function fetchProps(apiKey, market) {
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events?apiKey=${apiKey}&regions=us&markets=${market}&oddsFormat=american`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Odds API error ${r.status}`);
  const events = await r.json();
  const result = [];
  for (const event of events || []) {
    for (const bm of event.bookmakers || []) {
      if (bm.key !== 'draftkings' && bm.key !== 'fanduel' && result.some(x => x.event_id === event.id)) continue;
      for (const mkt of bm.markets || []) {
        for (const outcome of mkt.outcomes || []) {
          result.push({ event_id: event.id, home_team: event.home_team, away_team: event.away_team, commence: event.commence_time, bookmaker: bm.key, market: mkt.key, player: outcome.description || outcome.name, line: outcome.point ?? null, price: outcome.price, side: outcome.name });
        }
      }
    }
  }
  return result;
}

async function fetchFutures(apiKey) {
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?apiKey=${apiKey}&regions=us&markets=offensive_rookie_of_the_year,offensive_player_of_the_year,mvp&oddsFormat=american`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Odds API error ${r.status}`);
  const events = await r.json();
  const result = [];
  for (const event of events || []) {
    for (const bm of event.bookmakers || []) {
      for (const mkt of bm.markets || []) {
        for (const outcome of mkt.outcomes || []) {
          result.push({ market: mkt.key, player: outcome.name, price: outcome.price, bookmaker: bm.key });
        }
      }
    }
  }
  return result;
}
