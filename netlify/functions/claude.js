// Netlify Function: /.netlify/functions/claude
// Proxies requests to the Anthropic Messages API.
// API key: ANTHROPIC_API_KEY env var (Netlify dashboard) OR passed in request body.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || payload.apiKey || '';
  if (!apiKey) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'No API key configured' }) };
  }

  const body = JSON.stringify({
    model:      payload.model      || 'claude-haiku-4-5-20251001',
    max_tokens: payload.max_tokens || 1024,
    system:     payload.system     || '',
    messages:   payload.messages   || [],
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body,
  });

  const text = await res.text();
  return {
    statusCode: res.status,
    headers: { ...cors(), 'content-type': 'application/json' },
    body: text,
  };
};

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
