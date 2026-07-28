// Netlify Function: /.netlify/functions/prospects
// Fetches NFL draft prospect rankings from ESPN for a given draft year.
// Filters to skill positions (QB/RB/WR/TE) and returns structured prospect data.

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

async function fetchRound(year, round) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/draft?year=${year}&round=${round}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.picks || [];
}

function ok(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

function err(msg, code = 500) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: msg }),
  };
}

exports.handler = async (event) => {
  const { year } = event.queryStringParameters || {};
  if (!year) return err('Missing year parameter', 400);

  const yr = parseInt(year);
  if (isNaN(yr) || yr < 2026 || yr > 2032) return err('Invalid year', 400);

  try {
    // Fetch rounds 1-3 to get enough skill position prospects
    const [r1, r2, r3] = await Promise.all([
      fetchRound(yr, 1),
      fetchRound(yr, 2),
      fetchRound(yr, 3),
    ]);

    const allPicks = [...r1, ...r2, ...r3];
    const seen = new Set();
    const prospects = [];

    for (const pick of allPicks) {
      const a = pick.athlete || {};
      const posId = a.position?.id;
      if (!SKILL_POS_IDS.has(posId)) continue;

      const name = a.displayName;
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const attrs = a.attributes || [];
      const grade = attrs.find(x => x.name === 'grade')?.displayValue || '75';
      const overallRank = parseInt(attrs.find(x => x.name === 'overall')?.displayValue || '999');
      const posRank = parseInt(attrs.find(x => x.name === 'rank')?.displayValue || '999');

      prospects.push({
        name,
        pos: POS_MAP[posId],
        school: a.team?.shortDisplayName || a.team?.location || '',
        grade: parseInt(grade),
        overallRank,
        posRank,
        tier: gradeToTier(grade),
        headshot: a.headshot?.href || null,
      });
    }

    // Group by position, sort by posRank within each
    const byPos = {};
    for (const p of prospects) {
      if (!byPos[p.pos]) byPos[p.pos] = [];
      byPos[p.pos].push(p);
    }
    for (const pos of Object.keys(byPos)) {
      byPos[pos].sort((a, b) => a.posRank - b.posRank);
    }

    return ok({ year: yr, byPos, fetchedAt: Date.now() });
  } catch (e) {
    return err('Failed to fetch prospects: ' + e.message);
  }
};
