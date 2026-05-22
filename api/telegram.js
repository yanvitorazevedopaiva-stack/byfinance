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
    const data = await supabaseQuery(`/telegram_contexto?chat_id=eq.${chat_id}&select=contexto,id`);
    console.log('getContexto resultado:', JSON.stringify(data));
    return data?.[0]?.contexto || {};
  } catch(e) {
    console.error('getContexto erro:', e);
    return {};
  }
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

async function salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, remetente) {
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
    observacao: gasto.observacao || null,
    remetente: remetente || null
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
Seu papel é interpretar mensagens de voz, texto, fotos e comprovantes enviados pelo usuário.
Seja EXTREMAMENTE flexível na interpretação — o usuário pode se expressar de formas variadas e informais.

REGRAS FUNDAMENTAIS:
- Responda SOMENTE com JSON válido, sem markdown, sem explicação, sem texto extra
- NUNCA retorne erro se conseguir extrair alguma informação útil
- Prefira retornar lancamento_parcial a retornar erro
- Se for uma RECEITA (salário, renda, entrada de dinheiro), use o tipo "receita"
- Se não entender NADA, retorne {"tipo":"erro","motivo":"..."}

━━━ LANÇAMENTOS FINANCEIROS ━━━

GATILHOS DE GASTO — qualquer uma dessas expressões indica um lançamento:
Verbos: gastei, paguei, comprei, adquiri, consumi, desembolsei, investi, coloquei, botei, meti, saiu, foi, custou, valeu, cobrou
Substantivos: gasto, despesa, conta, pagamento, compra, débito, saída, custo
Inglês: spent, paid, bought, charged
Gírias: "saiu X conto", "foi X pila", "X reais fora", "X pau", "X mangos", "X conto", "uma nota de X"
Sem verbo: "pão 60", "uber 23", "netflix 45", "mercado 150", "farmácia 45"
Com símbolo: "$ 60", "R$ 80", "60,00", "60 reais", "sessenta reais"
Implícito: "80 no restaurante", "50 com uber", "200 na farmácia"

INTERPRETAR VALORES:
- Números soltos: "80", "R$80", "80 reais", "oitenta reais" → 80.00
- "mil" → 1000, "duzentos" → 200, "cinquenta" → 50
- "80,50" ou "80.50" → 80.50
- "1k" → 1000, "1.5k" → 1500
- Parcelamento: "200 em 12x", "3x de 50", "12 parcelas de 30" → extrair total e parcelas

INTERPRETAR DESCRIÇÃO:
- Local: "no mercado", "na farmácia", "no uber", "no ifood", "na academia"
- Produto: "comprei pão", "paguei netflix", "gasolina"
- Se só tiver valor → campo_faltando = "descricao"
- Se só tiver descrição → campo_faltando = "valor"

FORMATO LANÇAMENTO COMPLETO:
{
  "tipo": "lancamento",
  "descricao": "descrição clara",
  "valor": 47.00,
  "categoria": "Alimentação",
  "cartao": "Não informado",
  "modalidade": null,
  "data_lancamento": "${new Date().toISOString().split('T')[0]}",
  "parcelas": null,
  "valor_parcela": null,
  "observacao": null
}

FORMATO LANÇAMENTO PARCIAL:
{
  "tipo": "lancamento_parcial",
  "campo_faltando": "descricao",
  "descricao": null,
  "valor": 80.00,
  "categoria": "Outros",
  "cartao": "Não informado",
  "data_lancamento": "${new Date().toISOString().split('T')[0]}"
}

FORMATO MÚLTIPLOS LANÇAMENTOS:
{
  "tipo": "multiplos",
  "lancamentos": [...]
}

FORMATO PARCELAMENTO:
{
  "tipo": "lancamento",
  "descricao": "...",
  "valor": 200.00,
  "valor_parcela": 16.67,
  "parcelas": 12,
  "observacao": "Compra parcelada em 12x"
}

FORMATO CORREÇÃO:
{
  "tipo": "correcao",
  "campo": "valor",
  "valor_novo": 47.00,
  "descricao_nova": null
}

━━━ CATEGORIAS ━━━
Alimentação: ifood, rappi, uber eats, delivery, restaurante, lanchonete, padaria, café, bar, pizza, hamburger, açaí, sorvete, doceria, sushi, churrasco, refeição, almoço, jantar, café da manhã, lanche, marmita, comida
Transporte: uber, 99, táxi, combustível, gasolina, etanol, diesel, pedágio, metrô, ônibus, passagem, estacionamento, moto, bicicleta, patinete, rodoviária, aeroporto
Mercado: supermercado, mercado, hortifruti, açougue, mercearia, quitanda, feira, sacolão, atacado, assaí, carrefour, extra, pão de açúcar
Saúde: farmácia, remédio, medicamento, médico, consulta, exame, hospital, clínica, dentista, psicólogo, fisioterapeuta, plano de saúde, academia, suplemento
Lazer: cinema, netflix, spotify, amazon prime, disney, show, festa, viagem, hotel, pousada, parque, teatro, museu, ingresso, jogo, game, steam
Moradia: aluguel, condomínio, água, luz, energia, internet, gás, IPTU, seguro, reforma, manutenção, faxina, diarista
Vestuário: roupa, calçado, tênis, sapato, bolsa, acessório, moda, loja, shopping
Educação: curso, livro, escola, faculdade, mensalidade, material escolar, caneta, caderno, apostila, workshop, treinamento
Serviços: salão, barbearia, manicure, lavanderia, conserto, reparo, oficina, mecânico, encanador, eletricista, assinatura, streaming
Investimento: ação, fundo, tesouro, criptomoeda, bitcoin, poupança, CDB, LCI, LCA, previdência
Outros: qualquer coisa que não se encaixe acima

━━━ BANCOS E ABREVIAÇÕES ━━━
"nu", "nubank", "roxinho", "lilas" → "Nubank"
"inter", "banco inter", "laranjinha" → "Inter"
"itau", "itaú", "itauzinho" → "Itaú"
"brad", "bradesco", "vermelhinho" → "Bradesco"
"bb", "brasil", "banco do brasil" → "Banco do Brasil"
"cef", "caixa", "caixa economica" → "Caixa"
"c6", "c6bank", "pretinho" → "C6 Bank"
"xp", "xp invest" → "XP"
"next" → "Next"
"picpay" → "PicPay"
"pagbank", "pagseguro" → "PagBank"
"mercado pago", "mp" → "Mercado Pago"
"will", "will bank" → "Will Bank"
"neon" → "Neon"
"santander", "san" → "Santander"
"original" → "Original"
"débito", "debito" → "Débito"
"dinheiro", "especie", "espécie", "cash", "vivo" → "Dinheiro"
"pix", "transferencia", "ted", "doc" → "PIX"
Se não informado → "Não informado"

━━━ DATAS ━━━
"hoje" → ${new Date().toISOString().split('T')[0]}
"ontem" → ${new Date(Date.now()-86400000).toISOString().split('T')[0]}
"anteontem" → ${new Date(Date.now()-172800000).toISOString().split('T')[0]}
"amanhã" → ${new Date(Date.now()+86400000).toISOString().split('T')[0]}
"depois de amanhã" → ${new Date(Date.now()+172800000).toISOString().split('T')[0]}
Dias da semana: calcule o próximo dia a partir de hoje (${new Date().toISOString().split('T')[0]})
Se não informada → ${new Date().toISOString().split('T')[0]}

━━━ RECEITAS ━━━

GATILHOS DE RECEITA:
"recebi", "entrou", "caiu na conta", "depósito", "salário", "renda", "freelance", "pagamento recebido"
"transferência recebida", "Pix recebido", "rendimento", "dividendo", "aluguel recebido"
"me pagaram", "recebi de", "entrou X", "caiu X"

CATEGORIAS DE RECEITA:
Salário, Freelance, Aluguel, Investimento, Presente, Reembolso, Outros

FORMATO PARA RECEITA:
{
  "tipo": "receita",
  "descricao": "Salário",
  "valor": 3000.00,
  "categoria": "Salário",
  "conta": "Nubank",
  "data_lancamento": "${new Date().toISOString().split('T')[0]}"
}

━━━ TAREFAS ━━━

GATILHOS DE TAREFA — qualquer uma dessas expressões indica uma tarefa:
"adiciona tarefa", "cria tarefa", "nova tarefa", "anota aí", "coloca no caderno"
"lembra de", "me lembra", "não esquecer", "preciso fazer", "tenho que fazer"
"agenda X para", "marca X para", "X para sexta", "X amanhã"
"to do", "todo", "pendência", "compromisso", "obrigação"
"preciso comprar", "preciso ligar", "preciso resolver", "preciso pagar"
"deixa anotado", "registra aí", "salva aí"
Urgência: "urgente", "importante", "crítico", "não pode esquecer", "prioridade" → prioridade Alta
Sem prazo informado → pedir_prazo = true

GATILHOS DE LISTAR TAREFAS:
"minhas tarefas", "quais tarefas", "o que tenho para fazer", "pendências"
"lista tarefas", "ver tarefas", "mostrar tarefas", "tarefas do dia"
"o que está pendente", "o que falta fazer", "minha lista"

GATILHOS DE CONCLUIR TAREFA:
"concluí", "terminei", "fiz", "resolvi", "pronto", "feito", "ok a tarefa"
"marca como feito", "marca como concluído", "risca da lista"
"já fiz", "já resolvi", "já paguei", "já liguei"

ATRIBUIÇÃO DE TAREFA — qualquer uma dessas expressões:
"atribui tarefa X para Bruna", "cria tarefa X para Bruna"
"tarefa X é para Bruna", "passa tarefa X para Bruna"
"delega tarefa X para Bruna", "tarefa X fica com Bruna"
"Bruna tem que fazer X", "X é tarefa da Bruna"
"atribui para Bruna: X", "para Bruna: X"
Quando identificar nome de pessoa após "para", "à", "ao", "pra" → campo "atribuir_para": "nome"

FORMATO TAREFA COMPLETA:
{
  "tipo": "tarefa",
  "acao": "criar",
  "titulo": "Nome da tarefa",
  "prazo": "${new Date(Date.now()+86400000).toISOString().split('T')[0]}",
  "prioridade": "Alta",
  "pedir_prazo": false,
  "atribuir_para": null
}

FORMATO TAREFA COM ATRIBUIÇÃO:
{
  "tipo": "tarefa",
  "acao": "criar",
  "titulo": "Nome da tarefa",
  "prazo": null,
  "prioridade": "Media",
  "pedir_prazo": false,
  "atribuir_para": "Bruna"
}

FORMATO TAREFA SEM PRAZO:
{
  "tipo": "tarefa",
  "acao": "criar",
  "titulo": "Nome da tarefa",
  "prazo": null,
  "prioridade": "Media",
  "pedir_prazo": true,
  "atribuir_para": null
}

FORMATO LISTAR:
{"tipo":"tarefa","acao":"listar"}

FORMATO CONCLUIR:
{"tipo":"tarefa","acao":"concluir","titulo":"parte do nome"}

━━━ CONSULTAS ━━━
"quanto gastei hoje", "gastos de hoje", "total hoje" → {"tipo":"consulta","pergunta":"gastos_hoje"}
"quanto gastei esse mês", "total do mês", "meu mês" → {"tipo":"consulta","pergunta":"gastos_mes"}
"quanto tenho", "meu saldo", "situação financeira" → {"tipo":"consulta","pergunta":"saldo"}
"fatura do nu", "fatura do inter", "valor da fatura", "quanto está a fatura", "minha fatura" → {"tipo":"consulta","pergunta":"fatura","cartao":"Nubank"}
"quais faturas", "todas as faturas", "minhas faturas" → {"tipo":"consulta","pergunta":"faturas_todas"}

FORMATO CONSULTA FATURA:
{"tipo":"consulta","pergunta":"fatura","cartao":"Nubank","mes":null}
{"tipo":"consulta","pergunta":"faturas_todas","mes":null}
O campo "mes" pode ser: null (mês atual), "proximo" (próximo mês), ou número 1-12.
O campo "cartao" deve ser normalizado igual aos bancos (Nubank, Inter, Itaú, etc).

━━━ COMANDOS ━━━
"cancela", "cancela o último", "desfaz", "erro" → {"tipo":"comando","acao":"cancelar_ultimo"}
"lista pendentes", "pendentes", "o que está pendente para autorizar" → {"tipo":"comando","acao":"listar_pendentes"}

━━━ FOTOS E COMPROVANTES ━━━
- Prints de notificação bancária: extrair valor, banco e estabelecimento
- Comprovantes de pagamento: extrair valor, destinatário e banco
- Notas fiscais: extrair itens, valor total e estabelecimento
- Múltiplos itens numa nota → tipo "multiplos"
- PDFs de fatura → listar principais lançamentos como "multiplos"

Data de hoje: ${new Date().toISOString().split('T')[0]}
Mensagem: `;

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

  console.log('Chat ID:', chat_id, 'Texto:', texto);
  const ctxDebug = await getContexto(chat_id);
  console.log('Contexto carregado:', JSON.stringify(ctxDebug));

  try {
    // 1. Verifica se o chat_id já está vinculado
    const vincRes = await supabaseQuery(
      `/telegram_vinculos?chat_id=eq.${chat_id}&select=user_id,nome,principal`
    );
    const vinculo = vincRes?.[0];

    // 2. Se NÃO vinculado — verifica se está enviando um token
    if (!vinculo) {
      const tokenLimpo = texto.trim().replace(/\s/g, '');

      const tokenRes = await supabaseQuery(
        `/telegram_tokens?token=eq.${tokenLimpo}&usado=eq.false&select=user_id,token,expires_at,nome`
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
        nome: tokenData.nome || 'Usuário',
        principal: false,
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
    const nomeRemetente = vinculo.nome || 'Usuário';
    const isPrincipal = vinculo.principal === true;

    // Carrega contexto anterior
    const ctx = await getContexto(chat_id);

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
      if (msg.caption) texto = msg.caption;
    } else if (msg.document && msg.document.mime_type === 'application/pdf') {
      tipo_midia = 'pdf';
      const file_id = msg.document.file_id;
      mimeType = 'application/pdf';
      fotoUrl = await getTelegramFileUrl(file_id);
      mensagem_original = msg.caption ? `[PDF] ${msg.caption}` : '[PDF]';
      if (msg.caption) texto = msg.caption;
    }

    // ── Fluxo de contexto: resposta a pergunta anterior ──────────────────────
    if (ctx.aguardando && texto) {
      const campo = ctx.aguardando;
      const gasto = ctx.gasto_parcial || {};

      if (campo === 'prazo_tarefa_atribuida') {
        // Parse da data (igual ao prazo_tarefa)
        const hojeA = new Date(); hojeA.setHours(0,0,0,0);
        const tA = texto.toLowerCase().trim();
        let prazoA = null;
        if (tA === 'sem prazo' || tA === 'nenhum' || tA === 'sem') {
          prazoA = null;
        } else if (tA.includes('amanhã') || tA.includes('amanha')) {
          prazoA = new Date(hojeA.getTime()+86400000).toISOString().split('T')[0];
        } else if (tA.includes('depois de amanhã') || tA.includes('depois de amanha')) {
          prazoA = new Date(hojeA.getTime()+172800000).toISOString().split('T')[0];
        } else if (tA.includes('semana que vem')) {
          const d = new Date(hojeA); d.setDate(d.getDate()+(8-d.getDay())%7||7);
          prazoA = d.toISOString().split('T')[0];
        } else {
          const diasA = {segunda:1,'terça':2,terca:2,quarta:3,quinta:4,sexta:5,sabado:6,'sábado':6,domingo:0};
          for(const [nome,num] of Object.entries(diasA)){
            if(tA.includes(nome)){const d=new Date(hojeA);const diff=(num-d.getDay()+7)%7||7;d.setDate(d.getDate()+diff);prazoA=d.toISOString().split('T')[0];break;}
          }
          if(!prazoA){const mA=tA.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);if(mA){const yA=mA[3]?parseInt(mA[3])+(mA[3].length===2?2000:0):hojeA.getFullYear();prazoA=`${yA}-${String(mA[2]).padStart(2,'0')}-${String(mA[1]).padStart(2,'0')}`;}}
        }
        gasto.prazo = prazoA;
        gasto.pedir_prazo = false;
        // Cria a tarefa com atribuição
        const tarefasAtrib = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dadosAtrib = tarefasAtrib?.[0]?.data || {};
        const listaAtrib = dadosAtrib.tarefas || [];
        let novaAtrib = {
          id: Date.now(),
          titulo: gasto.titulo,
          prazo: gasto.prazo || null,
          prio: gasto.prioridade || 'Media',
          concluida: false,
          origem: 'telegram',
          origem_nome: nomeRemetente,
          atribuidor_chat_id: chat_id,
          atribuidor_nome: nomeRemetente,
          atribuido_para: gasto.atribuir_para
        };
        listaAtrib.push(novaAtrib);
        dadosAtrib.tarefas = listaAtrib;
        await fetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${user_id}`,{method:'PATCH',headers:{'Content-Type':'application/json','apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Prefer':'return=minimal'},body:JSON.stringify({data:dadosAtrib,updated_at:new Date().toISOString()})});
        await limparContexto(chat_id);
        // Notifica o destinatário
        const nomeAtribCtx = gasto.atribuir_para.toLowerCase().trim();
        const todosVinculosCtx = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&select=chat_id,nome`);
        const vinculoAtribCtx = (todosVinculosCtx || []).find(v => v.nome && v.nome.toLowerCase().includes(nomeAtribCtx));
        if (vinculoAtribCtx && vinculoAtribCtx.chat_id !== chat_id) {
          await sendTelegram(vinculoAtribCtx.chat_id,
            `📋 *${nomeRemetente} atribuiu uma tarefa para você!*\n\n` +
            `📝 ${gasto.titulo}\n` +
            `📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo definido'}\n` +
            `🎯 Prioridade: ${gasto.prioridade || 'Média'}\n\n` +
            `_Acesse o BY Finance para ver suas tarefas._`
          );
        }
        await sendTelegram(chat_id,
          `✅ *Tarefa criada e atribuída para ${gasto.atribuir_para}!*\n\n` +
          `📝 ${gasto.titulo}\n` +
          `📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo'}`
        );
        return res.status(200).json({ ok: true });

      } else if (campo === 'prazo_tarefa') {
        // Parse simples de data da resposta do usuário
        const hoje = new Date(); hoje.setHours(0,0,0,0);
        const t = texto.toLowerCase().trim();
        let prazo = null;
        if (t.includes('amanhã') || t.includes('amanha')) {
          prazo = new Date(hoje.getTime()+86400000).toISOString().split('T')[0];
        } else if (t.includes('depois de amanhã') || t.includes('depois de amanha')) {
          prazo = new Date(hoje.getTime()+172800000).toISOString().split('T')[0];
        } else if (t.includes('semana que vem')) {
          const d = new Date(hoje); d.setDate(d.getDate()+(8-d.getDay())%7||7);
          prazo = d.toISOString().split('T')[0];
        } else if (t.includes('sábado') || t.includes('sabado') || t.includes('final de semana')) {
          const d = new Date(hoje); const diff=(6-d.getDay()+7)%7||7; d.setDate(d.getDate()+diff);
          prazo = d.toISOString().split('T')[0];
        } else {
          const dias = {segunda:1,terça:2,terca:2,quarta:3,quinta:4,sexta:5,domingo:0};
          for(const [nome,num] of Object.entries(dias)){
            if(t.includes(nome)){const d=new Date(hoje);const diff=(num-d.getDay()+7)%7||7;d.setDate(d.getDate()+diff);prazo=d.toISOString().split('T')[0];break;}
          }
          // Tenta parse de data no formato DD/MM ou DD/MM/YYYY
          if(!prazo){const m=t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);if(m){const y=m[3]?parseInt(m[3])+(m[3].length===2?2000:0):hoje.getFullYear();prazo=`${y}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;}}
        }
        gasto.prazo = prazo;
        gasto.pedir_prazo = false;
        // Cria a tarefa diretamente
        const tarefasD = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dadosD = tarefasD?.[0]?.data || {};
        const listaD = dadosD.tarefas || [];
        listaD.push({id:Date.now(),titulo:gasto.titulo,prazo:gasto.prazo||null,prio:gasto.prioridade||'Media',concluida:false,origem:'telegram'});
        dadosD.tarefas = listaD;
        await fetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${user_id}`,{method:'PATCH',headers:{'Content-Type':'application/json','apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Prefer':'return=minimal'},body:JSON.stringify({data:dadosD,updated_at:new Date().toISOString()})});
        await limparContexto(chat_id);
        const prazoTxt = gasto.prazo ? ` · 📅 ${new Date(gasto.prazo+'T12:00:00').toLocaleDateString('pt-BR')}` : '';
        await sendTelegram(chat_id, `✅ *Tarefa criada!*\n\n📋 ${gasto.titulo}${prazoTxt}\n🎯 Prioridade: ${gasto.prioridade||'Média'}`);
        return res.status(200).json({ ok: true });

      } else if (campo === 'descricao') {
        gasto.descricao = texto;
        gasto.tipo = 'lancamento';
        // Continua para verificar campos restantes abaixo
      } else if (campo === 'modalidade') {
        // Usuário respondeu a modalidade
        gasto.modalidade = texto;
        gasto.tipo = 'lancamento';
        const modLow = texto.toLowerCase();
        const isPix = modLow.includes('pix');
        const isDinheiro = modLow.includes('dinheiro') || modLow.includes('especie') || modLow.includes('espécie');

        if (isPix || isDinheiro) {
          // PIX/Dinheiro não precisa de cartão — salva direto
          gasto.cartao = gasto.modalidade;
          await limparContexto(chat_id);
          await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, nomeRemetente);
          const valor = parseFloat(gasto.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
          await sendTelegram(chat_id,
            `✅ *Lançamento registrado!*\n\n` +
            `📝 ${gasto.descricao}\n💰 ${valor}\n🏷 ${gasto.categoria}\n` +
            `${iconeModalidade(gasto.modalidade)} ${gasto.modalidade}\n` +
            `📅 ${fmtData(gasto.data_lancamento)}\n\n` +
            `⏳ Aguardando sua autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`
          );
        } else {
          // Crédito/Débito → precisa saber o cartão/banco
          await setContexto(chat_id, { aguardando: 'cartao', gasto_parcial: gasto });
          await sendTelegram(chat_id,
            `💳 Qual cartão ou banco?\n\nEx: Nubank, Inter, Itaú, Bradesco...`
          );
        }
        return res.status(200).json({ ok: true });

      } else if (campo === 'cartao') {
        // Usuário respondeu o cartão — tem tudo, salva direto
        gasto.cartao = texto;
        gasto.tipo = 'lancamento';
        await limparContexto(chat_id);
        await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, nomeRemetente);
        const valor = parseFloat(gasto.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        await sendTelegram(chat_id,
          `✅ *Lançamento registrado!*\n\n` +
          `📝 ${gasto.descricao}\n💰 ${valor}\n🏷 ${gasto.categoria}\n` +
          `💳 ${fmtCartao(gasto.cartao)}\n` +
          `${iconeModalidade(gasto.modalidade)} ${gasto.modalidade || gasto.cartao}\n` +
          `📅 ${fmtData(gasto.data_lancamento)}\n\n` +
          `⏳ Aguardando sua autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`
        );
        return res.status(200).json({ ok: true });

      } else if (campo === 'valor') {
        const num = parseFloat(texto.replace(',', '.').replace(/[^\d.]/g, ''));
        if (!isNaN(num)) gasto.valor = num;
        gasto.tipo = 'lancamento';
        // Continua para verificar o que falta abaixo
      } else if (campo === 'categoria') {
        gasto.categoria = texto;
        gasto.tipo = 'lancamento';
      }

      // Verificações de campos faltantes (para valor/categoria recém preenchidos)
      if (!gasto.valor || isNaN(gasto.valor)) {
        await setContexto(chat_id, { aguardando: 'valor', gasto_parcial: gasto });
        await sendTelegram(chat_id, `💰 Qual o valor gasto?`);
        return res.status(200).json({ ok: true });
      }
      if (!gasto.modalidade) {
        await setContexto(chat_id, { aguardando: 'modalidade', gasto_parcial: gasto });
        await sendTelegram(chat_id,
          `${iconeModalidade('')} Como foi o pagamento?\n\n🔄 PIX\n💳 Crédito\n💳 Débito\n💵 Dinheiro`
        );
        return res.status(200).json({ ok: true });
      }
    }

    const gasto = await interpretarComGemini({ texto, audioUrl, fotoUrl, mimeType });

    if (gasto.tipo === 'erro' || gasto.erro) {
      await sendTelegram(chat_id,
        `❌ Não consegui identificar um gasto.\n\n` +
        `Tente assim: _"gastei 47 reais no iFood cartão Nubank"_`
      );
      return res.status(200).json({ ok: true });
    }

    if (gasto.tipo === 'lancamento_parcial') {
      const campo = gasto.campo_faltando;
      if (campo === 'descricao') {
        await setContexto(chat_id, { aguardando: 'descricao', gasto_parcial: gasto });
        await sendTelegram(chat_id, `📝 O que foi essa compra?\nEx: iFood, mercado, farmácia, uber...`);
        return res.status(200).json({ ok: true });
      }
      if (campo === 'valor') {
        await setContexto(chat_id, { aguardando: 'valor', gasto_parcial: gasto });
        await sendTelegram(chat_id, `💰 Qual o valor gasto?`);
        return res.status(200).json({ ok: true });
      }
    }

    if (gasto.tipo === 'consulta') {
      if (gasto.pergunta === 'fatura' || gasto.pergunta === 'faturas_todas') {
        const userData = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const faturas = userData?.[0]?.data?.faturas || {};
        const mesIdx = gasto.mes && gasto.mes !== 'proximo'
          ? (parseInt(gasto.mes) - 1)
          : gasto.mes === 'proximo'
          ? (new Date().getMonth() + 1) % 12
          : new Date().getMonth();
        const mesNome = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][mesIdx];

        if (gasto.pergunta === 'faturas_todas') {
          const cartoes = Object.keys(faturas);
          if (!cartoes.length) {
            await sendTelegram(chat_id, `📊 Nenhuma fatura encontrada para ${mesNome}.`);
          } else {
            const lista = cartoes.map(c => {
              const val = (faturas[c]||[])[mesIdx] || 0;
              return `💳 ${c}: ${val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;
            }).join('\n');
            await sendTelegram(chat_id, `📊 *Faturas de ${mesNome}:*\n\n${lista}`);
          }
          return res.status(200).json({ ok: true });
        }

        if (gasto.pergunta === 'fatura') {
          const cartao = gasto.cartao || '';
          const cartaoKey = Object.keys(faturas).find(c =>
            c.toLowerCase().includes(cartao.toLowerCase()) ||
            cartao.toLowerCase().includes(c.toLowerCase())
          );
          if (!cartaoKey) {
            await sendTelegram(chat_id,
              `❌ Cartão "${cartao}" não encontrado.\n\nCartões disponíveis: ${Object.keys(faturas).join(', ') || 'nenhum'}`
            );
          } else {
            const val = (faturas[cartaoKey]||[])[mesIdx] || 0;
            await sendTelegram(chat_id,
              `💳 *Fatura ${cartaoKey} — ${mesNome}*\n\n` +
              `💰 ${val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
            );
          }
          return res.status(200).json({ ok: true });
        }
      }

      await sendTelegram(chat_id, `📊 Consultas detalhadas disponíveis em breve.\nAcesse o BY Finance para ver seus relatórios.`);
      return res.status(200).json({ ok: true });
    }

    if (gasto.tipo === 'tarefa') {
      if (gasto.acao === 'listar') {
        const tarefas = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dados = tarefas?.[0]?.data || {};
        const lista = (dados.tarefas || []).filter(t => !t.concluida).slice(0, 8);
        if (!lista.length) {
          await sendTelegram(chat_id, `✅ Nenhuma tarefa pendente!`);
        } else {
          const txt = lista.map(t => {
            const prazo = t.prazo ? ` · 📅 ${new Date(t.prazo).toLocaleDateString('pt-BR')}` : '';
            const prio = t.prio === 'Alta' ? ' 🔴' : t.prio === 'Media' ? ' 🟡' : ' 🟢';
            return `• ${t.titulo}${prio}${prazo}`;
          }).join('\n');
          await sendTelegram(chat_id, `📋 *Tarefas pendentes:*\n\n${txt}`);
        }
        return res.status(200).json({ ok: true });
      }

      if (gasto.acao === 'criar' && gasto.titulo && gasto.pedir_prazo) {
        await setContexto(chat_id, { aguardando: 'prazo_tarefa', gasto_parcial: gasto });
        await sendTelegram(chat_id,
          `📅 Para quando é essa tarefa?\nEx: amanhã, sexta, 25/05, semana que vem`
        );
        return res.status(200).json({ ok: true });
      }

      if (gasto.acao === 'criar' && gasto.titulo) {
        const tarefas = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dados = tarefas?.[0]?.data || {};
        const lista = dados.tarefas || [];
        let nova = {
          id: Date.now(),
          titulo: gasto.titulo,
          prazo: gasto.prazo || null,
          prio: gasto.prioridade || 'Media',
          concluida: false,
          origem: 'telegram',
          origem_nome: nomeRemetente
        };
        if (gasto.atribuir_para) {
          nova = {
            ...nova,
            atribuidor_chat_id: chat_id,
            atribuidor_nome: nomeRemetente,
            atribuido_para: gasto.atribuir_para
          };
        }
        lista.push(nova);
        dados.tarefas = lista;
        await fetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${user_id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ data: dados, updated_at: new Date().toISOString() })
        });
        const prazoTxt = gasto.prazo ? ` · 📅 ${new Date(gasto.prazo+'T12:00:00').toLocaleDateString('pt-BR')}` : '';

        // Se tem atribuição mas não tem prazo, pergunta antes de criar
        if (gasto.atribuir_para && (gasto.pedir_prazo || !gasto.prazo)) {
          await setContexto(chat_id, {
            aguardando: 'prazo_tarefa_atribuida',
            gasto_parcial: { ...gasto, tipo: 'tarefa', acao: 'criar' }
          });
          await sendTelegram(chat_id,
            `📅 Para quando é a tarefa *"${gasto.titulo}"* para ${gasto.atribuir_para}?\n\nEx: amanhã, sexta, 25/05, sem prazo`
          );
          return res.status(200).json({ ok: true });
        }

        // Atribuição para pessoa específica
        if (gasto.atribuir_para) {
          const nomeAtrib = gasto.atribuir_para.toLowerCase().trim();
          const todosVinculos = await supabaseQuery(
            `/telegram_vinculos?user_id=eq.${user_id}&select=chat_id,nome`
          );
          const vinculoAtrib = (todosVinculos || []).find(v =>
            v.nome && v.nome.toLowerCase().includes(nomeAtrib)
          );
          if (vinculoAtrib && vinculoAtrib.chat_id !== chat_id) {
            await sendTelegram(vinculoAtrib.chat_id,
              `📋 *${nomeRemetente} atribuiu uma tarefa para você!*\n\n` +
              `📝 ${gasto.titulo}\n` +
              `📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo definido'}\n` +
              `🎯 Prioridade: ${gasto.prioridade || 'Média'}\n\n` +
              `_Acesse o BY Finance para ver suas tarefas._`
            );
            await sendTelegram(chat_id,
              `✅ *Tarefa criada e atribuída para ${gasto.atribuir_para}!*\n\n` +
              `📝 ${gasto.titulo}\n` +
              `📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo'}`
            );
          } else if (!vinculoAtrib) {
            await sendTelegram(chat_id,
              `✅ Tarefa criada!\n\n⚠ Não encontrei "${gasto.atribuir_para}" nos números vinculados desta conta.`
            );
          } else {
            // Atribuiu para si mesmo
            await sendTelegram(chat_id, `✅ *Tarefa criada!*\n\n📋 ${gasto.titulo}${prazoTxt}\n🎯 Prioridade: ${gasto.prioridade || 'Média'}`);
          }
          return res.status(200).json({ ok: true });
        }

        // Sem atribuição — notifica criação e avisa outros
        await sendTelegram(chat_id, `✅ *Tarefa criada!*\n\n📋 ${gasto.titulo}${prazoTxt}\n🎯 Prioridade: ${gasto.prioridade || 'Média'}`);
        const outrosVinculos = await supabaseQuery(
          `/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`
        );
        for (const outro of (outrosVinculos || [])) {
          await sendTelegram(outro.chat_id,
            `📋 *${nomeRemetente} criou uma tarefa!*\n\n` +
            `📝 ${gasto.titulo}\n` +
            `📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo'}\n` +
            `🎯 Prioridade: ${gasto.prioridade || 'Média'}`
          );
        }
        return res.status(200).json({ ok: true });
      }

      if (gasto.acao === 'concluir' && gasto.titulo) {
        const tarefas = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dados = tarefas?.[0]?.data || {};
        const lista = dados.tarefas || [];
        const idx = lista.findIndex(t => {
          const tituloTarefa = (t.titulo || t.desc || '').toLowerCase().trim();
          const tituloGasto = gasto.titulo.toLowerCase().trim();
          const limpar = str => str.replace(/\b(a|o|as|os|de|da|do|das|dos|para|que|um|uma|uns|umas)\b/g, '').replace(/\s+/g, ' ').trim();
          const tituloLimpo = limpar(tituloTarefa);
          const gastoLimpo = limpar(tituloGasto);
          return tituloLimpo.includes(gastoLimpo) || gastoLimpo.includes(tituloLimpo) ||
            tituloTarefa.includes(tituloGasto) || tituloGasto.includes(tituloTarefa);
        });
        if (idx === -1) {
          await sendTelegram(chat_id, `❌ Tarefa não encontrada: "${gasto.titulo}"`);
        } else {
          lista[idx].concluida = true;
          dados.tarefas = lista;
          await supabaseQuery(`/user_data?user_id=eq.${user_id}`, 'PATCH', {
            data: dados,
            updated_at: new Date().toISOString()
          });
          const dadosAtualizados = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
          const tarefasAtualizadas = dadosAtualizados?.[0]?.data?.tarefas || [];
          const pendentes = tarefasAtualizadas.filter(t => !t.concluida);
          await sendTelegram(chat_id,
            `✅ Tarefa concluída: *${lista[idx].titulo || lista[idx].desc}*\n\n` +
            (pendentes.length > 0
              ? `📋 *${pendentes.length} tarefa(s) ainda pendente(s):*\n` +
                pendentes.map(t => `• ${t.titulo || t.desc}`).join('\n')
              : `🎉 Todas as tarefas concluídas!`)
          );
          // Notifica outros vínculos sobre a conclusão
          const outrosConcluir = await supabaseQuery(
            `/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`
          );
          for (const outro of (outrosConcluir || [])) {
            await sendTelegram(outro.chat_id,
              `✅ *${nomeRemetente} concluiu uma tarefa!*\n\n📝 ${lista[idx].titulo || lista[idx].desc}`
            );
          }
        }
        return res.status(200).json({ ok: true });
      }
    }

    if (gasto.tipo === 'receita') {
      await supabaseQuery('/telegram_pendentes', 'POST', {
        user_id,
        descricao: gasto.descricao,
        valor: gasto.valor,
        categoria: gasto.categoria || 'Outros',
        cartao: gasto.conta || 'Não informado',
        data_lancamento: gasto.data_lancamento,
        origem: 'telegram',
        tipo_midia,
        mensagem_original,
        chat_id,
        status: 'pendente',
        tipo: 'receita',
        remetente: nomeRemetente,
        observacao: null,
        parcelas: null,
        valor_parcela: null,
        modalidade: null
      });
      const valor = parseFloat(gasto.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      await sendTelegram(chat_id,
        `✅ *Receita registrada!*\n\n` +
        `📝 ${gasto.descricao}\n` +
        `💰 ${valor}\n` +
        `🏷 ${gasto.categoria}\n` +
        `🏦 ${gasto.conta || 'Não informado'}\n` +
        `📅 ${fmtData(gasto.data_lancamento)}\n\n` +
        `⏳ Aguardando sua autorização no BY Finance.\n` +
        `Você tem *7 dias* para aprovar ou rejeitar.`
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

    // Pós-Gemini: perguntar modalidade PRIMEIRO, depois cartão se necessário
    if (gasto.tipo === 'lancamento' && !gasto.modalidade) {
      await setContexto(chat_id, { aguardando: 'modalidade', gasto_parcial: gasto });
      await sendTelegram(chat_id,
        `Entendi! ${iconeModalidade('')} Como foi o pagamento?\n\n🔄 PIX\n💳 Crédito\n💳 Débito\n💵 Dinheiro`
      );
      return res.status(200).json({ ok: true });
    }
    // Se tem modalidade mas não tem cartão (e é crédito/débito)
    if (gasto.tipo === 'lancamento' && (!gasto.cartao || gasto.cartao === 'Não informado')) {
      const modLow = (gasto.modalidade || '').toLowerCase();
      if (!modLow.includes('pix') && !modLow.includes('dinheiro')) {
        await setContexto(chat_id, { aguardando: 'cartao', gasto_parcial: gasto });
        await sendTelegram(chat_id, `💳 Qual cartão ou banco?\n\nEx: Nubank, Inter, Itaú, Bradesco...`);
        return res.status(200).json({ ok: true });
      }
      // PIX/Dinheiro: cartao = modalidade
      gasto.cartao = gasto.modalidade;
    }

    for (const l of lancamentos) {
      await salvarPendente(chat_id, user_id, l, tipo_midia, mensagem_original, nomeRemetente);
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
      const remetenteInfo = !isPrincipal ? `\n👤 Enviado por: *${nomeRemetente}*` : '';
      await sendTelegram(chat_id,
        `✅ *Lançamento registrado!*\n\n` +
        `📝 ${gasto.descricao}\n` +
        `💰 ${valor}${parcelaInfo}\n` +
        `🏷 ${gasto.categoria}\n` +
        `💳 ${fmtCartao(gasto.cartao)}\n` +
        `${iconeModalidade(gasto.modalidade)} ${gasto.modalidade || 'Não informado'}\n` +
        `📅 ${fmtData(gasto.data_lancamento)}${remetenteInfo}\n\n` +
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