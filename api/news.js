// Vercel Function: /api/news
// Scrapes Rotowire NFL news feed (~25 items, 15-min cache).

const CACHE_TTL = 15 * 60 * 1000;
let _cache = null, _cacheAt = 0;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL) {
    return res.status(200).json({ items: _cache });
  }

  try {
    const r = await fetch('https://www.rotowire.com/football/news.php', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://www.rotowire.com/',
      },
    });
    if (!r.ok) throw new Error(`Rotowire returned ${r.status}`);
    const html = await r.text();
    const items = parseNews(html);
    _cache   = items;
    _cacheAt = now;
    res.status(200).setHeader('Cache-Control', 'public, max-age=900').json({ items });
  } catch (err) {
    if (_cache) return res.status(200).json({ items: _cache }); // serve stale on error
    res.status(502).json({ error: err.message, items: [] });
  }
}

function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normName(name) {
  return (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

function parseNews(html) {
  const blocks = html.match(/<div[^>]+class="news-update(?:\s[^"]*)?"\s*>([\s\S]+?)(?=<div[^>]+class="news-update(?:\s[^"]*)?"|$)/g) || [];
  const items = [];
  for (const block of blocks) {
    const nameM = block.match(/news-update__player-link[^>]*>([^<]+)<\/a>/);
    if (!nameM) continue;
    const player = nameM[1].trim();
    const posM   = block.match(/news-update__pos[^>]*>([^<]+)</);
    const headM  = block.match(/news-update__headline[^>]*>([^<]+)</);
    const dateM  = block.match(/news-update__timestamp[^>]*>([\s\S]+?)</);
    const bodyM  = block.match(/news-update__news[^>]*>([\s\S]+?)<\/div>/);
    const analM  = block.match(/news-update__analysis[^>]*>([\s\S]+?)<\/div>/);
    const headline = headM?.[1].trim() || '';
    const body     = bodyM ? stripTags(bodyM[1]) : '';
    if (player && (headline || body)) {
      items.push({
        player,
        playerKey: normName(player),
        pos:       posM?.[1].trim() || '',
        headline,
        body,
        analysis: analM ? stripTags(analM[1]) : '',
        date:     dateM?.[1].trim() || '',
      });
    }
  }
  return items;
}
