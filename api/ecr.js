// Vercel Function: /api/ecr
// Fetches FantasyPros Expert Consensus Rankings (dynasty or redraft).
// Query params:
//   type    (dynasty | ros | week, defaults to ros)
//   scoring (ppr | half-ppr | standard, defaults to ppr)

const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours
let _cache = {};

const FP_URLS = {
  'ros-ppr':          'https://www.fantasypros.com/nfl/rankings/ros-ppr-flex.php',
  'ros-half-ppr':     'https://www.fantasypros.com/nfl/rankings/ros-half-point-ppr-flex.php',
  'ros-standard':     'https://www.fantasypros.com/nfl/rankings/ros-flex.php',
  'dynasty-ppr':      'https://www.fantasypros.com/nfl/rankings/dynasty-overall.php',
  'dynasty-half-ppr': 'https://www.fantasypros.com/nfl/rankings/dynasty-overall.php',
  'dynasty-standard': 'https://www.fantasypros.com/nfl/rankings/dynasty-overall.php',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type = 'ros', scoring = 'ppr' } = req.query;
  const cacheKey = `${type}-${scoring}`;
  const now = Date.now();

  if (_cache[cacheKey] && now - _cache[cacheKey].at < CACHE_TTL) {
    return res.status(200).setHeader('Cache-Control', 'public, max-age=10800').json(_cache[cacheKey].data);
  }

  const url = FP_URLS[cacheKey] || FP_URLS['ros-ppr'];
  try {
    const fpRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.fantasypros.com/',
      },
    });
    if (!fpRes.ok) throw new Error(`FantasyPros returned ${fpRes.status}`);
    const html = await fpRes.text();
    const players = parseEcrData(html);
    if (!players.length) throw new Error('Could not parse ECR data');
    _cache[cacheKey] = { data: players, at: now };
    res.status(200).setHeader('Cache-Control', 'public, max-age=10800').json(players);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

function parseEcrData(html) {
  let match = html.match(/var\s+ecrData\s*=\s*(\{[\s\S]+?\});\s*\n/);
  if (match) {
    try {
      const obj = JSON.parse(match[1]);
      return normalizePlayers(obj.players || obj);
    } catch(e) {}
  }
  match = html.match(/"players"\s*:\s*(\[[\s\S]+?\])\s*[,}]/);
  if (match) {
    try { return normalizePlayers(JSON.parse(match[1])); } catch(e) {}
  }
  return [];
}

function normalizePlayers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((p, i) => ({
    rank:       p.rank_ecr ?? p.rank ?? (i + 1),
    rankBest:   p.rank_best ?? null,
    rankWorst:  p.rank_worst ?? null,
    uncertainty: p.rank_std != null ? Math.round(parseFloat(p.rank_std) * 10) / 10 : null,
    name:       p.player_name ?? p.player ?? p.name ?? '',
    team:       p.player_team_id ?? p.team ?? '',
    pos:        p.player_position_id ?? p.pos ?? '',
    age:        p.player_age != null ? parseInt(p.player_age) : null,
  })).filter(p => p.name);
}
