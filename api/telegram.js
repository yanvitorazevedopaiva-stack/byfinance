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
  const prompt = `Você é o assistente financeiro do BY Finance, um sistema financeiro pessoal brasileiro.
Seu papel é interpretar mensagens de voz, texto, fotos e comprovantes enviados pelo usuário e extrair informações de gastos.

REGRAS GERAIS:
- Responda SOMENTE com JSON válido, sem markdown, sem explicação, sem texto extra
- Se a mensagem for uma CORREÇÃO do lançamento anterior, use o tipo "correcao"
- Se for uma CONSULTA (quanto gastei?, qual meu saldo?), use o tipo "consulta"
- Se for um COMANDO (cancela, lista pendentes), use o tipo "comando"
- Se for um LANÇAMENTO normal, use o tipo "lancamento"
- Se não conseguir identificar nada, retorne {"tipo":"erro","motivo":"descrição do problema"}

FORMATO PARA LANÇAMENTO ÚNICO:
{
  "tipo": "lancamento",
  "descricao": "descrição clara do gasto",
  "valor": 47.00,
  "categoria": "Alimentação",
  "cartao": "Nubank",
  "data_lancamento": "2026-05-19",
  "parcelas": null,
  "valor_parcela": null,
  "observacao": null
}

FORMATO PARA MÚLTIPLOS LANÇAMENTOS (quando o usuário cita mais de um gasto):
{
  "tipo": "multiplos",
  "lancamentos": [
    {"descricao": "iFood", "valor": 47.00, "categoria": "Alimentação", "cartao": "Nubank", "data_lancamento": "2026-05-19", "parcelas": null},
    {"descricao": "Uber", "valor": 23.00, "categoria": "Transporte", "cartao": "Nubank", "data_lancamento": "2026-05-19", "parcelas": null}
  ]
}

FORMATO PARA PARCELAMENTO:
{
  "tipo": "lancamento",
  "descricao": "descrição do produto/serviço",
  "valor": 200.00,
  "valor_parcela": 16.67,
  "parcelas": 12,
  "categoria": "Outros",
  "cartao": "Nubank",
  "data_lancamento": "2026-05-19",
  "observacao": "Compra parcelada em 12x"
}

FORMATO PARA CORREÇÃO:
{
  "tipo": "correcao",
  "campo": "valor",
  "valor_novo": 47.00,
  "descricao_nova": null
}

FORMATO PARA CONSULTA:
{
  "tipo": "consulta",
  "pergunta": "gastos_hoje"
}

FORMATO PARA COMANDO:
{
  "tipo": "comando",
  "acao": "cancelar_ultimo"
}

CATEGORIAS DISPONÍVEIS:
Alimentação, Transporte, Mercado, Saúde, Lazer, Moradia, Vestuário, Educação, Serviços, Investimento, Outros

BANCOS E ABREVIAÇÕES (normalize sempre para o nome completo):
- "nu", "nubank", "roxinho" → "Nubank"
- "inter", "banco inter" → "Inter"
- "itau", "itaú" → "Itaú"
- "brad", "bradesco" → "Bradesco"
- "bb", "brasil", "banco do brasil" → "Banco do Brasil"
- "cef", "caixa" → "Caixa"
- "c6", "c6bank" → "C6 Bank"
- "xp", "xp investimentos" → "XP"
- "next" → "Next"
- "picpay" → "PicPay"
- "pagbank", "pagseguro" → "PagBank"
- "mercado pago", "mp" → "Mercado Pago"
- "will", "will bank" → "Will Bank"
- "neon" → "Neon"
- "débito", "debito", "dinheiro", "pix", "especie" → "Dinheiro/PIX"
- Se não informado → "Não informado"

INTERPRETAÇÃO DE VALORES:
- "47 reais" → 47.00
- "47,50" ou "47.50" → 47.50
- "mil reais" → 1000.00
- "duzentos" → 200.00
- "200 em 12x" → valor: 200.00, parcelas: 12, valor_parcela: 16.67
- "3x de 50" → valor: 150.00, parcelas: 3, valor_parcela: 50.00

INTERPRETAÇÃO DE DATAS:
- "hoje" → ${new Date().toISOString().split('T')[0]}
- "ontem" → ${new Date(Date.now()-86400000).toISOString().split('T')[0]}
- "anteontem" → ${new Date(Date.now()-172800000).toISOString().split('T')[0]}
- Se não informada → ${new Date().toISOString().split('T')[0]}

INTERPRETAÇÃO DE CATEGORIAS:
- ifood, rappi, uber eats, delivery → Alimentação
- restaurante, lanchonete, padaria, café, bar → Alimentação
- uber, 99, táxi, combustível, gasolina, pedágio, metrô, ônibus → Transporte
- supermercado, mercado, hortifruti, açougue → Mercado
- farmácia, remédio, médico, consulta, exame, hospital → Saúde
- cinema, netflix, spotify, show, festa, viagem, hotel → Lazer
- aluguel, condomínio, água, luz, internet, gás → Moradia
- roupa, calçado, acessório → Vestuário
- curso, livro, escola, faculdade → Educação
- salão, barbearia, academia, assinatura → Serviços
- ação, fundo, tesouro, criptomoeda, investimento → Investimento

COMANDOS RECONHECIDOS:
- "cancela", "cancela o último", "desfaz" → {"tipo":"comando","acao":"cancelar_ultimo"}
- "lista pendentes", "o que está pendente" → {"tipo":"comando","acao":"listar_pendentes"}
- "quanto gastei hoje", "gastos de hoje" → {"tipo":"consulta","pergunta":"gastos_hoje"}
- "quanto gastei esse mês", "total do mês" → {"tipo":"consulta","pergunta":"gastos_mes"}

PARA FOTOS E COMPROVANTES:
- Analise prints de notificação bancária extraindo valor, banco e estabelecimento
- Analise comprovantes de pagamento extraindo valor, destinatário e banco
- Analise notas fiscais extraindo itens, valor total e estabelecimento
- Se houver múltiplos itens numa nota, retorne o tipo "multiplos"
- Para PDFs de fatura, liste os principais lançamentos como "multiplos"

Data de hoje: ${new Date().toISOString().split('T')[0]}
Mensagem do usuário: `;

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
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
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