// api/set-pendente-status.js — atualiza status de um pendente do Telegram (service key, bypassa RLS)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server config error' });
  }

  const { id, status } = req.body || {};
  if (!id || !status) return res.status(400).json({ error: 'id and status required' });

  const permitidos = ['autorizado', 'rejeitado', 'pendente'];
  if (!permitidos.includes(status)) return res.status(400).json({ error: 'status inválido' });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/telegram_pendentes?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({ status }),
      }
    );
    const text = await r.text();
    if (!r.ok) {
      console.error('set-pendente-status erro:', r.status, text.substring(0, 200));
      return res.status(500).json({ error: 'update failed', detail: text.substring(0, 200) });
    }
    let rows;
    try { rows = JSON.parse(text); } catch (e) { rows = []; }
    return res.status(200).json({ ok: true, updated: Array.isArray(rows) ? rows.length : 0 });
  } catch (e) {
    console.error('set-pendente-status erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
