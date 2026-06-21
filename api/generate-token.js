// api/generate-token.js — Gera token de vinculação Telegram (usa service key, bypassa RLS)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user_id, nome, auth_uid } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const token = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Se auth_uid não veio do front, resolve pelo username (mapeamento __uid__) como rede de segurança
  let resolvedAuthUid = auth_uid || null;
  if (!resolvedAuthUid) {
    try {
      const _r = await fetch(
        `${SUPABASE_URL}/rest/v1/user_data?user_id=like.__uid__*&select=user_id,data`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const _rows = await _r.json();
      const _match = (Array.isArray(_rows) ? _rows : []).find(
        row => (row.data?.username || '').toLowerCase() === (user_id || '').toLowerCase()
      );
      if (_match) {
        resolvedAuthUid = _match.user_id.replace('__uid__', '');
        console.log('generate-token: auth_uid resolvido pelo username:', resolvedAuthUid);
      }
    } catch (e) {
      console.error('generate-token: falha ao resolver auth_uid:', e.message);
    }
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/user_data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({
      user_id: '__tgtoken__' + token,
      data: { token, nome: nome || user_id, username: user_id, auth_uid: resolvedAuthUid, expires_at: expiresAt },
      updated_at: new Date().toISOString(),
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error('generate-token error:', response.status, text);
    return res.status(500).json({ error: 'Falha ao salvar token' });
  }

  console.log(`Token ${token} gerado para user ${user_id}`);
  return res.status(200).json({ token, expires_at: expiresAt });
}
