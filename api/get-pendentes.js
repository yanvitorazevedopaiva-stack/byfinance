// api/get-pendentes.js — Busca pendentes do Telegram usando service key (bypassa RLS)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const jwt = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!jwt) return res.status(401).json({ error: 'No auth token' });

  // Verifica o JWT com Supabase Auth (service key pode verificar qualquer JWT)
  let uid = '';
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'apikey': SUPABASE_KEY,
      }
    });
    if (!authRes.ok) return res.status(401).json({ error: 'Invalid token' });
    const authData = await authRes.json();
    uid = authData.id || '';
  } catch (e) {
    return res.status(401).json({ error: 'Auth failed' });
  }

  // Resolve username via mapeamento __uid__
  let username = '';
  if (uid) {
    try {
      const mapRes = await fetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.__uid__${uid}&select=data`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const mapData = await mapRes.json();
      username = mapData?.[0]?.data?.username || '';
    } catch (e) {}
  }

  // Monta filtro OR: username E uuid
  const filters = [];
  if (username) filters.push(`user_id.eq.${encodeURIComponent(username)}`);
  if (uid && uid !== username) filters.push(`user_id.eq.${encodeURIComponent(uid)}`);
  if (!filters.length) return res.status(200).json([]);

  const orFilter = filters.length > 1 ? `or=(${filters.join(',')})` : `user_id=eq.${encodeURIComponent(username || uid)}`;

  try {
    const pendRes = await fetch(
      `${SUPABASE_URL}/rest/v1/telegram_pendentes?${orFilter}&status=eq.pendente&order=created_at.desc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const pendentes = await pendRes.json();
    return res.status(200).json(Array.isArray(pendentes) ? pendentes : []);
  } catch (e) {
    return res.status(500).json({ error: 'Query failed' });
  }
}
