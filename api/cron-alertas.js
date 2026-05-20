// api/cron-alertas.js — BY Finance: Cron diário de alertas via Telegram
// Executa todo dia às 9h (UTC) conforme vercel.json
// Envia alertas de vencimentos e lançamentos pendentes para usuários vinculados

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;

async function supabaseQuery(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': method === 'POST' ? 'return=representation' : '',
    },
    body: body ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  if (!text || text.trim() === '') return [];
  try { return JSON.parse(text); } catch(e) { return []; }
}

async function sendTelegram(chat_id, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'Markdown' }),
  });
}

function fmtValor(v) {
  return parseFloat(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default async function handler(req, res) {
  // Aceita GET (cron do Vercel) ou POST (chamada manual)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('Cron alertas iniciado:', new Date().toISOString());

  try {
    // Busca todos os vínculos Telegram ativos
    const vinculos = await supabaseQuery('/telegram_vinculos?select=user_id,chat_id');
    if (!vinculos || !vinculos.length) {
      console.log('Nenhum vínculo encontrado.');
      return res.status(200).json({ ok: true, enviados: 0 });
    }

    let enviados = 0;

    for (const vinculo of vinculos) {
      const { user_id, chat_id } = vinculo;
      const alertas = [];

      // 1. Lançamentos pendentes de autorização
      const pendentes = await supabaseQuery(
        `/telegram_pendentes?user_id=eq.${user_id}&status=eq.pendente&select=id,descricao,valor`
      );
      if (pendentes && pendentes.length > 0) {
        const lista = pendentes.slice(0, 5).map(p =>
          `• ${p.descricao} — ${fmtValor(p.valor)}`
        ).join('\n');
        const extra = pendentes.length > 5 ? `\n_...e mais ${pendentes.length - 5} pendente(s)_` : '';
        alertas.push(
          `📋 *${pendentes.length} lançamento(s) aguardando autorização:*\n\n${lista}${extra}\n\n` +
          `→ Acesse o BY Finance para autorizar ou rejeitar.`
        );
      }

      // 2. Tarefas urgentes (prazo hoje ou atrasadas)
      const userData = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
      const tarefas = userData?.[0]?.data?.tarefas || [];
      const hoje = new Date().toISOString().split('T')[0];
      const urgentes = tarefas.filter(t => !t.concluida && t.prazo && t.prazo <= hoje);

      // Envia resumo de lançamentos pendentes
      if (alertas.length > 0) {
        const horaBrasilia = new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours();
        const saudacao = horaBrasilia >= 5 && horaBrasilia < 12
          ? '🌅 *Bom dia! Resumo BY Finance*'
          : horaBrasilia >= 12 && horaBrasilia < 18
          ? '☀️ *Boa tarde! Resumo BY Finance*'
          : '🌙 *Boa noite! Resumo BY Finance*';
        const msg = `${saudacao}\n\n` + alertas.join('\n\n---\n\n');
        await sendTelegram(chat_id, msg);
        enviados++;
        console.log(`Alerta enviado para chat_id ${chat_id} (user_id ${user_id})`);
      }

      // Envia alerta de tarefas urgentes (separado)
      if (urgentes.length > 0) {
        const txt = urgentes.map(t => {
          const atrasada = t.prazo < hoje ? '⚠ ATRASADA' : '📅 HOJE';
          return `• ${t.titulo || t.desc} — ${atrasada}`;
        }).join('\n');
        await sendTelegram(chat_id,
          `📋 *Tarefas que precisam de atenção:*\n\n${txt}\n\nAcesse o BY Finance para atualizar.`
        );
        console.log(`Tarefas urgentes enviadas para chat_id ${chat_id}: ${urgentes.length}`);
      }
    }

    console.log(`Cron finalizado. ${enviados} alertas enviados.`);
    return res.status(200).json({ ok: true, enviados });

  } catch (err) {
    console.error('Erro no cron-alertas:', err);
    return res.status(500).json({ error: err.message });
  }
}
