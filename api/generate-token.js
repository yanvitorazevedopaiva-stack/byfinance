// api/generate-token.js — Gera token de vinculação Telegram (usa service key, bypassa RLS)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user_id, nome, auth_uid } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const token = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

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
      data: { token, nome: nome || user_id, username: user_id, auth_uid: auth_uid || null, expires_at: expiresAt },
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
