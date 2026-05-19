// api/telegram.js — BY Finance Telegram Bot Webhook
// Deploy: Vercel Serverless Function

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY     = process.env.GEMINI_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY; // service_role key (não a publishable)

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sendTelegram(chat_id, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'Markdown' }),
  });
}

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
  return res.json();
}

// Busca usuário pelo número de telefone cadastrado
async function getUserByChatId(phone) {
  // phone vem como +5521999999999 do Telegram
  const data = await supabaseQuery(
    `/user_data?select=user_id,data&data->>phone=eq.${encodeURIComponent(phone)}`
  );
  return data?.[0] || null;
}

// Baixa arquivo de áudio/foto do Telegram
async function getTelegramFileUrl(file_id) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${file_id}`
  );
  const data = await res.json();
  const path = data?.result?.file_path;
  return path ? `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${path}` : null;
}

// Converte URL em base64
async function urlToBase64(url) {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ── Gemini ───────────────────────────────────────────────────────────────────

async function interpretarComGemini({ texto, audioUrl, fotoUrl, mimeType }) {
  const prompt = `Você é um assistente financeiro. Extraia as informações de gasto da mensagem abaixo e retorne SOMENTE um JSON válido, sem markdown, sem explicação.

Formato obrigatório:
{
  "descricao": "descrição do gasto",
  "valor": 47.00,
  "categoria": "Alimentação",
  "cartao": "Nubank",
  "data_lancamento": "2025-05-18"
}

Categorias possíveis: Alimentação, Transporte, Mercado, Saúde, Lazer, Moradia, Vestuário, Educação, Serviços, Outros.
Se não souber o cartão, use "Não informado".
Se não souber a data, use a data de hoje: ${new Date().toISOString().split('T')[0]}.
Se não conseguir identificar um gasto, retorne: {"erro": "não identificado"}`;

  let contents = [];

  if (fotoUrl) {
    const b64 = await urlToBase64(fotoUrl);
    contents = [{
      parts: [
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: b64 } },
        { text: prompt }
      ]
    }];
  } else if (audioUrl) {
    const b64 = await urlToBase64(audioUrl);
    contents = [{
      parts: [
        { inline_data: { mime_type: mimeType || 'audio/ogg', data: b64 } },
        { text: prompt }
      ]
    }];
  } else {
    contents = [{
      parts: [{ text: `${prompt}\n\nMensagem: ${texto}` }]
    }];
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents }),
    }
  );

  const data = await res.json();
  console.log('Gemini raw:', JSON.stringify(data));
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { erro: 'falha ao interpretar' };
  }
}

// ── Handler principal ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;
  const msg = update?.message;
  if (!msg) return res.status(200).json({ ok: true });

  const chat_id = msg.chat.id;
  const from = msg.from;

  // Detecta tipo de mídia
  let tipo_midia = 'texto';
  let texto = msg.text || '';
  let audioUrl = null;
  let fotoUrl = null;
  let mimeType = null;
  let mensagem_original = texto;

  try {
    if (msg.voice || msg.audio) {
      tipo_midia = 'audio';
      const file_id = (msg.voice || msg.audio).file_id;
      mimeType = msg.voice ? 'audio/ogg' : 'audio/mpeg';
      audioUrl = await getTelegramFileUrl(file_id);
      mensagem_original = '[Áudio]';
    } else if (msg.photo) {
      tipo_midia = 'foto';
      const file_id = msg.photo[msg.photo.length - 1].file_id;
      mimeType = 'image/jpeg';
      fotoUrl = await getTelegramFileUrl(file_id);
      mensagem_original = '[Foto]';
      if (msg.caption) {
        texto = msg.caption;
        mensagem_original = `[Foto] ${msg.caption}`;
      }
    }

    // Valida se o número do usuário está cadastrado no sistema
    // Por enquanto aceita qualquer mensagem e retorna o lançamento
    // TODO: validar phone quando Supabase tiver campo phone na user_data

    // Interpreta com Gemini
    const gasto = await interpretarComGemini({ texto, audioUrl, fotoUrl, mimeType });

    if (gasto.erro) {
      await sendTelegram(chat_id,
        `❌ Não consegui identificar um gasto na sua mensagem.\n\nTente assim: _"gastei 47 reais no iFood cartão Nubank"_`
      );
      return res.status(200).json({ ok: true });
    }

    // Salva no Supabase como pendente
    // Nota: sem user_id por enquanto (validação de phone pendente)
    // Salva chat_id para notificar depois
    const registro = {
      descricao: gasto.descricao,
      valor: gasto.valor,
      categoria: gasto.categoria || 'Outros',
      cartao: gasto.cartao || 'Não informado',
      data_lancamento: gasto.data_lancamento,
      origem: 'telegram',
      tipo_midia,
      mensagem_original,
      chat_id,
      status: 'pendente',
    };

    await supabaseQuery('/telegram_pendentes', 'POST', registro);

    // Responde no Telegram
    const valor = parseFloat(gasto.valor).toLocaleString('pt-BR', {
      style: 'currency', currency: 'BRL'
    });

    await sendTelegram(chat_id,
      `✅ *Lançamento registrado!*\n\n` +
      `📝 ${gasto.descricao}\n` +
      `💰 ${valor}\n` +
      `🏷 ${gasto.categoria}\n` +
      `💳 ${gasto.cartao}\n` +
      `📅 ${gasto.data_lancamento}\n\n` +
      `⏳ Aguardando sua autorização no BY Finance.\n` +
      `Você tem *7 dias* para aprovar ou rejeitar.`
    );

  } catch (err) {
    console.error('Erro no webhook:', err);
    await sendTelegram(chat_id, '❌ Erro interno. Tente novamente em instantes.');
  }

  return res.status(200).json({ ok: true });
}