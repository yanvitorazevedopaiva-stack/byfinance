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

function fmtData(data) {
  if (!data) return '';
  const [y, m, d] = data.split('-');
  return `${d}/${m}/${y}`;
}

function fmtCartao(cartao) {
  if (!cartao) return 'Não informado';
  return cartao
    .replace(/nubank/gi, 'Nubank')
    .replace(/\binter\b/gi, 'Inter')
    .replace(/ita[uú]/gi, 'Itaú')
    .replace(/bradesco/gi, 'Bradesco')
    .replace(/caixa/gi, 'Caixa')
    .replace(/\bpix\b/gi, 'PIX')
    .replace(/dinheiro/gi, 'Dinheiro')
    .replace(/d[eé]bito/gi, 'Débito')
    .replace(/c[ré]dito/gi, 'Crédito');
}

function iconeModalidade(forma) {
  if (!forma) return '💳';
  const f = forma.toLowerCase();
  if (f.includes('pix')) return '🔄';
  if (f.includes('débito') || f.includes('debito')) return '💳';
  if (f.includes('dinheiro') || f.includes('especie') || f.includes('espécie')) return '💵';
  if (f.includes('crédito') || f.includes('credito')) return '💳';
  return '💳';
}

async function getContexto(chat_id) {
  try {
    const data = await supabaseQuery(`/telegram_contexto?chat_id=eq.${chat_id}&select=contexto`);
    return data?.[0]?.contexto || {};
  } catch(e) { return {}; }
}

async function setContexto(chat_id, contexto) {
  try {
    const existing = await supabaseQuery(`/telegram_contexto?chat_id=eq.${chat_id}&select=id`);
    if (existing && existing.length > 0) {
      await supabaseQuery(`/telegram_contexto?chat_id=eq.${chat_id}`, 'PATCH', {
        contexto,
        updated_at: new Date().toISOString()
      });
    } else {
      await supabaseQuery('/telegram_contexto', 'POST', {
        chat_id,
        contexto,
        updated_at: new Date().toISOString()
      });
    }
  } catch(e) {
    console.error('Erro setContexto:', e);
  }
}

async function limparContexto(chat_id) {
  await supabaseQuery(`/telegram_contexto?chat_id=eq.${chat_id}`, 'PATCH', {
    contexto: {},
    updated_at: new Date().toISOString()
  });
}

async function salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original) {
  const registro = {
    user_id,
    descricao: gasto.descricao,
    valor: gasto.valor,
    categoria: gasto.categoria || 'Outros',
    cartao: gasto.cartao || 'Não informado',
    modalidade: gasto.modalidade || gasto.cartao || 'Não informado',
    data_lancamento: gasto.data_lancamento,
    origem: 'telegram',
    tipo_midia,
    mensagem_original,
    chat_id,
    status: 'pendente',
    parcelas: gasto.parcelas || null,
    valor_parcela: gasto.valor_parcela || null,
    observacao: gasto.observacao || null
  };
  console.log('Salvando pendente:', JSON.stringify(registro));
  const resultado = await supabaseQuery('/telegram_pendentes', 'POST', registro);
  console.log('Resultado save:', JSON.stringify(resultado));
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
  const text = await res.text();
  if (!text || text.trim() === '') return [];
  try { return JSON.parse(text); } catch(e) { return []; }
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
  const texto = msg.text || msg.caption || '';

  try {
    // 1. Verifica se o chat_id já está vinculado
    const vincRes = await supabaseQuery(
      `/telegram_vinculos?chat_id=eq.${chat_id}&select=user_id`
    );
    const vinculo = vincRes?.[0];

    // 2. Se NÃO vinculado — verifica se está enviando um token
    if (!vinculo) {
      const tokenLimpo = texto.trim().replace(/\s/g, '');

      const tokenRes = await supabaseQuery(
        `/telegram_tokens?token=eq.${tokenLimpo}&usado=eq.false&select=user_id,token,expires_at`
      );
      const tokenData = tokenRes?.[0];

      if (!tokenData) {
        await sendTelegram(chat_id,
          `👋 *Olá! Bem-vindo ao BY Finance Bot!*\n\n` +
          `Para começar a usar, você precisa vincular sua conta:\n\n` +
          `1️⃣ Acesse o BY Finance no navegador\n` +
          `2️⃣ Vá em *Configurações → Telegram*\n` +
          `3️⃣ Clique em *"Gerar Código de Acesso"*\n` +
          `4️⃣ Envie o código de 6 dígitos aqui\n\n` +
          `_O código expira em 10 minutos._`
        );
        return res.status(200).json({ ok: true });
      }

      if (new Date(tokenData.expires_at) < new Date()) {
        await sendTelegram(chat_id,
          `⏰ *Código expirado!*\n\nGere um novo código em *Configurações → Telegram* no BY Finance.`
        );
        return res.status(200).json({ ok: true });
      }

      await supabaseQuery('/telegram_vinculos', 'POST', {
        user_id: tokenData.user_id,
        chat_id,
        vinculado_em: new Date().toISOString()
      });

      await supabaseQuery(
        `/telegram_tokens?user_id=eq.${tokenData.user_id}`,
        'PATCH',
        { usado: true }
      );

      await sendTelegram(chat_id,
        `✅ *Conta vinculada com sucesso!*\n\n` +
        `Agora você pode enviar seus gastos por:\n` +
        `💬 *Texto:* "gastei 47 no iFood cartão Nubank"\n` +
        `🎤 *Áudio:* grave falando o gasto\n` +
        `📸 *Foto:* print de notificação ou comprovante\n\n` +
        `_Todos os lançamentos aguardarão sua autorização no app._`
      );
      return res.status(200).json({ ok: true });
    }

    // 3. JÁ VINCULADO — processa normalmente
    const user_id = vinculo.user_id;

    let tipo_midia = 'texto';
    let audioUrl = null;
    let fotoUrl = null;
    let mimeType = null;
    let mensagem_original = texto;

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
      mensagem_original = msg.caption ? `[Foto] ${msg.caption}` : '[Foto]';
    }

    // Carrega contexto anterior
    const ctx = await getContexto(chat_id);

    // Se tem lançamento parcial aguardando complemento
    if (ctx.aguardando && texto) {
      const campo = ctx.aguardando;
      const gasto = ctx.gasto_parcial || {};

      // Preenche o campo que estava aguardando
      if (campo === 'cartao') {
        gasto.cartao = texto;
        gasto.tipo = 'lancamento';
        // Cartão preenchido → próximo passo obrigatório: modalidade
        if (!gasto.modalidade) {
          await setContexto(chat_id, { aguardando: 'modalidade', gasto_parcial: gasto });
          await sendTelegram(chat_id,
            `${iconeModalidade('')} Como foi o pagamento?\n\n` +
            `🔄 PIX\n💳 Crédito\n💳 Débito\n💵 Dinheiro`
          );
          return res.status(200).json({ ok: true });
        }
      } else if (campo === 'modalidade') {
        gasto.modalidade = texto;
        gasto.tipo = 'lancamento';
      } else if (campo === 'valor') {
        const num = parseFloat(texto.replace(',', '.').replace(/[^\d.]/g, ''));
        if (!isNaN(num)) gasto.valor = num;
        gasto.tipo = 'lancamento';
      } else if (campo === 'categoria') {
        gasto.categoria = texto;
        gasto.tipo = 'lancamento';
      }

      // Verifica se ainda falta valor
      if (!gasto.valor || isNaN(gasto.valor)) {
        await setContexto(chat_id, { aguardando: 'valor', gasto_parcial: gasto });
        await sendTelegram(chat_id, `💰 Qual o valor gasto?`);
        return res.status(200).json({ ok: true });
      }
      // Verifica se ainda falta cartão
      if (!gasto.cartao || gasto.cartao === 'Não informado') {
        await setContexto(chat_id, { aguardando: 'cartao', gasto_parcial: gasto });
        await sendTelegram(chat_id,
          `💳 Qual cartão ou forma de pagamento?\n\n` +
          `Responda com: Nubank, Inter, PIX, Dinheiro, Débito...`
        );
        return res.status(200).json({ ok: true });
      }
      // Verifica se ainda falta modalidade
      if (!gasto.modalidade) {
        await setContexto(chat_id, { aguardando: 'modalidade', gasto_parcial: gasto });
        await sendTelegram(chat_id,
          `${iconeModalidade('')} Como foi o pagamento?\n\n` +
          `🔄 PIX\n💳 Crédito\n💳 Débito\n💵 Dinheiro`
        );
        return res.status(200).json({ ok: true });
      }

      // Tudo preenchido — salva e limpa contexto
      await limparContexto(chat_id);
      await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original);
      const valor = parseFloat(gasto.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      await sendTelegram(chat_id,
        `✅ *Lançamento registrado!*\n\n` +
        `📝 ${gasto.descricao}\n` +
        `💰 ${valor}\n` +
        `🏷 ${gasto.categoria}\n` +
        `💳 ${fmtCartao(gasto.cartao)}\n` +
        `${iconeModalidade(gasto.modalidade)} ${gasto.modalidade || 'Não informado'}\n` +
        `📅 ${fmtData(gasto.data_lancamento)}\n\n` +
        `⏳ Aguardando sua autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`
      );
      return res.status(200).json({ ok: true });
    }

    const gasto = await interpretarComGemini({ texto, audioUrl, fotoUrl, mimeType });

    if (gasto.tipo === 'erro' || gasto.erro) {
      await sendTelegram(chat_id,
        `❌ Não consegui identificar um gasto.\n\n` +
        `Tente assim: _"gastei 47 reais no iFood cartão Nubank"_`
      );
      return res.status(200).json({ ok: true });
    }

    if (gasto.tipo === 'consulta') {
      await sendTelegram(chat_id,
        `📊 Consultas ainda não estão disponíveis pelo bot.\n` +
        `Acesse o BY Finance para ver seus relatórios.`
      );
      return res.status(200).json({ ok: true });
    }

    if (gasto.tipo === 'comando' && gasto.acao === 'cancelar_ultimo') {
      const ultimos = await supabaseQuery(
        `/telegram_pendentes?user_id=eq.${user_id}&status=eq.pendente&order=created_at.desc&limit=1`
      );
      if (ultimos?.[0]) {
        await supabaseQuery(`/telegram_pendentes?id=eq.${ultimos[0].id}`, 'PATCH', { status: 'rejeitado' });
        await sendTelegram(chat_id, `✅ Último lançamento cancelado.`);
      } else {
        await sendTelegram(chat_id, `⚠ Nenhum lançamento pendente para cancelar.`);
      }
      return res.status(200).json({ ok: true });
    }

    const lancamentos = gasto.tipo === 'multiplos' ? gasto.lancamentos : [gasto];

    // Verifica se lançamento único está sem cartão
    if (gasto.tipo === 'lancamento' && (!gasto.cartao || gasto.cartao === 'Não informado')) {
      await setContexto(chat_id, { aguardando: 'cartao', gasto_parcial: gasto });
      await sendTelegram(chat_id,
        `Entendi o gasto! 💳 Qual cartão ou forma de pagamento?\n\n` +
        `Ex: Nubank, Inter, PIX, Dinheiro, Débito...`
      );
      return res.status(200).json({ ok: true });
    }
    // Verifica modalidade
    if (gasto.tipo === 'lancamento' && !gasto.modalidade) {
      await setContexto(chat_id, { aguardando: 'modalidade', gasto_parcial: gasto });
      await sendTelegram(chat_id,
        `${iconeModalidade('')} Como foi o pagamento?\n\n` +
        `🔄 PIX\n💳 Crédito\n💳 Débito\n💵 Dinheiro`
      );
      return res.status(200).json({ ok: true });
    }

    for (const l of lancamentos) {
      await salvarPendente(chat_id, user_id, l, tipo_midia, mensagem_original);
    }

    if (gasto.tipo === 'multiplos') {
      const lista = lancamentos.map(l =>
        `• ${l.descricao} — ${parseFloat(l.valor).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}`
      ).join('\n');
      await sendTelegram(chat_id,
        `✅ *${lancamentos.length} lançamentos registrados!*\n\n${lista}\n\n` +
        `⏳ Aguardando autorização no BY Finance.`
      );
    } else {
      const valor = parseFloat(gasto.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const parcelaInfo = gasto.parcelas ? `\n🔄 ${gasto.parcelas}x de ${parseFloat(gasto.valor_parcela).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}` : '';
      await sendTelegram(chat_id,
        `✅ *Lançamento registrado!*\n\n` +
        `📝 ${gasto.descricao}\n` +
        `💰 ${valor}${parcelaInfo}\n` +
        `🏷 ${gasto.categoria}\n` +
        `💳 ${fmtCartao(gasto.cartao)}\n` +
        `${iconeModalidade(gasto.modalidade)} ${gasto.modalidade || 'Não informado'}\n` +
        `📅 ${fmtData(gasto.data_lancamento)}\n\n` +
        `⏳ Aguardando sua autorização no BY Finance.\n` +
        `Você tem *7 dias* para aprovar ou rejeitar.`
      );
    }

  } catch (err) {
    console.error('Erro no webhook:', err);
    await sendTelegram(chat_id, '❌ Erro interno. Tente novamente.');
  }

  return res.status(200).json({ ok: true });
}