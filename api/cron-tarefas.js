// api/cron-tarefas.js — BY Finance: Alerta diário de tarefas
// Cron: 0 11 * * * (8h Brasília / 11h UTC)

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

function fmtData(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('Cron tarefas iniciado:', new Date().toISOString());

  try {
    const vinculos = await sb('/telegram_vinculos?select=user_id,chat_id');
    if (!vinculos || !vinculos.length) {
      return res.status(200).json({ ok: true, enviados: 0 });
    }

    // Agrupa chat_ids por user_id
    const porUser = {};
    for (const v of vinculos) {
      if (!porUser[v.user_id]) porUser[v.user_id] = [];
      porUser[v.user_id].push(v.chat_id);
    }

    const hoje = new Date();
    const hojeISO = hoje.toISOString().split('T')[0];
    let enviados = 0;

    for (const [user_id, chatIds] of Object.entries(porUser)) {
      try {
        // Resolve UUID → username
        let uid = user_id;
        if (user_id.includes('-')) {
          const uidMap = await sb(`/user_data?user_id=eq.__uid__${user_id}&select=data`);
          const mapped = uidMap?.[0]?.data?.username;
          if (mapped) uid = mapped;
        }

        const userData = await sb(`/user_data?user_id=eq.${uid}&select=data`);
        const dados = userData?.[0]?.data || {};
        const tarefas = dados[uid + '_tarefas'] || [];

        const pendentes = tarefas.filter(t => !t.concluida);
        const atrasadas = pendentes.filter(t => t.prazo && t.prazo < hojeISO);
        const hoje_list = pendentes.filter(t => t.prazo && t.prazo === hojeISO);
        const proximas  = pendentes.filter(t => !t.prazo || t.prazo > hojeISO);

        // Só envia se tiver algo urgente (atrasadas ou para hoje)
        if (atrasadas.length === 0 && hoje_list.length === 0) continue;

        let msg = `⚠️ *Tarefas que precisam de atenção*\n_Acesse o BY Finance para atualizar_\n\n`;

        for (const t of atrasadas.slice(0, 5)) {
          msg += `• ${t.titulo || t.desc} — ⚠ *ATRASADA* _(${fmtData(t.prazo)})_\n`;
        }
        for (const t of hoje_list.slice(0, 5)) {
          msg += `• ${t.titulo || t.desc} — 📅 *HOJE*\n`;
        }
        if (proximas.length > 0) {
          msg += `\n📋 _${proximas.length} tarefa${proximas.length>1?'s':''} futura${proximas.length>1?'s':''} pendente${proximas.length>1?'s':''}_\n`;
        }

        msg += `\n━━━━━━━━━━━━━━\n_BY Persona Finance_`;

        for (const chat_id of chatIds) {
          await sendTg(chat_id, msg);
          enviados++;
        }

        console.log(`Tarefas enviadas para user ${uid} (${chatIds.length} chat(s))`);
      } catch (err) {
        console.error(`Erro ao processar user ${user_id}:`, err.message);
      }
    }

    console.log(`Cron tarefas finalizado. ${enviados} envios.`);
    return res.status(200).json({ ok: true, enviados });

  } catch (err) {
    console.error('Erro no cron-tarefas:', err);
    return res.status(500).json({ error: err.message });
  }
}
