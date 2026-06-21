const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server config error' });
  }

  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/user_data?user_id=like.__uid__*&select=user_id,data`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    const match = (rows || []).find(
      row => (row.data?.username || '').toLowerCase() === username.toLowerCase()
    );
    if (match) {
      const uid = match.user_id.replace('__uid__', '');
      return res.status(200).json({ uid });
    }
    return res.status(200).json({ uid: '' });
  } catch (e) {
    console.error('resolve-uid erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
