// api/cron-alertas.js — BY Finance: Digest diário de alertas
// Cron: 0 12 * * * (9h Brasília / 12h UTC)
// Também chamado via GET /api/cron-alertas para testes manuais

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
               'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const DIAS_SEMANA = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];

async function sb(path, method = 'GET', body = null) {
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

function fmtData(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Calcula dias até o dia D do mês (considerando virada de mês)
function diasAte(diaAlvo, hoje) {
  const hojeDay = hoje.getDate();
  if (diaAlvo >= hojeDay) return diaAlvo - hojeDay;
  // Próximo mês
  const proximoMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, diaAlvo);
  return Math.round((proximoMes - hoje) / (1000 * 60 * 60 * 24));
}

// Monta o resumo completo de alertas para um user_id
async function buildResumo(user_id) {
  const original_uid = user_id; // UUID original — usado para queries em telegram_pendentes
  // Resolve UUID → username (telegram_vinculos armazena UUID, dados estão no username)
  if (user_id && user_id.includes('-')) {
    const uidMap = await sb(`/user_data?user_id=eq.__uid__${user_id}&select=data`);
    const mapped = uidMap?.[0]?.data?.username;
    if (mapped) user_id = mapped;
  }

  const [userData, pendentes] = await Promise.all([
    sb(`/user_data?user_id=eq.${user_id}&select=data`),
    sb(`/telegram_pendentes?user_id=eq.${original_uid}&status=eq.pendente&select=id,descricao,valor,data_lancamento,tipo&order=created_at.asc`)
  ]);

  const dados = userData?.[0]?.data || {};
  const hoje  = new Date();
  const hojeISO = hoje.toISOString().split('T')[0];
  const mesAtual = hoje.getMonth();

  // ── 1. DÉFICIT / SUPERÁVIT ──
  const faturas       = dados[user_id + '_faturas']       || {};
  const gastosFixos   = dados[user_id + '_gastosFixos']   || [];
  const receitasFixas  = dados[user_id + '_receitasFixas'] || [];
  const receitasVar    = dados[user_id + '_receitas'] || {};
  const mesKey         = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;
  const receitasVarMes = (receitasVar[mesKey] || []).reduce((a, r) => a + (r.val || r.valor || 0), 0);

  const cartoes = dados[user_id + '_cartoes'] || [];
  const _diaHoje = hoje.getDate();
  const _menorVenc = cartoes.reduce((min,c)=>c.vencimento?Math.min(min,parseInt(c.vencimento)):min,31);
  const _mesFatura = _diaHoje >= _menorVenc ? (mesAtual + 1) % 12 : mesAtual;
  const totalFatMes   = Object.values(faturas).reduce((a, arr) => a + (arr[_mesFatura] || 0), 0);
  const totalGf       = gastosFixos.reduce((a, g) => a + (g.val || 0), 0);
  // Se há receitas variáveis lançadas no mês, usa elas (já incluem tudo lançado)
  // Caso contrário, usa as fixas como previsão
  const totalRecFixas = receitasFixas.reduce((a, r) => a + (r.val || 0), 0);
  const totalReceitas = receitasVarMes > 0 ? receitasVarMes : totalRecFixas;
  const resultado     = totalReceitas - totalFatMes - totalGf;
  const isPositivo    = resultado >= 0;

  // ── 2. TAREFAS PENDENTES ──
  const tarefas        = dados[user_id + '_tarefas'] || [];
  const tarefasPend    = tarefas.filter(t => !t.concluida);
  const tarefasHoje    = tarefasPend.filter(t => t.prazo && t.prazo === hojeISO);
  const tarefasAtraso  = tarefasPend.filter(t => t.prazo && t.prazo < hojeISO);
  const tarefasFuturas = tarefasPend.filter(t => !t.prazo || t.prazo > hojeISO);

  // ── 3. VENCIMENTOS PRÓXIMOS (7 dias) ──
  const vencimentos = [];
  for (const g of gastosFixos) {
    if (!g.vencimento) continue;
    const diff = diasAte(parseInt(g.vencimento), hoje);
    if (diff >= 0 && diff <= 7) {
      vencimentos.push({ nome: g.desc||g.nome||'Gasto Fixo', tipo: 'Conta/Fixo', dia: g.vencimento, diff, val: g.val });
    }
  }
  for (const c of cartoes) {
    if (c.fechamento) {
      const diff = diasAte(parseInt(c.fechamento), hoje);
      if (diff >= 0 && diff <= 7)
        vencimentos.push({ nome: c.nome, tipo: 'Fechamento', dia: c.fechamento, diff });
    }
    if (c.vencimento) {
      // Ajusta para próximo dia útil se cair em fim de semana
      const _vd = new Date(hoje.getFullYear(), hoje.getMonth(), parseInt(c.vencimento));
      if(_vd.getDay()===6) _vd.setDate(_vd.getDate()+2);
      if(_vd.getDay()===0) _vd.setDate(_vd.getDate()+1);
      const diff = diasAte(_vd.getDate(), hoje);
      if (diff >= 0 && diff <= 7)
        vencimentos.push({ nome: c.nome, tipo: 'Vencimento Fatura', dia: c.vencimento, diff });
    }
  }
  vencimentos.sort((a, b) => a.diff - b.diff);

  // ── 4. COMPRAS EXPIRANDO ──
  const comprasLista = dados[user_id + '_compras_lista'] || [];
  const comprasExpirando = comprasLista.filter(c => {
    if(c.status !== 'aguardando' || !c.data) return false;
    const dias = Math.floor((hoje - new Date(c.data)) / (1000*60*60*24));
    return dias >= 27 && dias <= 30;
  });

  // ── MONTA MENSAGEM ──
  const horaBrasilia = new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours();
  const [emoji, saudacao] = horaBrasilia < 12 ? ['🌅','Bom dia']
    : horaBrasilia < 18 ? ['☀️','Boa tarde'] : ['🌙','Boa noite'];
  const diaSemana = DIAS_SEMANA[hoje.getDay()];
  const dataFmt   = `${diaSemana}, ${String(hoje.getDate()).padStart(2,'0')} de ${MESES[mesAtual]}`;

  let msg = `${emoji} *${saudacao}!* — BY Finance\n_${dataFmt}_\n\n`;

  // Bloco déficit/superávit
  msg += `━━━ *RESULTADO ${MESES[_mesFatura].toUpperCase()}* ━━━\n`;
  msg += `💰 *Receitas: ${fmt(totalReceitas)}*\n`;
  if(totalRecFixas>0) msg += `   ↳ Fixas: ${fmt(totalRecFixas)}\n`;
  if(receitasVarMes>0) msg += `   ↳ Variáveis: ${fmt(receitasVarMes)}\n`;
  msg += `💳 Faturas: *-${fmt(totalFatMes)}*\n`;
  msg += `📋 Gastos Fixos: *-${fmt(totalGf)}*\n`;
  msg += isPositivo
    ? `▲ *SUPERÁVIT: ${fmt(resultado)}* ✅\n`
    : `▼ *DÉFICIT: ${fmt(Math.abs(resultado))}* ⚠️\n`;

  // Bloco gastos pendentes
  if (pendentes && pendentes.length > 0) {
    const despesas  = pendentes.filter(p => p.tipo !== 'receita');
    const receitas  = pendentes.filter(p => p.tipo === 'receita');
    msg += `\n━━━ *GASTOS PENDENTES* ━━━\n`;
    msg += `_${pendentes.length} lançamento${pendentes.length > 1 ? 's' : ''} aguardando autorização no app_\n\n`;
    for (const p of despesas.slice(0, 6)) {
      msg += `▸ ${p.descricao || '(sem descrição)'} — *${fmt(p.valor)}*\n`;
    }
    if (receitas.length > 0) {
      msg += `\n💚 Receitas pendentes: ${receitas.length}\n`;
    }
    if (pendentes.length > 6) msg += `_...e mais ${pendentes.length - 6}_\n`;
  }

  // Bloco tarefas pendentes
  if (tarefasPend.length > 0) {
    msg += `\n━━━ *TAREFAS PENDENTES* ━━━\n`;
    if (tarefasAtraso.length > 0) {
      msg += `⚠️ *Atrasadas (${tarefasAtraso.length}):*\n`;
      for (const t of tarefasAtraso.slice(0, 3)) {
        msg += `• ${t.titulo || t.desc} — _{prazo: ${fmtData(t.prazo)}}_\n`;
      }
    }
    if (tarefasHoje.length > 0) {
      msg += `📅 *Para hoje (${tarefasHoje.length}):*\n`;
      for (const t of tarefasHoje) {
        msg += `• ${t.titulo || t.desc}\n`;
      }
    }
    if (tarefasFuturas.length > 0) {
      const limit = tarefasFuturas.slice(0, 3);
      msg += `📋 *Próximas (${tarefasFuturas.length}):*\n`;
      for (const t of limit) {
        const prazo = t.prazo ? ` — ${fmtData(t.prazo)}` : '';
        msg += `• ${t.titulo || t.desc}${prazo}\n`;
      }
      if (tarefasFuturas.length > 3) msg += `_...e mais ${tarefasFuturas.length - 3}_\n`;
    }
  }

  // Bloco vencimentos
  if (vencimentos.length > 0) {
    msg += `\n━━━ *VENCIMENTOS PRÓXIMOS* ━━━\n`;
    for (const v of vencimentos.slice(0, 5)) {
      const label = v.diff === 0 ? '*HOJE*' : v.diff === 1 ? 'amanhã' : `em ${v.diff} dias`;
      const val   = v.val ? ` — ${fmt(v.val)}` : '';
      msg += `📅 ${v.nome} (${v.tipo} dia ${v.dia})${val} — ${label}\n`;
    }
  }

  if(comprasExpirando.length > 0){
    msg += `\n━━━ *COMPRAS EXPIRANDO* ━━━\n`;
    for(const c of comprasExpirando){
      const dias = Math.floor((hoje - new Date(c.data)) / (1000*60*60*24));
      const restam = 30 - dias;
      msg += `⏰ *${c.desc}* — ${fmt(c.val)} — expira em *${restam} dia${restam!==1?'s':''}*\n`;
    }
  }

  // ── 5. PARCELAS DE TERCEIROS — alerta no dia do fechamento/vencimento ──
  const parcelas = dados[user_id + '_parcelas'] || [];
  const cartoes2 = dados[user_id + '_cartoes'] || [];
  const diaHoje = hoje.getDate();
  const alertasTerceiros = [];

  parcelas.filter(p => p.terceiro && p.paga < p.total).forEach(p => {
    const cartao = cartoes2.find(c => c.nome === p.cartao);
    if(!cartao) return;
    const fechDia = parseInt(cartao.fechamento) || 0;
    const vencDia = parseInt(cartao.vencimento) || 0;
    const parcRestante = p.total - p.paga;

    if(fechDia > 0){
      const _fechD = new Date(hoje.getFullYear(), hoje.getMonth(), fechDia);
      if(_fechD.getDay()===6) _fechD.setDate(_fechD.getDate()+2);
      if(_fechD.getDay()===0) _fechD.setDate(_fechD.getDate()+1);
      if(diaHoje === _fechD.getDate()){
        alertasTerceiros.push(`💳 Fatura *${p.cartao}* fecha hoje — cobra *${p.terceiro}* por *${p.desc}* (${fmt(p.val)}/mês · ${parcRestante}x restantes)`);
      }
    }

    if(vencDia > 0){
      const _vencD = new Date(hoje.getFullYear(), hoje.getMonth(), vencDia);
      if(_vencD.getDay()===6) _vencD.setDate(_vencD.getDate()+2);
      if(_vencD.getDay()===0) _vencD.setDate(_vencD.getDate()+1);
      if(diaHoje === _vencD.getDate()){
        alertasTerceiros.push(`⚠️ Vencimento hoje — lembrou de cobrar *${p.terceiro}* por *${p.desc}*? (${fmt(p.val)})`);
      }
    }
  });
  if(alertasTerceiros.length > 0){
    msg += `\n━━━ *COBRANÇAS DE TERCEIROS* ━━━\n`;
    alertasTerceiros.forEach(a => msg += a + '\n');
  }

  // Nada a reportar
  const temAlgo = (pendentes && pendentes.length > 0) || tarefasPend.length > 0 || vencimentos.length > 0 || comprasExpirando.length > 0 || alertasTerceiros.length > 0;
  if (!temAlgo) {
    msg += `\n✅ *Tudo em dia!* Nenhum pendente, tarefa ou vencimento nos próximos 7 dias.\n`;
  }

  msg += `\n━━━━━━━━━━━━━━\n_BY Persona Finance_`;
  return msg;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Segurança: se POST com body {chat_id, user_id}, envia só para aquele usuário (uso do bot on-demand)
  if (req.method === 'POST' && req.body?.chat_id && req.body?.user_id) {
    const { chat_id, user_id } = req.body;
    const msg = await buildResumo(user_id);
    await sendTg(chat_id, msg);
    return res.status(200).json({ ok: true });
  }

  console.log('Cron alertas iniciado:', new Date().toISOString());

  try {
    const vinculos = await sb('/telegram_vinculos?select=user_id,chat_id');
    if (!vinculos || !vinculos.length) {
      console.log('Nenhum vínculo encontrado.');
      return res.status(200).json({ ok: true, enviados: 0 });
    }

    // Agrupa chat_ids por user_id para evitar múltiplas queries de dados
    const porUser = {};
    for (const v of vinculos) {
      if (!porUser[v.user_id]) porUser[v.user_id] = [];
      porUser[v.user_id].push(v.chat_id);
    }

    let enviados = 0;
    for (const [user_id, chatIds] of Object.entries(porUser)) {
      try {
        const msg = await buildResumo(user_id);
        for (const chat_id of chatIds) {
          await sendTg(chat_id, msg);
          enviados++;
        }
        console.log(`Resumo enviado para user ${user_id} (${chatIds.length} chat(s))`);
      } catch (err) {
        console.error(`Erro ao enviar para user ${user_id}:`, err.message);
      }
    }

    console.log(`Cron finalizado. ${enviados} envios.`);
    return res.status(200).json({ ok: true, enviados });

  } catch (err) {
    console.error('Erro no cron-alertas:', err);
    return res.status(500).json({ error: err.message });
  }
}
