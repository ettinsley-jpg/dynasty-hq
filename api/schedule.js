// Vercel Function: /api/schedule
// Returns current week's NFL matchup context:
//   - teamOpponents: which team faces which + home/away indicator
//   - dvp: each team's opponent pass/rush yards allowed rank (1=best defense, 32=worst)
//
// Matchup grade for players (from fantasy perspective):
//   QB/WR/TE: look up opp team's passRank — high rank = weak pass D = green matchup
//   RB:       look up opp team's rushRank — high rank = weak rush D = green matchup

const ESPN_TEAMS_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40';
const ESPN_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ESPN_TEAM_STATS = (id) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/statistics`;

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; DynastyHQ/1.0)' };

async function fetchJSON(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. Fetch all team IDs
    const teamsData = await fetchJSON(ESPN_TEAMS_URL);
    const teamsList = teamsData?.sports?.[0]?.leagues?.[0]?.teams || [];
    const teams = teamsList.map((t) => ({ id: t.team.id, abbr: t.team.abbreviation }));

    // 2. Fetch scoreboard (current week) + all team stats in parallel
    const [scoreboard, ...statsResults] = await Promise.allSettled([
      fetchJSON(ESPN_SCOREBOARD_URL),
      ...teams.map((t) => fetchJSON(ESPN_TEAM_STATS(t.id))),
    ]);

    // 3. Build teamOpponents from scoreboard
    const teamOpponents = {};
    if (scoreboard.status === 'fulfilled') {
      const events = scoreboard.value?.events || [];
      for (const ev of events) {
        const comps = ev.competitions?.[0]?.competitors || [];
        if (comps.length < 2) continue;
        const [a, b] = comps;
        const abbA = a.team?.abbreviation;
        const abbB = b.team?.abbreviation;
        const statusType = ev.competitions?.[0]?.status?.type?.name || '';
        const clock = ev.competitions?.[0]?.status?.displayClock || '';
        const period = ev.competitions?.[0]?.status?.period || 0;
        const scoreA = a.score || '0';
        const scoreB = b.score || '0';
        if (abbA && abbB) {
          // Format game time: "Sun 1:00 PM"
          const rawDate = ev.date || '';
          let gameTime = '';
          if (rawDate) {
            const d = new Date(rawDate);
            const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
            const day = days[d.getDay()];
            let h = d.getHours(), m = d.getMinutes(), ampm = 'AM';
            if (h >= 12) { ampm = 'PM'; if (h > 12) h -= 12; }
            if (h === 0) h = 12;
            gameTime = `${day} ${h}:${String(m).padStart(2,'0')} ${ampm}`;
          }
          teamOpponents[abbA] = { opp: abbB, home: a.homeAway === 'home', status: statusType, clock, period, myScore: scoreA, oppScore: scoreB, gameTime };
          teamOpponents[abbB] = { opp: abbA, home: b.homeAway === 'home', status: statusType, clock, period, myScore: scoreB, oppScore: scoreA, gameTime };
        }
      }
    }

    // 4. Build dvp ranks from team stats
    //    passRank: rank of opponent netPassingYards (1=fewest allowed=best pass D, 32=most=worst)
    //    rushRank: rank of opponent rushingYards (same scale)
    const dvp = {};
    teams.forEach((team, i) => {
      const result = statsResults[i];
      if (result.status !== 'fulfilled') return;
      const data = result.value;
      const oppCats = data?.results?.opponent || [];

      let passRank = null;
      let rushRank = null;

      for (const cat of oppCats) {
        if (cat.name === 'passing') {
          const stat = cat.stats?.find((s) => s.name === 'netPassingYards');
          if (stat?.rank) passRank = stat.rank;
        }
        if (cat.name === 'rushing') {
          const stat = cat.stats?.find((s) => s.name === 'rushingYards');
          if (stat?.rank) rushRank = stat.rank;
        }
      }

      dvp[team.abbr] = { passRank, rushRank };
    });

    return res.status(200).json({
      teamOpponents,
      dvp,
      fetchedAt: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
