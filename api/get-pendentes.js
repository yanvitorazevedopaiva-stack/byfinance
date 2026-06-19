// api/get-pendentes.js — Busca pendentes do Telegram usando service key (bypassa RLS)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Diagnóstico: garante que env vars existem
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('get-pendentes: env vars ausentes', { SUPABASE_URL: !!SUPABASE_URL, SUPABASE_KEY: !!SUPABASE_KEY });
    return res.status(500).json({ error: 'Server config error' });
  }

  const { username, uid } = req.body || {};
  console.log('get-pendentes chamado:', { username, uid: uid ? uid.substring(0,8)+'...' : '' });

  if (!username && !uid) return res.status(400).json({ error: 'username or uid required' });

  // Monta IDs base — coluna user_id é UUID
  let resolvedUid = uid || '';
  // Se uid vazio, tenta achar o UUID pelo username via user_data
  if (!resolvedUid && username) {
    try {
      const revRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_data?user_id=like.__uid__%&select=user_id,data`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const revData = await revRes.json();
      const match = (revData||[]).find(r => (r.data?.username||'').toLowerCase() === (username||'').toLowerCase());
      if (match) {
        resolvedUid = match.user_id.replace('__uid__','');
        console.log('get-pendentes: UUID resolvido via username:', resolvedUid);
      }
    } catch(e) {
      console.error('get-pendentes: erro ao resolver username->uid:', e.message);
    }
  }
  const ids = [...new Set([resolvedUid].filter(Boolean))];

  // SEMPRE resolve via __uid__ mapping — o bot pode ter salvo com username diferente
  // (ex: mapeamento antigo tinha 'yanpaiva' mas _authUser agora é 'Yan')
  if (uid) {
    try {
      const mapRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_data?user_id=eq.__uid__${uid}&select=data`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const mapData = await mapRes.json();
      const mappedUsername = mapData?.[0]?.data?.username || '';
      console.log('get-pendentes: __uid__ mapping retornou:', mappedUsername);
      if (mappedUsername && !ids.includes(mappedUsername)) ids.push(mappedUsername);
    } catch(e) {
      console.error('get-pendentes: erro ao resolver uid:', e.message);
    }
  }

  // Filtra apenas UUIDs válidos para a query (coluna user_id é do tipo uuid)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidIds = ids.filter(id => uuidRegex.test(id));
  if (!uuidIds.length) {
    console.log('get-pendentes: nenhum UUID válido encontrado em ids:', ids);
    return res.status(200).json([]);
  }
  const orParts = uuidIds.map(id => `user_id.eq.${id}`);
  const filter = orParts.length > 1
    ? `or=(${orParts.join(',')})`
    : `user_id=eq.${uuidIds[0]}`;

  const url = `${SUPABASE_URL}/rest/v1/telegram_pendentes?${filter}&status=eq.pendente&order=created_at.desc`;
  console.log('get-pendentes: query URL (sem base):', url.replace(SUPABASE_URL, ''));

  try {
    const pendRes = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const text = await pendRes.text();
    console.log('get-pendentes: status Supabase:', pendRes.status, 'body[:200]:', text.substring(0, 200));

    let pendentes;
    try { pendentes = JSON.parse(text); } catch(e) { pendentes = []; }
    if (!Array.isArray(pendentes)) {
      console.error('get-pendentes: resposta inesperada:', text.substring(0, 300));
      return res.status(200).json([]);
    }

    // Deduplica por id
    const seen = new Set();
    const uniq = pendentes.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id); return true;
    });

    console.log(`get-pendentes: encontrou ${uniq.length} pendente(s) para`, ids);
    return res.status(200).json(uniq);
  } catch(e) {
    console.error('get-pendentes: erro na query:', e.message);
    return res.status(500).json({ error: 'Query failed', detail: e.message });
  }
}
