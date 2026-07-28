// Vercel Function: /api/trending
// Fetches Sleeper trending adds/drops and resolves player IDs to names.
// Cached 30 minutes — Sleeper trending updates hourly.

const CACHE_TTL = 30 * 60 * 1000;
const SLEEPER   = 'https://api.sleeper.app/v1';
let _cache = null, _cacheAt = 0;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL) {
    return res.status(200).setHeader('Cache-Control', 'public, max-age=1800').json(_cache);
  }

  try {
    const [addRes, dropRes] = await Promise.all([
      fetch(`${SLEEPER}/players/nfl/trending/add?lookback_hours=24&limit=100`),
      fetch(`${SLEEPER}/players/nfl/trending/drop?lookback_hours=24&limit=100`),
    ]);

    const adds  = addRes.ok  ? await addRes.json()  : [];
    const drops = dropRes.ok ? await dropRes.json() : [];

    const addMap  = Object.fromEntries(adds.map(d  => [d.player_id, d.count]));
    const dropMap = Object.fromEntries(drops.map(d => [d.player_id, d.count]));
    const allIds  = [...new Set([...Object.keys(addMap), ...Object.keys(dropMap)])];

    // Resolve player IDs to names concurrently in batches of 20
    const resolved = {};
    const BATCH = 20;
    for (let i = 0; i < allIds.length; i += BATCH) {
      const batch = allIds.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(pid =>
          fetch(`${SLEEPER}/players/nfl/${pid}`)
            .then(r => r.ok ? r.json() : null)
            .then(p => p ? { pid, name: `${p.first_name||''} ${p.last_name||''}`.trim(), pos: p.position || (p.fantasy_positions?.[0] ?? '?'), team: p.team || '' } : null)
        )
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) resolved[r.value.pid] = r.value;
      }
    }

    const players = Object.values(resolved)
      .filter(p => p.name)
      .map(p => ({
        player_id: p.pid,
        name:      p.name,
        pos:       p.pos,
        team:      p.team,
        addCount:  addMap[p.pid]  || 0,
        dropCount: dropMap[p.pid] || 0,
      }))
      .filter(p => p.addCount > 0 || p.dropCount > 0)
      .sort((a, b) => b.addCount - a.addCount);

    _cache   = players;
    _cacheAt = now;
    res.status(200).setHeader('Cache-Control', 'public, max-age=1800').json(players);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
