// Vercel Function: /api/claude
// Proxies requests to the Anthropic Messages API.
// API key: ANTHROPIC_API_KEY env var (Vercel dashboard) OR passed in request body.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = req.body || {};
  const apiKey = process.env.ANTHROPIC_API_KEY || payload.apiKey || '';
  if (!apiKey) return res.status(400).json({ error: 'No API key configured' });

  const body = JSON.stringify({
    model:      payload.model      || 'claude-haiku-4-5-20251001',
    max_tokens: payload.max_tokens || 1024,
    system:     payload.system     || '',
    messages:   payload.messages   || [],
  });

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body,
  });

  const text = await upstream.text();
  res.status(upstream.status)
     .setHeader('Content-Type', 'application/json')
     .end(text);
}
