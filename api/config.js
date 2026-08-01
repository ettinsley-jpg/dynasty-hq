// Vercel Function: /api/config
// Tells the client which API keys are configured server-side so users don't
// need to enter their own keys.

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  res.status(200).json({
    hasClaudeKey: !!process.env.ANTHROPIC_API_KEY,
    hasOddsKey:   !!process.env.ODDS_API_KEY,
  });
}
