// api/get-pendentes.js — Busca pendentes usando service key (bypassa RLS)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch(e) { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, uid } = req.body || {};

  // Verifica JWT se fornecido — garante que o token pertence ao uid declarado
  const jwt = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (jwt) {
    try {
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': SUPABASE_KEY }
      });
      if (authRes.ok) {
        const authData = await authRes.json();
        // uid fornecido deve bater com o JWT
        if (uid && authData.id && authData.id !== uid) {
          return res.status(403).json({ error: 'Token mismatch' });
        }
      }
    } catch(e) {}
  }

  if (!username && !uid) return res.status(400).json({ error: 'username or uid required' });

  // Resolve username a partir do uid se não fornecido
  let resolvedUsername = username || '';
  if (!resolvedUsername && uid) {
    try {
      const mapData = await sb(`/user_data?user_id=eq.__uid__${uid}&select=data`);
      resolvedUsername = mapData?.[0]?.data?.username || '';
    } catch(e) {}
  }

  // Busca por username E uid (bot pode ter salvo de qualquer forma)
  const ids = [...new Set([resolvedUsername, uid].filter(Boolean))];
  if (!ids.length) return res.status(200).json([]);

  // Monta query OR
  let filter;
  if (ids.length === 1) {
    filter = `user_id=eq.${ids[0]}`;
  } else {
    filter = `or=(${ids.map(id => `user_id.eq.${id}`).join(',')})`;
  }

  try {
    const pendentes = await sb(
      `/telegram_pendentes?${filter}&status=eq.pendente&order=created_at.desc`
    );
    // Deduplica por id
    const seen = new Set();
    const uniq = (Array.isArray(pendentes) ? pendentes : [])
      .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
    return res.status(200).json(uniq);
  } catch(e) {
    return res.status(500).json({ error: 'Query failed', detail: e.message });
  }
}
