// Vercel Function: /api/prospects
// Fetches NFL draft prospect rankings from ESPN for a given draft year.

const POS_MAP = { '8': 'QB', '9': 'RB', '1': 'WR', '7': 'TE' };
const SKILL_POS_IDS = new Set(Object.keys(POS_MAP));

const TIER_THRESHOLDS = [
  { min: 90, tier: 'Elite' },
  { min: 87, tier: 'Top 10' },
  { min: 83, tier: 'Day 2' },
  { min: 78, tier: 'Day 3' },
  { min: 0,  tier: 'Sleeper' },
];

function gradeToTier(grade) {
  const g = parseInt(grade) || 0;
  return (TIER_THRESHOLDS.find(t => g >= t.min) || { tier: 'Sleeper' }).tier;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const yr = parseInt(req.query.year);
  if (!yr || yr < 2026 || yr > 2032) {
    return res.status(400).json({ error: 'Invalid or missing year parameter' });
  }

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/draft?year=${yr}&round=1&limit=300`;
    const espnRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DynastyHQ/1.0)' },
    });

    if (!espnRes.ok) {
      return res.status(502).json({ error: `ESPN returned ${espnRes.status}` });
    }

    const data = await espnRes.json();
    const picks = data.picks || [];

    const byPos = {};
    for (const pick of picks) {
      const a = pick.athlete || {};
      const posId = String(a.position?.id || '');
      if (!SKILL_POS_IDS.has(posId)) continue;

      const pos = POS_MAP[posId];
      const attrs = a.attributes || [];
      const grade      = parseInt(attrs.find(x => x.name === 'grade')?.displayValue   || '75');
      const overallRank = parseInt(attrs.find(x => x.name === 'overall')?.displayValue || '999');
      const posRank     = parseInt(attrs.find(x => x.name === 'rank')?.displayValue    || '999');

      if (!byPos[pos]) byPos[pos] = [];
      byPos[pos].push({
        name: a.displayName,
        pos,
        school: a.team?.shortDisplayName || a.team?.location || '',
        grade,
        overallRank,
        posRank,
        tier: gradeToTier(grade),
      });
    }

    for (const pos of Object.keys(byPos)) {
      byPos[pos].sort((a, b) => a.posRank - b.posRank);
    }

    return res.status(200).json({ year: yr, byPos, fetchedAt: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
