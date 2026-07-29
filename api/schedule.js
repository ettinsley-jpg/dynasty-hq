// Vercel Function: /api/schedule
// Returns next scheduled NFL game per team + DvP (Defense vs Position) ranks.
//
// teamOpponents: { abbr: { opp, home, gameTime, status } }
//   gameTime formatted in US Eastern time ("Thu 8:20 PM")
//
// dvp: { abbr: { passRank, rushRank } }
//   rank 1 = fewest yards allowed (best defense)
//   rank 32 = most yards allowed (worst defense — favorable for fantasy)
//
// Matchup grade (from fantasy player perspective):
//   QB/WR/TE → opponent passRank: ≥23 green, 12-22 yellow, ≤11 red
//   RB        → opponent rushRank: same scale

const ESPN_TEAMS_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40';
const ESPN_TEAM_STATS = (id) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/statistics`;

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; DynastyHQ/1.0)' };

async function fetchJSON(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// Format a UTC ISO date string as US Eastern time display ("Thu 8:20 PM")
function formatET(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  // Determine ET offset: EDT (UTC-4) Mar-Nov, EST (UTC-5) Nov-Mar
  const month = d.getUTCMonth(); // 0=Jan
  const isDST = month >= 2 && month <= 10; // rough EDT window
  const offsetHours = isDST ? -4 : -5;
  const etMs = d.getTime() + offsetHours * 3600 * 1000;
  const et = new Date(etMs);
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const day = days[et.getUTCDay()];
  let h = et.getUTCHours(), m = et.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${day} ${h}:${String(m).padStart(2,'0')} ${ampm}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. Build date range: today through 70 days out (covers preseason + week 1)
    const now = new Date();
    const end = new Date(now.getTime() + 70 * 24 * 3600 * 1000);
    const fmt = (d) =>
      `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
    const schedURL =
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${fmt(now)}-${fmt(end)}&limit=200`;

    // 2. Fetch teams list + schedule + all team stats in parallel
    const [teamsRes, schedRes, ...statsPlaceholder] = await Promise.allSettled([
      fetchJSON(ESPN_TEAMS_URL),
      fetchJSON(schedURL),
    ]);

    const teamsList = teamsRes.status === 'fulfilled'
      ? (teamsRes.value?.sports?.[0]?.leagues?.[0]?.teams || [])
      : [];
    const teams = teamsList.map((t) => ({ id: t.team.id, abbr: t.team.abbreviation }));

    // Fetch all team stats in parallel now that we have IDs
    const statsResults = await Promise.allSettled(
      teams.map((t) => fetchJSON(ESPN_TEAM_STATS(t.id)))
    );

    // 3. Build teamOpponents — pick each team's NEXT upcoming game
    const teamOpponents = {};
    if (schedRes.status === 'fulfilled') {
      const events = (schedRes.value?.events || [])
        .filter((ev) => ev.date) // must have a date
        .sort((a, b) => new Date(a.date) - new Date(b.date)); // chronological

      for (const ev of events) {
        const comps = ev.competitions?.[0]?.competitors || [];
        if (comps.length < 2) continue;
        const [a, b] = comps;
        const abbA = a.team?.abbreviation;
        const abbB = b.team?.abbreviation;
        if (!abbA || !abbB) continue;

        const statusType = ev.competitions?.[0]?.status?.type?.name || '';
        const clock      = ev.competitions?.[0]?.status?.displayClock || '';
        const period     = ev.competitions?.[0]?.status?.period || 0;
        const scoreA     = a.score || '0';
        const scoreB     = b.score || '0';
        const gameTime   = formatET(ev.date);

        // Only set if not already set (we want the nearest upcoming game per team)
        if (!teamOpponents[abbA]) {
          teamOpponents[abbA] = { opp: abbB, home: a.homeAway === 'home', status: statusType, clock, period, myScore: scoreA, oppScore: scoreB, gameTime };
        }
        if (!teamOpponents[abbB]) {
          teamOpponents[abbB] = { opp: abbA, home: b.homeAway === 'home', status: statusType, clock, period, myScore: scoreB, oppScore: scoreA, gameTime };
        }

        // Stop early once all 32 teams have a game
        if (Object.keys(teamOpponents).length >= 32) break;
      }
    }

    // 4. Build DvP ranks from team stats (last completed season)
    const dvp = {};
    teams.forEach((team, i) => {
      const result = statsResults[i];
      if (result.status !== 'fulfilled') return;
      const oppCats = result.value?.results?.opponent || [];
      let passRank = null, rushRank = null;
      for (const cat of oppCats) {
        if (cat.name === 'passing') {
          const s = cat.stats?.find((s) => s.name === 'netPassingYards');
          if (s?.rank) passRank = s.rank;
        }
        if (cat.name === 'rushing') {
          const s = cat.stats?.find((s) => s.name === 'rushingYards');
          if (s?.rank) rushRank = s.rank;
        }
      }
      dvp[team.abbr] = { passRank, rushRank };
    });

    return res.status(200).json({ teamOpponents, dvp, fetchedAt: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
