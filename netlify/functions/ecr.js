// Netlify Function: /api/ecr
// Fetches FantasyPros Expert Consensus Rankings (dynasty or redraft).
// Query params:
//   type    (dynasty | ros | week, defaults to ros)
//   scoring (ppr | half-ppr | standard, defaults to ppr)
//   pos     (all | QB | RB | WR | TE | FLEX | OP | IDP | DL | LB | DB, defaults to all)

const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

let _cache = {};

// FantasyPros embeds ranking data in a JS variable on their ranking pages.
// We fetch the page server-side (no CORS) and extract the data.
const FP_URLS = {
  // Redraft (rest-of-season)
  'ros-ppr':        'https://www.fantasypros.com/nfl/rankings/ros-ppr-flex.php',
  'ros-half-ppr':   'https://www.fantasypros.com/nfl/rankings/ros-half-point-ppr-flex.php',
  'ros-standard':   'https://www.fantasypros.com/nfl/rankings/ros-flex.php',
  // Dynasty
  'dynasty-ppr':    'https://www.fantasypros.com/nfl/rankings/dynasty-overall.php',
  'dynasty-half-ppr': 'https://www.fantasypros.com/nfl/rankings/dynasty-overall.php',
  'dynasty-standard': 'https://www.fantasypros.com/nfl/rankings/dynasty-overall.php',
  // IDP
  'idp-ppr':        'https://www.fantasypros.com/nfl/rankings/idp-overall.php',
  'idp-half-ppr':   'https://www.fantasypros.com/nfl/rankings/idp-overall.php',
  'idp-standard':   'https://www.fantasypros.com/nfl/rankings/idp-overall.php',
};

exports.handler = async (event) => {
  const p       = event.queryStringParameters || {};
  const type    = p.type    || 'ros';
  const scoring = p.scoring || 'ppr';
  const cacheKey = `${type}-${scoring}`;

  const now = Date.now();
  if (_cache[cacheKey] && now - _cache[cacheKey].at < CACHE_TTL) {
    return ok(_cache[cacheKey].data);
  }

  const url = FP_URLS[cacheKey] || FP_URLS['ros-ppr'];

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) throw new Error(`FantasyPros returned ${res.status}`);
    const html = await res.text();

    // FantasyPros embeds ECR data in a script tag as: var ecrData = {...};
    const players = parseEcrData(html);
    if (!players.length) throw new Error('Could not parse ECR data from FantasyPros page');

    _cache[cacheKey] = { data: players, at: now };
    return ok(players);
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};

function parseEcrData(html) {
  // Strategy 1: look for ecrData variable
  let match = html.match(/var\s+ecrData\s*=\s*(\{[\s\S]+?\});\s*\n/);
  if (match) {
    try {
      const obj = JSON.parse(match[1]);
      return normalizePlayers(obj.players || obj);
    } catch(e) {}
  }

  // Strategy 2: look for players array in a script block
  match = html.match(/"players"\s*:\s*(\[[\s\S]+?\])\s*[,}]/);
  if (match) {
    try { return normalizePlayers(JSON.parse(match[1])); } catch(e) {}
  }

  // Strategy 3: look for window.pageData or similar
  match = html.match(/window\.__props\s*=\s*(\{[\s\S]+?\});\s*\n/);
  if (match) {
    try {
      const obj = JSON.parse(match[1]);
      const players = obj?.pageData?.players || obj?.players || [];
      if (players.length) return normalizePlayers(players);
    } catch(e) {}
  }

  return [];
}

function normalizePlayers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((p, i) => ({
    rank:     p.rank_ecr ?? p.rank ?? (i + 1),
    rankBest: p.rank_best ?? null,
    rankWorst:p.rank_worst ?? null,
    rankStdDev: p.rank_std ?? null,
    name:     p.player_name ?? p.player ?? p.name ?? '',
    team:     p.player_team_id ?? p.team ?? '',
    pos:      p.player_position_id ?? p.pos ?? '',
    // Variance: high std dev = more uncertainty = more potential value
    uncertainty: p.rank_std != null ? Math.round(p.rank_std * 10) / 10 : null,
  })).filter(p => p.name);
}

function ok(data) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=10800',
    },
    body: JSON.stringify(data),
  };
}
