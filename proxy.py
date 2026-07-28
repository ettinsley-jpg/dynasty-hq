#!/usr/bin/env python3
"""
Dynasty HQ — local proxy
Usage: python3 proxy.py
Serves:
  /projections  — FantasyPros weekly rankings (projected pts for all ranked players)
  /news         — Rotowire NFL news feed (scraped from news.php, ~25 items, 15-min cache)
Press Ctrl+C to stop.
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import urlopen, Request
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor, as_completed
import json, re, sys, unicodedata, time

# ── Projection ranking pages ──────────────────────────────────────────────────
RANKING_PAGES = {
    'QB':  'qb',
    'RB':  'ppr-rb',
    'WR':  'ppr-wr',
    'TE':  'ppr-te',
    'K':   'k',
    'DEF': 'dst',
}
PORT = 3001

_proj_cache = {}           # keyed by (week, year)
_news_cache = None         # single cache entry
_news_cache_at = 0         # timestamp
NEWS_TTL = 15 * 60        # 15 minutes
_ecr_cache = {}            # keyed by (type, scoring)
ECR_TTL  = 3 * 60 * 60   # 3 hours

HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.rotowire.com/',
}


def norm_name(name):
    name = unicodedata.normalize('NFD', name)
    name = ''.join(c for c in name if unicodedata.category(c) != 'Mn')
    name = re.sub(r'\s+(jr\.?|sr\.?|ii|iii|iv|v)$', '', name, flags=re.I)
    name = re.sub(r'[^a-z ]', '', name.lower())
    return re.sub(r'\s+', ' ', name).strip()


def fetch_html(url, referer=None):
    headers = dict(HEADERS)
    if referer:
        headers['Referer'] = referer
    req = Request(url, headers=headers)
    try:
        with urlopen(req, timeout=20) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f'  fetch error {url}: {e}', file=sys.stderr)
        return None


# ── Projections ───────────────────────────────────────────────────────────────

def fetch_ranking_page(pos_label, slug):
    url  = f'https://www.fantasypros.com/nfl/rankings/{slug}.php'
    html = fetch_html(url, referer='https://www.fantasypros.com/')
    if not html:
        return {}

    m = re.search(r'var\s+ecrData\s*=\s*(\{[\s\S]+?\});\s*\n', html)
    if not m:
        return {}

    try:
        obj = json.loads(m.group(1))
    except Exception:
        return {}

    result = {}
    for player in obj.get('players', []):
        name = player.get('player_name', '')
        r2p  = player.get('r2p_pts')
        if not name or not r2p:
            continue
        try:
            pts = float(r2p)
        except (ValueError, TypeError):
            continue
        if pts <= 0:
            continue
        key = norm_name(name)
        result[key] = {
            'ppr':      pts,
            'half_ppr': round(pts * 0.9, 2),
            'std':      round(pts * 0.8, 2),
            'pos':      pos_label,
            'name':     name,
            'source':   'fantasypros',
        }
    return result


def fetch_all_projections(week, year):
    cache_key = (week, year)
    if cache_key in _proj_cache:
        print('  (projections: serving from cache)', file=sys.stderr)
        return _proj_cache[cache_key]

    all_data = {}
    for pos_label, slug in RANKING_PAGES.items():
        data = fetch_ranking_page(pos_label, slug)
        all_data.update(data)
        print(f'  {pos_label}: {len(data)} players', file=sys.stderr)

    _proj_cache[cache_key] = all_data
    return all_data


# ── News ──────────────────────────────────────────────────────────────────────

def strip_tags(html_str):
    """Remove HTML tags and collapse whitespace."""
    text = re.sub(r'<[^>]+>', ' ', html_str or '')
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def fetch_news():
    global _news_cache, _news_cache_at

    now = time.time()
    if _news_cache is not None and (now - _news_cache_at) < NEWS_TTL:
        print('  (news: serving from cache)', file=sys.stderr)
        return _news_cache

    url  = 'https://www.rotowire.com/football/news.php'
    html = fetch_html(url, referer='https://www.rotowire.com/')
    if not html:
        return _news_cache or []

    # Each news item is a <div class="news-update"> block
    blocks = re.findall(
        r'<div[^>]+class="news-update(?:\s[^"]*)?"\s*>([\s\S]+?)(?=<div[^>]+class="news-update(?:\s[^"]*)?"|$)',
        html
    )

    items = []
    for block in blocks:
        # Player name
        name_m = re.search(r'news-update__player-link[^>]*>([^<]+)</a>', block)
        if not name_m:
            continue
        player_name = name_m.group(1).strip()

        # Position
        pos_m = re.search(r'news-update__pos[^>]*>([^<]+)<', block)
        pos = pos_m.group(1).strip() if pos_m else ''

        # Headline (the action, e.g. "Opens camp on PUP list")
        head_m = re.search(r'news-update__headline[^>]*>([^<]+)<', block)
        headline = head_m.group(1).strip() if head_m else ''

        # Date
        date_m = re.search(r'news-update__timestamp[^>]*>([\s\S]+?)<', block)
        date = date_m.group(1).strip() if date_m else ''

        # Body text (news paragraph)
        body_m = re.search(r'news-update__news[^>]*>([\s\S]+?)</div>', block)
        body = strip_tags(body_m.group(1)) if body_m else ''

        # Analysis (fantasy take)
        anal_m = re.search(r'news-update__analysis[^>]*>([\s\S]+?)</div>', block)
        analysis = strip_tags(anal_m.group(1)) if anal_m else ''

        if player_name and (headline or body):
            items.append({
                'player':   player_name,
                'playerKey': norm_name(player_name),
                'pos':      pos,
                'headline': headline,
                'body':     body,
                'analysis': analysis,
                'date':     date,
            })

    print(f'  News: scraped {len(items)} items from Rotowire', file=sys.stderr)
    _news_cache    = items
    _news_cache_at = now
    return items


# ── ECR ───────────────────────────────────────────────────────────────────────

FP_ECR_URLS = {
    'dynasty': 'https://www.fantasypros.com/nfl/rankings/dynasty-overall.php',
    'ros':     'https://www.fantasypros.com/nfl/rankings/ros-ppr-flex.php',
    'week':    'https://www.fantasypros.com/nfl/rankings/ppr-flex.php',
}

def fetch_ecr(ecr_type, scoring):
    global _ecr_cache
    cache_key = (ecr_type, scoring)
    now = time.time()
    if cache_key in _ecr_cache and (now - _ecr_cache[cache_key]['at']) < ECR_TTL:
        print('  (ECR: serving from cache)', file=sys.stderr)
        return _ecr_cache[cache_key]['data']

    url  = FP_ECR_URLS.get(ecr_type, FP_ECR_URLS['ros'])
    html = fetch_html(url, referer='https://www.fantasypros.com/')
    if not html:
        return []

    players = _parse_ecr(html)
    print(f'  ECR ({ecr_type}): {len(players)} players', file=sys.stderr)
    _ecr_cache[cache_key] = {'data': players, 'at': now}
    return players

def _parse_ecr(html):
    # Strategy 1: ecrData JS variable
    m = re.search(r'var\s+ecrData\s*=\s*(\{[\s\S]+?\});\s*\n', html)
    if m:
        try:
            obj = json.loads(m.group(1))
            return _norm_players(obj.get('players', obj))
        except Exception:
            pass

    # Strategy 2: "players" array in script
    m = re.search(r'"players"\s*:\s*(\[[\s\S]+?\])\s*[,}\]]', html)
    if m:
        try:
            return _norm_players(json.loads(m.group(1)))
        except Exception:
            # Try greedy match up to closing bracket
            m2 = re.search(r'"players"\s*:\s*(\[.+)', html, re.DOTALL)
            if m2:
                raw = m2.group(1)
                # Find the matching closing bracket
                depth, end = 0, -1
                for i, c in enumerate(raw):
                    if c == '[': depth += 1
                    elif c == ']':
                        depth -= 1
                        if depth == 0: end = i + 1; break
                if end > 0:
                    try: return _norm_players(json.loads(raw[:end]))
                    except Exception: pass

    return []

def _norm_players(raw):
    if not isinstance(raw, list):
        return []
    out = []
    for i, p in enumerate(raw):
        name = p.get('player_name') or p.get('player') or p.get('name') or ''
        if not name:
            continue
        out.append({
            'rank':       p.get('rank_ecr') or p.get('rank') or (i + 1),
            'rankBest':   p.get('rank_best'),
            'rankWorst':  p.get('rank_worst'),
            'uncertainty': round(float(p['rank_std']) * 10) / 10 if p.get('rank_std') is not None else None,
            'name':  name,
            'team':  p.get('player_team_id') or p.get('team') or '',
            'pos':   p.get('player_position_id') or p.get('pos') or '',
        })
    return out


# ── Sleeper Trending ──────────────────────────────────────────────────────────

_trending_cache     = None
_trending_cache_at  = 0
TRENDING_TTL        = 30 * 60  # 30 minutes

SLEEPER_API = 'https://api.sleeper.app/v1'

def _sleeper_get(path):
    req = Request(f'{SLEEPER_API}{path}', headers={'User-Agent': 'DynastyHQ/1.0'})
    try:
        with urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f'  sleeper error {path}: {e}', file=sys.stderr)
        return None

def _resolve_player(pid):
    data = _sleeper_get(f'/players/nfl/{pid}')
    if not data:
        return None
    fn = data.get('first_name', '')
    ln = data.get('last_name', '')
    name = f'{fn} {ln}'.strip()
    return {
        'player_id': pid,
        'name': name,
        'pos': data.get('position') or data.get('fantasy_positions', ['?'])[0] if data.get('fantasy_positions') else '?',
        'team': data.get('team') or '',
    } if name else None

def fetch_trending():
    global _trending_cache, _trending_cache_at
    now = time.time()
    if _trending_cache is not None and (now - _trending_cache_at) < TRENDING_TTL:
        print('  (trending: serving from cache)', file=sys.stderr)
        return _trending_cache

    adds  = _sleeper_get('/players/nfl/trending/add?lookback_hours=24&limit=100') or []
    drops = _sleeper_get('/players/nfl/trending/drop?lookback_hours=24&limit=100') or []

    add_map  = {d['player_id']: d['count'] for d in adds}
    drop_map = {d['player_id']: d['count'] for d in drops}

    # Resolve all unique player IDs concurrently
    all_pids = list(set(list(add_map) + list(drop_map)))
    resolved = {}
    with ThreadPoolExecutor(max_workers=20) as ex:
        futures = {ex.submit(_resolve_player, pid): pid for pid in all_pids}
        for f in as_completed(futures):
            pid = futures[f]
            p = f.result()
            if p:
                resolved[pid] = p

    result = []
    for pid, p in resolved.items():
        add_count  = add_map.get(pid, 0)
        drop_count = drop_map.get(pid, 0)
        if add_count > 0 or drop_count > 0:
            result.append({
                'player_id': pid,
                'name':      p['name'],
                'pos':       p['pos'],
                'team':      p['team'],
                'addCount':  add_count,
                'dropCount': drop_count,
            })

    result.sort(key=lambda x: -x['addCount'])
    print(f'  Trending: {len(result)} players resolved', file=sys.stderr)
    _trending_cache    = result
    _trending_cache_at = now
    return result


# ── HTTP handler ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == '/claude':
            length = int(self.headers.get('Content-Length', 0))
            raw    = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except Exception:
                self._respond(400, json.dumps({'error': 'Invalid JSON'}).encode())
                return

            api_key = payload.get('apiKey', '')
            if not api_key:
                self._respond(400, json.dumps({'error': 'No API key provided'}).encode())
                return

            # Forward to Anthropic
            body = json.dumps({
                'model':      payload.get('model', 'claude-haiku-4-5-20251001'),
                'max_tokens': payload.get('max_tokens', 1024),
                'system':     payload.get('system', ''),
                'messages':   payload.get('messages', []),
            }).encode('utf-8')

            req = Request(
                'https://api.anthropic.com/v1/messages',
                data=body,
                headers={
                    'x-api-key':         api_key,
                    'anthropic-version': '2023-06-01',
                    'content-type':      'application/json',
                },
                method='POST',
            )
            try:
                from urllib.request import urlopen as _urlopen
                with _urlopen(req, timeout=30) as resp:
                    result = resp.read()
                self._respond(200, result)
                print('  /claude → OK', file=sys.stderr)
            except Exception as e:
                err = json.dumps({'error': str(e)}).encode()
                self._respond(502, err)
                print(f'  /claude → error: {e}', file=sys.stderr)
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == '/projections':
            qs   = parse_qs(parsed.query)
            week = int(qs.get('week', ['1'])[0])
            year = int(qs.get('year', [str(__import__('datetime').date.today().year)])[0])
            print(f'\nProjections week={week} year={year}…', file=sys.stderr)
            data      = fetch_all_projections(week, year)
            off_season = len(data) == 0
            body = json.dumps({'data': data, 'offSeason': off_season}).encode('utf-8')
            self._respond(200, body)

        elif parsed.path == '/news':
            print('\nNews request…', file=sys.stderr)
            items = fetch_news()
            body  = json.dumps({'items': items}).encode('utf-8')
            self._respond(200, body)

        elif parsed.path == '/trending':
            print('\nTrending request…', file=sys.stderr)
            data = fetch_trending()
            body = json.dumps(data).encode('utf-8')
            self._respond(200, body)

        elif parsed.path == '/ecr':
            qs      = parse_qs(parsed.query)
            etype   = qs.get('type',    ['ros'])[0]
            scoring = qs.get('scoring', ['ppr'])[0]
            print(f'\nECR type={etype} scoring={scoring}…', file=sys.stderr)
            players = fetch_ecr(etype, scoring)
            body    = json.dumps(players).encode('utf-8')
            self._respond(200, body)

        else:
            self.send_response(404)
            self.end_headers()

    def _respond(self, status, body):
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    server = HTTPServer(('localhost', PORT), Handler)
    print(f'✅  Dynasty HQ proxy running on http://localhost:{PORT}')
    print('    Endpoints: /projections  /news  /claude')
    print('    Press Ctrl+C to stop.\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nProxy stopped.')
