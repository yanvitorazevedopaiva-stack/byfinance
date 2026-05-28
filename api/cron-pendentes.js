// api/cron-pendentes.js — BY Finance: Lembra de pendentes com mais de 7 dias
// Cron: 0 21 * * * (18h Brasília / 21h UTC)

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  const text = await res.text();
  if (!text || text.trim() === '') return [];
  try { return JSON.parse(text); } catch(e) { return []; }
}

async function sendTg(chat_id, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'Markdown' }),
  });
}

function fmt(v) {
  return parseFloat(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('Cron pendentes antigos iniciado:', new Date().toISOString());

  try {
    // Busca pendentes com mais de 7 dias
    const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const pendentes = await sb(
      `/telegram_pendentes?status=eq.pendente&created_at=lt.${seteDiasAtras}&select=user_id,descricao,valor,created_at&order=created_at.asc`
    );

    if (!pendentes.length) {
      console.log('Nenhum pendente antigo encontrado.');
      return res.status(200).json({ ok: true, enviados: 0 });
    }

    // Agrupa por user_id
    const porUser = {};
    for (const p of pendentes) {
      if (!porUser[p.user_id]) porUser[p.user_id] = [];
      porUser[p.user_id].push(p);
    }

    let enviados = 0;
    for (const [user_id, lista] of Object.entries(porUser)) {
      try {
        // Busca chat_ids vinculados
        const vinculos = await sb(`/telegram_vinculos?user_id=eq.${user_id}&select=chat_id`);
        if (!vinculos.length) continue;

        let msg = `⏳ *Lançamentos aguardando autorização há mais de 7 dias:*\n\n`;
        for (const p of lista) {
          const dias = Math.floor((Date.now() - new Date(p.created_at)) / (1000 * 60 * 60 * 24));
          msg += `▸ *${p.descricao}* — ${fmt(p.valor)} _(há ${dias} dias)_\n`;
        }
        msg += `\n_Acesse o BY Finance para autorizar ou rejeitar._\n━━━━━━━━━━━━━━\n_BY Persona Finance_`;

        for (const v of vinculos) {
          await sendTg(v.chat_id, msg);
          enviados++;
        }

        console.log(`Pendentes antigos enviados para user ${user_id}`);
      } catch (err) {
        console.error(`Erro ao processar user ${user_id}:`, err.message);
      }
    }

    console.log(`Cron pendentes finalizado. ${enviados} envios.`);
    return res.status(200).json({ ok: true, enviados });

  } catch (err) {
    console.error('Erro no cron-pendentes:', err);
    return res.status(500).json({ error: err.message });
  }
}
