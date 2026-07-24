// Netlify Function: /api/odds
// Fetches NFL player props and futures from The Odds API (free tier).
// Requires ODDS_API_KEY env var set in Netlify dashboard.
// Free tier: 500 requests/month — we cache aggressively.
//
// Query params:
//   market  (player_rush_yds | player_reception_yds | player_tds | player_receptions | futures)
//   week    (integer, used for cache key)

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours — props don't move that fast

let _cache = {};

const FUTURES_MARKETS = [
  'player_season_player_props',
  'player_of_the_year',
  'offensive_player_of_the_year',
  'offensive_rookie_of_the_year',
];

exports.handler = async (event) => {
  const API_KEY = process.env.ODDS_API_KEY;
  if (!API_KEY) {
    return {
      statusCode: 503,
      body: JSON.stringify({
        error: 'ODDS_API_KEY not configured',
        setup: 'Add ODDS_API_KEY to Netlify → Site settings → Environment variables. Get a free key at the-odds-api.com',
      }),
    };
  }

  const p       = event.queryStringParameters || {};
  const market  = p.market || 'player_rush_yds';
  const week    = p.week   || '1';
  const cacheKey = `${market}-${week}`;
  const now     = Date.now();

  if (_cache[cacheKey] && now - _cache[cacheKey].at < CACHE_TTL) {
    return ok(_cache[cacheKey].data);
  }

  try {
    let data;

    if (market === 'futures') {
      data = await fetchFutures(API_KEY);
    } else {
      data = await fetchProps(API_KEY, market);
    }

    _cache[cacheKey] = { data, at: now };
    return ok(data);
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};

async function fetchProps(apiKey, market) {
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events` +
    `?apiKey=${apiKey}&regions=us&markets=${market}&oddsFormat=american`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Odds API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const events = await res.json();
  const result = [];

  for (const event of events || []) {
    for (const bm of event.bookmakers || []) {
      // Use DraftKings or FanDuel as primary; fall back to first bookmaker
      if (bm.key !== 'draftkings' && bm.key !== 'fanduel' && result.some(r => r.event_id === event.id)) continue;
      for (const mkt of bm.markets || []) {
        for (const outcome of mkt.outcomes || []) {
          result.push({
            event_id:    event.id,
            home_team:   event.home_team,
            away_team:   event.away_team,
            commence:    event.commence_time,
            bookmaker:   bm.key,
            market:      mkt.key,
            player:      outcome.description || outcome.name,
            line:        outcome.point ?? null,
            price:       outcome.price,
            side:        outcome.name, // Over / Under
          });
        }
      }
    }
  }

  return result;
}

async function fetchFutures(apiKey) {
  const markets = 'offensive_rookie_of_the_year,offensive_player_of_the_year,mvp';
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds` +
    `?apiKey=${apiKey}&regions=us&markets=${markets}&oddsFormat=american`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API error ${res.status}`);

  const events = await res.json();
  const result = [];

  for (const event of events || []) {
    for (const bm of event.bookmakers || []) {
      for (const mkt of bm.markets || []) {
        for (const outcome of mkt.outcomes || []) {
          result.push({
            market:    mkt.key,
            player:    outcome.name,
            price:     outcome.price,
            bookmaker: bm.key,
          });
        }
      }
    }
  }

  return result;
}

function ok(data) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=21600',
    },
    body: JSON.stringify(data),
  };
}
