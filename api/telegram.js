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

function normalizeModalidade(texto) {
  const t = (texto || '').toLowerCase().trim();
  if (t === '1' || t.includes('pix') || t.includes('transferen') || t.includes('ted') || t.includes('doc')) return 'PIX';
  if (t === '5' || t === 'crédito parcelado' || t === 'credito parcelado' || t === 'parcelado' || t === 'parcelada') return 'Crédito Parcelado';
  if (t === '2' || (t.includes('créd') || t.includes('cred')) && !t.includes('parc')) return 'Crédito';
  if (t === '3' || t.includes('déb') || t.includes('deb')) return 'Débito';
  if (t === '4' || t.includes('dinheiro') || t.includes('espécie') || t.includes('especie') || t.includes('cash') || t.includes('vivo')) return 'Dinheiro';
  return texto.trim();
}

function parsePrazo(texto) {
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const t = (texto || '').toLowerCase().trim();
  if (!t || t === 'sem prazo' || t === 'nenhum' || t === 'sem' || t === 'sem data') return null;
  if (t === 'hoje' || t.startsWith('hoje')) return hoje.toISOString().split('T')[0];
  if (t.includes('depois de amanhã') || t.includes('depois de amanha')) return new Date(hoje.getTime()+172800000).toISOString().split('T')[0];
  if (t.includes('amanhã') || t.includes('amanha')) return new Date(hoje.getTime()+86400000).toISOString().split('T')[0];
  if (t.includes('semana que vem')) { const d=new Date(hoje); d.setDate(d.getDate()+(8-d.getDay())%7||7); return d.toISOString().split('T')[0]; }
  const dias = {segunda:1,'terça':2,terca:2,quarta:3,quinta:4,sexta:5,'sábado':6,sabado:6,domingo:0};
  for (const [nome,num] of Object.entries(dias)) {
    if (t.includes(nome)) { const d=new Date(hoje); const diff=(num-d.getDay()+7)%7||7; d.setDate(d.getDate()+diff); return d.toISOString().split('T')[0]; }
  }
  const m = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) { const y=m[3]?parseInt(m[3])+(m[3].length===2?2000:0):hoje.getFullYear(); return `${y}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`; }
  return null;
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
    data_lancamento: gasto.data_lancamento || new Date().toISOString().split('T')[0],
    origem: 'telegram',
    tipo_midia,
    mensagem_original,
    chat_id,
    status: 'pendente',
    parcelas: gasto.parcelas || null,
    valor_parcela: gasto.valor_parcela || null,
    observacao: gasto.mktTipo === 'variavel' ? ('[mkt:variavel]'+(gasto.observacao?' '+gasto.observacao:'')) : gasto.mktTipo === 'mes' ? ('[mkt:mes]'+(gasto.observacao?' '+gasto.observacao:'')) : (gasto.observacao||null),
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
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) && parsed?.code) {
      console.error(`supabaseQuery ${method} ${path} erro:`, JSON.stringify(parsed));
    }
    return Array.isArray(parsed) ? parsed : [];
  } catch(e) { return []; }
}

function escapeMd(str) {
  // Escapa caracteres que quebram o parse_mode Markdown do Telegram
  return (str || '').replace(/([_*`\[])/g, '\\$1');
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

// ── Pré-processamento de comandos diretos (antes do Gemini) ──────────────────
function preProcessarComando(texto) {
  const t = texto.trim().toLowerCase()
    .replace(/[?.!\s]+$/, '')
    .replace(/^[/]/, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, ''); // remove acentos para comparação

  // helper
  const eq  = (...kws) => kws.includes(t);
  const has = (...kws) => kws.some(k => t.includes(k));

  // ── Faturas (geral) ──────────────────────────────────────────────────────
  if (eq('faturas','fatura','ver faturas','ver fatura','minhas faturas','minha fatura',
         'todas as faturas','quais faturas','listar faturas','listar fatura','mostrar faturas',
         'total faturas','conferir fatura','conferir faturas','checar fatura','checar faturas',
         'quanto devo','o que devo','ver cartoes','meus cartoes','cartoes','cartao',
         'faturas do mes','fatura do mes','fatura desse mes','faturas desse mes'))
    return {tipo:'consulta',pergunta:'faturas_todas',mes:null};

  // Fatura cartão específico
  if (/fatura.*(nubank|nu\b|roxinh|lilas|roxa)/.test(t) || /(nubank|nu\b|roxinh).*(fatura|fatur)/.test(t))
    return {tipo:'consulta',pergunta:'fatura',cartao:'Nubank',mes:null};
  if (/fatura.*(inter|laranja)/.test(t) || /(inter|laranja).*(fatura)/.test(t))
    return {tipo:'consulta',pergunta:'fatura',cartao:'Inter',mes:null};
  if (/fatura.*(itau|ita\b)/.test(t) || /(itau|ita\b).*(fatura)/.test(t))
    return {tipo:'consulta',pergunta:'fatura',cartao:'Itaú',mes:null};
  if (/fatura.*(c6|c6bank|pretinho)/.test(t) || /(c6|c6bank|pretinho).*(fatura)/.test(t))
    return {tipo:'consulta',pergunta:'fatura',cartao:'C6 Bank',mes:null};
  if (/fatura.*(brad|bradesco|vermelho)/.test(t) || /(brad|bradesco).*(fatura)/.test(t))
    return {tipo:'consulta',pergunta:'fatura',cartao:'Bradesco',mes:null};
  if (/fatura.*(bb|banco.do.brasil|brasil\b)/.test(t))
    return {tipo:'consulta',pergunta:'fatura',cartao:'Banco do Brasil',mes:null};
  if (/fatura.*(caixa|cef)/.test(t))
    return {tipo:'consulta',pergunta:'fatura',cartao:'Caixa',mes:null};
  if (/fatura.*(santander|san\b)/.test(t))
    return {tipo:'consulta',pergunta:'fatura',cartao:'Santander',mes:null};
  if (/fatura.*(xp\b)/.test(t))
    return {tipo:'consulta',pergunta:'fatura',cartao:'XP',mes:null};

  // ── Gastos do mês ──────────────────────────────────────────────────────
  if (eq('gastos','gasto','meus gastos','ver gastos','extrato','meu extrato',
         'total do mes','total do mês','gastos do mes','gastos do mês','gastos mensais',
         'quanto gastei','quanto gastei esse mes','quanto gastei esse mês',
         'quanto gastei no mes','balanco','balanço','balanco do mes','balanço do mes',
         'resumo de gastos','relatorio','relatorio do mes','gastos mensais',
         'quanto saiu','quanto saiu esse mes','o que saiu','saida do mes','saidas do mes'))
    return {tipo:'consulta',pergunta:'gastos_mes'};

  if (eq('gastos hoje','gasto hoje','total hoje','o que gastei hoje','gastei hoje',
         'quanto gastei hoje','saida de hoje','saidas de hoje','o que saiu hoje'))
    return {tipo:'consulta',pergunta:'gastos_hoje'};

  // ── Saldo / situação ───────────────────────────────────────────────────
  if (eq('saldo','meu saldo','situacao','situação','como estou','quanto tenho',
         'minha situacao','minha situação','situacao financeira','situação financeira',
         'financeiro','meu financeiro','patrimonio','meu patrimonio',
         'posso gastar','quanto sobrou','quanto resta','to no positivo','to no negativo',
         'to bem','como ta','como está','o que sobrou'))
    return {tipo:'consulta',pergunta:'saldo'};

  // ── Resumo / alertas ───────────────────────────────────────────────────
  if (eq('resumo','alertas','status','meu resumo','resumo do dia','avisos',
         'meu dia','o dia','novidades','updates','o que tem','o que esta rolando',
         'o que está rolando','novidade','me atualiza','me atualize','resumo financeiro'))
    return {tipo:'consulta',pergunta:'resumo'};

  // ── Tarefas listar ─────────────────────────────────────────────────────
  if (eq('tarefas','minhas tarefas','ver tarefas','lista tarefas','listar tarefas',
         'minha lista','lista de tarefas','pendencias','pendências','afazeres',
         'meus afazeres','to-do','todo','todo list','o que tenho','o que fazer',
         'o que falta','compromissos','meus compromissos','agenda','minha agenda',
         'o que ta pendente','o que está pendente','lista do dia','tarefas do dia'))
    return {tipo:'tarefa',acao:'listar'};

  // ── Pendentes de autorização ───────────────────────────────────────────
  if (eq('pendentes','ver pendentes','lancamentos pendentes','lançamentos pendentes',
         'autorizar pendentes','lista pendentes','a autorizar','para autorizar',
         'aprovar','para aprovar','o que precisa autorizar','o que ta esperando',
         'o que esta esperando','lancamentos a autorizar','o que autorizei','aprovacoes'))
    return {tipo:'comando',acao:'listar_pendentes'};

  return null;
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
Verbos diretos: gastei, paguei, comprei, adquiri, consumi, desembolsei, coloquei, botei, meti, abateu, debitou, cobrou, custou, valeu, saiu, foi, venceu, fechei, quitei, liquidei, contratei, assinei, renovei, cancelei a assinatura mas cobrou
Substantivos: gasto, despesa, conta, pagamento, compra, débito, saída, custo, taxa, tarifa, mensalidade, multa, juros, parcela, prestação, boleto, nota, fatura (qdo com valor)
Inglês/gíria: spent, paid, bought, charged, "saiu X conto", "foi X pila", "X reais fora", "X pau", "X mangos", "X conto", "uma nota de X", "foi embora X", "voou X", "perdi X"
Sem verbo explícito: "pão 60", "uber 23", "netflix 45", "mercado 150", "farmácia 45", "luz 120", "condomínio 500"
Com símbolo: "$ 60", "R$ 80", "60,00", "60 reais", "sessenta reais", "R$47,50"
Implícito: "80 no restaurante", "50 com uber", "200 na farmácia", "academia esse mês"
Com cartão: "passei 150 no Nubank", "100 no débito Inter", "300 crédito Itaú"
Débito automático: "veio o boleto", "venceu o carnê", "descontou automático", "debitou da conta"

INTERPRETAR VALORES:
- Números soltos: "80", "R$80", "80 reais", "oitenta reais" → 80.00
- "mil" → 1000, "duzentos" → 200, "cinquenta" → 50, "cem" → 100, "trezentos" → 300
- "80,50" ou "80.50" → 80.50, "1.200" → 1200.00
- "1k" → 1000, "1.5k" → 1500, "2k" → 2000
- "e pouco" → ignorar, usar só o principal: "cem e pouco" → 100
- Parcelamento: "200 em 12x", "3x de 50", "12 parcelas de 30", "parcelei em 6x", "36x de 150" → extrair total e parcelas

INTERPRETAR DESCRIÇÃO:
- Local: "no mercado", "na farmácia", "no uber", "no ifood", "na academia", "no shopping"
- Produto: "comprei pão", "paguei netflix", "gasolina", "tênis novo"
- Serviço: "academia do mês", "plano de saúde", "internet", "conta de luz"
- Se só tiver valor → campo_faltando = "descricao"
- Se só tiver descrição → campo_faltando = "valor"
- Se tiver os dois → lancamento completo

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
Alimentação: ifood, rappi, uber eats, loggi, delivery, restaurante, lanchonete, padaria, café, bar, pizza, hamburger, açaí, sorvete, doceria, sushi, churrasco, refeição, almoço, jantar, café da manhã, lanche, marmita, comida, churrascaria, sorveteria, pastelaria, crepe, temaki, japonês, árabe, buffet, self-service, rodízio, food truck, cantina, bistrô, snack, petisco, happy hour, balada (comida), james, cornershop
Transporte: uber, 99, táxi, indriver, combustível, gasolina, etanol, diesel, álcool, pedágio, metrô, ônibus, passagem, estacionamento, moto, bicicleta, patinete, lime, bird, rodoviária, aeroporto, avião, passagem aérea, latam, gol, azul, voo, táxi aéreo, van, transfer, aplicativo de transporte, corrida
Mercado: supermercado, mercado, hortifruti, açougue, mercearia, quitanda, feira, sacolão, atacado, atacadão, assaí, assai, carrefour, extra, pão de açúcar, dia, aldi, walmart, bistek, comper, prezunic, compras do mês, despensa, rancho
Saúde: farmácia, drogaria, ultrafarma, remédio, medicamento, médico, consulta médica, exame, hospital, clínica, dentista, psicólogo, psiquiatra, fisioterapeuta, nutricionista, oftalmologista, dermatologista, urologista, ginecologista, cardiologista, plano de saúde, unimed, hapvida, amil, academia, smart fit, bluefit, bodytech, suplemento, vitamina, whey, spa, massagem, terapia, quiropraxia
Lazer: cinema, netflix, spotify, amazon prime, disney+, disney plus, hbo max, max, paramount, crunchyroll, apple tv, youtube premium, globoplay, telecine, show, festa, balada, viagem, hotel, pousada, airbnb, hostel, parque, teatro, museu, ingresso, ticket, jogo, game, steam, playstation, xbox, switch, app store, google play
Moradia: aluguel, condomínio, água, luz, energia, internet, claro, tim, vivo, oi, gás, IPTU, IPVA, seguro residencial, seguro auto, reform, manutenção, faxina, diarista, cozinheira, frete, mudança, móvel, eletrodoméstico, decoração, mão de obra, prestação da casa, financiamento imobiliário
Vestuário: roupa, calçado, tênis, sapato, bolsa, carteira, acessório, moda, loja, shopping, renner, c&a, riachuelo, shein, zara, h&m, farm, arezzo, camiseta, calça, vestido, jaqueta, moletom, lingerie, meia, cueca, óculos, relógio, bijuteria
Educação: curso, livro, escola, faculdade, mensalidade escolar, material escolar, caneta, caderno, apostila, workshop, treinamento, udemy, alura, coursera, duolingo, inglês, espanhol, idioma, aula particular, pós-graduação, MBA, certificação, concurso
Beleza: salão, barbearia, manicure, pedicure, depilação, sobrancelha, cabeleireiro, tintura, escova, botox, micropigmentação, perfume, maquiagem, cosmético, creme, shampoo, condicionador, produto de cabelo, produto de beleza
Pet: veterinário, pet shop, ração, banho e tosa, vacina animal, remédio pet, casinha, brinquedo pet, coleira, guia, plano pet, castração, consulta veterinária
Serviços: lavanderia, conserto, reparo, oficina, mecânico, encanador, eletricista, pintor, pedreiro, dedetização, jardinagem, contador, advogado, cartório, notário, assinatura, streaming, software, app, anuidade, taxa bancária, iof, tarifas
Investimento: ação, fundo, tesouro direto, criptomoeda, bitcoin, ethereum, poupança, CDB, LCI, LCA, previdência, renda fixa, renda variável, aplicação, aporte, compra de dólar, ETF
Outros: qualquer coisa que não se encaixe acima, presente, doação, taxa, multa, imposto, DARF, IR, restituição paga

━━━ BANCOS E ABREVIAÇÕES ━━━
"nu", "nubank", "roxinho", "lilas", "roxão", "cartão roxo" → "Nubank"
"inter", "banco inter", "laranjinha", "inter bank", "laranja" → "Inter"
"itau", "itaú", "itauzinho", "itau unibanco" → "Itaú"
"brad", "bradesco", "vermelhinho", "bradescão" → "Bradesco"
"bb", "brasil", "banco do brasil", "bancão", "agencia brasil" → "Banco do Brasil"
"cef", "caixa", "caixa economica", "caixa federal" → "Caixa"
"c6", "c6bank", "pretinho", "c6 bank", "c6 preto" → "C6 Bank"
"xp", "xp invest", "xp investimentos" → "XP"
"next", "next bank" → "Next"
"picpay", "pic pay" → "PicPay"
"pagbank", "pagseguro", "pag bank" → "PagBank"
"mercado pago", "mp", "mercadopago" → "Mercado Pago"
"will", "will bank", "willbank" → "Will Bank"
"neon", "neon bank" → "Neon"
"santander", "san", "santandrão" → "Santander"
"original", "banco original" → "Original"
"agi", "agibank" → "Agibank"
"bs2", "banco bs2" → "BS2"
"sofisa", "sofisa direto" → "Sofisa"
"bmg", "banco bmg" → "BMG"
"digio" → "Digio"
"avenue" → "Avenue"
"modal", "modalmais" → "Modal"
"sicoob", "cooperativa" → "Sicoob"
"sicredi" → "Sicredi"
"stone", "ton" → "Stone"
"getnet" → "Getnet"
"safra", "banco safra" → "Safra"
"rendimento", "banco rendimento" → "Rendimento"
"débito", "debito", "cartão de débito" → "Débito"
"dinheiro", "especie", "espécie", "cash", "nota", "físico" → "Dinheiro"
"pix", "transferencia", "ted", "doc", "transferência" → "PIX"
"crédito", "credito", "cartão de crédito" → "Crédito"
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

GATILHOS DE RECEITA — qualquer expressão que indique entrada de dinheiro:

Verbos/frases de recebimento:
"recebi", "recebi X", "recebi de", "recebi do", "recebi da", "fui pago", "me pagaram", "me fizeram um pix"
"entrou", "entrou X", "entrou na conta", "entrou no banco", "caiu", "caiu na conta", "caiu X", "caiu aqui", "caiu o pix"
"pintou X", "pintou grana", "pintou uma grana", "chegou o pagamento", "chegou X", "chegou meu X", "chegou o dinheiro"
"me transferiram", "mandaram X", "depositaram", "transferência recebida", "ted recebido", "pix recebido", "me mandaram pix"
"ganhei X", "ganhei de", "tirei X", "tirei de", "quitaram", "liquidaram", "me pagaram"
"me devolveram", "devolução", "estorno recebido", "reembolso recebido", "me estornaram", "me ressarciram", "tive reembolso"
"tá na conta", "tá no banco", "dinheiro na conta", "veio o X", "veio o dinheiro", "caiu grana", "caiu uma grana"
"tô recebendo", "vou receber", "recebi hoje", "recebi agora", "acabei de receber"

Fontes de renda (mesmo sem verbo, indica receita):
"salário", "salario", "vencimento", "vale", "vale alimentação", "vale refeição", "va", "vr", "adiantamento", "13º", "13 salário", "décimo terceiro", "férias", "rescisão"
"freelance", "freela", "freelas", "freela pago", "trampo extra", "bico", "trabalho extra", "job", "projeto pago", "consultoria", "prestação de serviço", "serviço prestado"
"aluguel recebido", "recebi aluguel", "inquilino pagou", "locatário pagou", "aluguei", "aluguel do imóvel"
"rendimento", "dividendo", "dividendos", "juros recebido", "cdb venceu", "resgate", "rendeu", "lucro", "yield", "cashback recebido"
"renda extra", "renda passiva", "honorários", "comissão", "comissão recebida", "bonificação", "participação"
"bonus", "bônus", "PLR", "participação nos lucros", "gratificação", "premiação", "prêmio recebido", "rastreador de desempenho"
"pensão recebida", "pensão alimentícia", "mesada", "aposentadoria", "INSS", "benefício recebido", "auxílio", "BPC"
"presente de dinheiro", "me deram X", "ganhei X de presente", "pix de familiar", "aniversário dinheiro", "me deram grana"
"vendi X", "vendi meu", "venda recebida", "serviço prestado", "serviço concluído pago", "vendi na OLX", "vendi no marketplace"
"me mandaram X", "caiu X de", "entrou X referente a", "pagamento do X chegou", "fechei um contrato"

IMPORTANTE — desvio linguístico e informalidade:
- "Chegou meu freela" → receita Freelance
- "Pintou 500 do trampo" → receita Freelance
- "O inquilino caiu o pix" → receita Aluguel
- "Recebi meu salário esse mês" → receita Salário
- "Tirei 300 do CDB" → receita Investimento
- "Me deram 200 de presente" → receita Outros
- "Fiz um bico hoje, 150 conto" → receita Freelance
- "Veio o PLR da empresa" → receita Bônus
- "Resgatei a poupança" → receita Investimento
- "Me pagaram aquele serviço" → receita Freelance

CATEGORIAS DE RECEITA:
Salário → emprego CLT/PJ, vencimento mensal
Freelance → trabalho autônomo, bico, job, serviço prestado
Bônus → PLR, gratificação, 13º, participação nos lucros, premiação
Aluguel → aluguel recebido, locação
Investimento → rendimento, dividendo, resgate, CDB, poupança, fundo
Reembolso → devolução, estorno, ressarcimento
Outros → presente, pensão, mesada, qualquer outro

FORMATO PARA RECEITA:
{
  "tipo": "receita",
  "descricao": "Salário maio",
  "valor": 3000.00,
  "categoria": "Salário",
  "conta": "Nubank",
  "data_lancamento": "${new Date().toISOString().split('T')[0]}"
}

━━━ TAREFAS ━━━

GATILHOS DE CRIAÇÃO DE TAREFA — qualquer uma dessas expressões cria uma tarefa:
Diretos: "adiciona tarefa", "cria tarefa", "nova tarefa", "adicionar tarefa", "criar tarefa"
Anotação: "anota aí", "anota isso", "coloca no caderno", "registra aí", "salva aí", "deixa anotado", "bota na lista", "coloca na lista", "adiciona pra minha lista"
Lembretes: "lembra de", "me lembra", "me lembre", "não esquecer", "não deixa esquecer", "lembra amanhã", "me avisa", "me avise de"
Obrigação: "preciso fazer", "tenho que fazer", "preciso comprar", "preciso ligar", "preciso resolver", "preciso pagar", "preciso ir", "tenho que ir", "tenho que ligar", "tenho que pagar", "não pode esquecer de"
Agendamento: "agenda X para", "marca X para", "X para sexta", "X amanhã", "agenda para", "marcar para"
Geral: "to do", "todo", "pendência", "compromisso", "obrigação", "missão", "meta", "objetivo"
Urgência: "urgente", "importante", "crítico", "prioridade", "asap", "hoje mesmo", "o mais rápido possível" → prioridade Alta
Sem prazo informado → pedir_prazo = true

GATILHOS DE LISTAR TAREFAS:
"tarefas", "minhas tarefas", "quais tarefas", "o que tenho para fazer", "o que tenho pra fazer", "pendências"
"lista tarefas", "ver tarefas", "mostrar tarefas", "tarefas do dia", "lista de tarefas", "listar tarefas"
"o que está pendente", "o que ta pendente", "o que falta fazer", "minha lista", "o que falta", "o que tenho"
"afazeres", "compromissos", "agenda", "o que fazer hoje", "meus pendentes"

GATILHOS DE CONCLUIR TAREFA:
"concluí", "conclui", "já conclui", "já concluí", "concluído", "concluída"
"terminei", "terminou", "já terminei", "já terminou", "termine"
"fiz", "já fiz", "fiz a tarefa", "já fiz a tarefa", "foi feito", "já fiz isso"
"resolvi", "já resolvi", "resolvido", "resolvida", "resolve"
"pronto", "pronta", "tá pronto", "ta pronto", "tá feito", "ta feito", "tá ok"
"feito", "feita", "ok a tarefa", "ok feito", "missão cumprida", "check", "✓", "✅"
"marca como feito", "marca como concluído", "marca como concluída", "risca da lista", "riscar"
"já paguei", "já liguei", "já fui", "já comprei", "já resolvi", "já fiz"
"finalizado", "finalizada", "finalizei", "acabei", "já acabei", "concluí isso"
"cumpri", "já cumpri", "cumprido", "executei", "já executei", "executado"
"foi", "foi feito", "foi resolvido", "foi concluído", "foi pago", "foi para"
IMPORTANTE: "Já conclui/concluí/terminei/fiz [algo]" → tipo tarefa acao concluir com titulo=[algo]

ATRIBUIÇÃO DE TAREFA:
"atribui tarefa X para Bruna", "cria tarefa X para Bruna", "tarefa X para Bruna"
"atribuir tarefa para [nome] hoje de [fazer algo]" → titulo=[fazer algo], atribuir_para=[nome]
"atribuir [nome] de [tarefa]", "atribuir [tarefa] para [nome]"
"tarefa X é para Bruna", "passa tarefa X para Bruna", "manda tarefa pra Bruna"
"delega tarefa X para Bruna", "tarefa X fica com Bruna", "Bruna faz X"
"Bruna tem que fazer X", "X é tarefa da Bruna", "X fica com Bruna"
"atribui para Bruna: X", "para Bruna: X", "pra Bruna: X"
"passa pra Yan lavar o carro", "diz pra Bruna fazer X", "fala pra Yan fazer X"
"Yan precisa fazer X", "X é do Yan", "X é pra Yan"
Quando identificar nome de pessoa após "para", "à", "ao", "pra", "pro" com uma ação → campo "atribuir_para": "nome"
Se prazo na mensagem (hoje, amanhã, sexta, 25/05) → "prazo": "[data]", "pedir_prazo": false
Se SEM prazo → "prazo": null, "pedir_prazo": true

EXEMPLOS DE ATRIBUIÇÃO (MUITO IMPORTANTES):
"Atribuir tarefa para Yan hoje de lavar o carro" → {"tipo":"tarefa","acao":"criar","titulo":"Lavar o carro","prazo":"${new Date().toISOString().split('T')[0]}","pedir_prazo":false,"atribuir_para":"Yan"}
"Cria tarefa para Bruna amanhã de limpar a casa" → {"tipo":"tarefa","acao":"criar","titulo":"Limpar a casa","prazo":"${new Date(Date.now()+86400000).toISOString().split('T')[0]}","pedir_prazo":false,"atribuir_para":"Bruna"}
"Passa pra Bruna fazer as compras" → {"tipo":"tarefa","acao":"criar","titulo":"Fazer as compras","prazo":null,"pedir_prazo":true,"atribuir_para":"Bruna"}
"Atribuir Yan de ir ao banco sexta" → {"tipo":"tarefa","acao":"criar","titulo":"Ir ao banco","pedir_prazo":false,"atribuir_para":"Yan"}
"Tarefa lavar o carro pra Yan" → {"tipo":"tarefa","acao":"criar","titulo":"Lavar o carro","pedir_prazo":true,"atribuir_para":"Yan"}

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

FORMATO TAREFA COM ATRIBUIÇÃO (prazo informado):
{
  "tipo": "tarefa",
  "acao": "criar",
  "titulo": "Nome da tarefa",
  "prazo": "${new Date().toISOString().split('T')[0]}",
  "prioridade": "Media",
  "pedir_prazo": false,
  "atribuir_para": "Bruna"
}

FORMATO TAREFA COM ATRIBUIÇÃO (sem prazo):
{
  "tipo": "tarefa",
  "acao": "criar",
  "titulo": "Nome da tarefa",
  "prazo": null,
  "prioridade": "Media",
  "pedir_prazo": true,
  "atribuir_para": "Bruna"
}

FORMATO TAREFA SEM PRAZO (própria):
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
PRIORIDADE ABSOLUTA — mensagem SEM valor numérico que seja substantivo financeiro = SEMPRE consulta:
"faturas", "fatura", "ver faturas", "minhas faturas", "todas as faturas", "conferir faturas", "quanto devo" → {"tipo":"consulta","pergunta":"faturas_todas","mes":null}
"gastos", "meus gastos", "ver gastos", "extrato", "balanço", "total do mês", "quanto gastei", "o que saiu" → {"tipo":"consulta","pergunta":"gastos_mes"}
"gastos hoje", "total hoje", "o que gastei hoje", "o que saiu hoje" → {"tipo":"consulta","pergunta":"gastos_hoje"}
"saldo", "meu saldo", "quanto tenho", "situação", "situação financeira", "como estou financeiramente", "posso gastar", "quanto sobrou" → {"tipo":"consulta","pergunta":"saldo"}
"resumo", "alertas", "status", "meu resumo", "resumo do dia", "como estou", "me atualiza", "novidades", "avisos" → {"tipo":"consulta","pergunta":"resumo"}
"tarefas", "minhas tarefas", "ver tarefas", "lista tarefas", "pendências", "afazeres", "minha lista" → {"tipo":"tarefa","acao":"listar"}
"pendentes", "ver pendentes", "lançamentos pendentes", "a autorizar", "para aprovar" → {"tipo":"comando","acao":"listar_pendentes"}

FATURA DE CARTÃO ESPECÍFICO:
"fatura do nu/nubank/roxo", "quanto ta o nubank" → {"tipo":"consulta","pergunta":"fatura","cartao":"Nubank","mes":null}
"fatura do inter/laranja", "quanto ta o inter" → {"tipo":"consulta","pergunta":"fatura","cartao":"Inter","mes":null}
"fatura do itaú", "quanto ta o itaú" → {"tipo":"consulta","pergunta":"fatura","cartao":"Itaú","mes":null}
"fatura do C6", "quanto ta o C6" → {"tipo":"consulta","pergunta":"fatura","cartao":"C6 Bank","mes":null}
"fatura do Bradesco" → {"tipo":"consulta","pergunta":"fatura","cartao":"Bradesco","mes":null}
Faturas por mês: "fatura do nu em junho", "fatura nubank próximo mês" → incluir campo "mes"

FORMATO CONSULTA FATURA:
{"tipo":"consulta","pergunta":"fatura","cartao":"Nubank","mes":null}
{"tipo":"consulta","pergunta":"faturas_todas","mes":null}
O campo "mes": null=atual, "proximo"=próximo mês, número 1-12=mês específico.

━━━ COMANDOS ━━━
"cancela", "cancela o último", "cancela o gasto", "desfaz", "erro", "apaga o último", "remove o último", "foi errado" → {"tipo":"comando","acao":"cancelar_ultimo"}
"lista pendentes", "pendentes", "ver pendentes", "o que está pendente para autorizar", "a autorizar", "para aprovar" → {"tipo":"comando","acao":"listar_pendentes"}

━━━ FOTOS E COMPROVANTES ━━━

REGRA PRINCIPAL: Se há uma foto, SEMPRE tente extrair pelo menos o valor. Nunca retorne erro para fotos — use lancamento_parcial se faltar informação.

COMPROVANTES FÍSICOS (papel fotografado, recibo, cupom):
- Procure o campo "Total", "Valor", "R$", "TOTAL A PAGAR", "VALOR TOTAL"
- Identifique o estabelecimento pelo cabeçalho ou logotipo
- Mercado Pago, PagBank, InfinitePay, SumUp = máquina de cartão → usar como banco/cartão
- Se texto parcialmente ilegível → tente pelo contexto visual

COMPROVANTES DIGITAIS (prints de tela):
- Notificação de banco: "Você pagou R$ X para Y" → lancamento com descricao=Y, valor=X
- Comprovante Pix recebido → receita, não despesa
- Comprovante Pix enviado → despesa

EXEMPLOS DE EXTRAÇÃO:
- Comprovante Mercado Pago R$ 11,00 → {"tipo":"lancamento","descricao":"Mercado Pago","valor":11.00,"categoria":"Serviços","cartao":"Mercado Pago","data_lancamento":"hoje"}
- Nota fiscal supermercado → tipo "multiplos" com os itens
- Print notificação Nubank "Compra aprovada R$ 47,00 iFood" → {"tipo":"lancamento","descricao":"iFood","valor":47.00,"categoria":"Alimentação","cartao":"Nubank",...}
- Se só conseguir ver o valor → {"tipo":"lancamento_parcial","campo_faltando":"descricao","valor":11.00,...}

NUNCA retorne erro para fotos. Se não conseguir nada → {"tipo":"lancamento_parcial","campo_faltando":"descricao","valor":0}

Data de hoje: ${new Date().toISOString().split('T')[0]}
Mensagem: `;

  let contents = [];

  if (fotoUrl) {
    const b64 = await urlToBase64(fotoUrl);
    // Para fotos: completa o prompt com instrução explícita de analisar a imagem
    const textoFoto = texto
      ? `${texto}\n\nAnalise também a imagem acima e extraia o gasto conforme as instruções.`
      : `Analise a imagem acima. Extraia o valor, estabelecimento e tipo de gasto. Retorne o JSON conforme as instruções.`;
    contents = [{
      parts: [
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: b64 } },
        { text: `${prompt}${textoFoto}` }
      ]
    }];
  } else if (audioUrl) {
    const b64 = await urlToBase64(audioUrl);
    // Para áudio: instrução explícita de transcrever e interpretar
    contents = [{
      parts: [
        { inline_data: { mime_type: mimeType || 'audio/ogg', data: b64 } },
        { text: `${prompt}Transcreva o áudio acima e interprete como mensagem financeira conforme as instruções.` }
      ]
    }];
  } else {
    contents = [{
      parts: [{ text: `${prompt}${texto}` }]
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
  let texto = msg.text || msg.caption || '';

  console.log('Chat ID:', chat_id, 'Texto:', texto);

  try {
    // 1. Verifica se o chat_id já está vinculado
    const vincRes = await supabaseQuery(
      `/telegram_vinculos?chat_id=eq.${chat_id}&select=user_id,nome,principal`
    );
    const vinculo = vincRes?.[0];

    // 2. Se NÃO vinculado — verifica se está enviando um token
    if (!vinculo) {
      const tokenLimpo = texto.trim().replace(/\s/g, '');
      console.log('Sem vínculo, buscando token:', tokenLimpo);

      // Busca token em user_data (salvo via api/generate-token com service key)
      const tokenUdRes = await supabaseQuery(`/user_data?user_id=eq.__tgtoken__${tokenLimpo}&select=data`);
      let tokenData = tokenUdRes?.[0]?.data || null;
      console.log('Token user_data resultado:', JSON.stringify(tokenData));

      // Fallback: busca na tabela telegram_tokens (legado)
      if (!tokenData) {
        const tokenRes = await supabaseQuery(
          `/telegram_tokens?token=eq.${tokenLimpo}&usado=eq.false&select=user_id,token,expires_at,nome`
        );
        const legado = tokenRes?.[0];
        if (legado) {
          // Resolve username via mapeamento __uid__
          let username = legado.user_id;
          if (username && username.includes('-')) {
            const m = await supabaseQuery(`/user_data?user_id=eq.__uid__${username}&select=data`);
            if (m?.[0]?.data?.username) username = m[0].data.username;
          }
          tokenData = { token: legado.token, nome: legado.nome, username, expires_at: legado.expires_at };
        }
      }

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
        // Limpa token expirado
        await supabaseQuery(`/user_data?user_id=eq.__tgtoken__${tokenLimpo}`, 'DELETE');
        return res.status(200).json({ ok: true });
      }

      const tokenUsername = tokenData.username;
      // Usa auth_uid (UUID) se disponível — compatível com colunas UUID no Supabase
      // Fallback para username se coluna for TEXT
      const vinculoUserId = tokenData.auth_uid || tokenUsername;
      console.log('Criando vínculo: chat_id=', chat_id, 'user_id=', vinculoUserId);

      // Remove vínculo antigo deste chat_id e cria novo
      await supabaseQuery(`/telegram_vinculos?chat_id=eq.${chat_id}`, 'DELETE');
      const vincResult = await supabaseQuery('/telegram_vinculos', 'POST', {
        user_id: vinculoUserId,
        chat_id,
        nome: tokenData.nome || 'Usuário',
        principal: false,
        vinculado_em: new Date().toISOString()
      });
      console.log('Vínculo criado resultado:', JSON.stringify(vincResult));

      // Garante mapeamento __uid__ → username imediatamente após o vínculo
      // (sem isso, a resolução UUID→username falha até o usuário abrir o app)
      if (tokenData.auth_uid && tokenUsername) {
        await fetch(`${SUPABASE_URL}/rest/v1/user_data`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify({
            user_id: '__uid__' + tokenData.auth_uid,
            data: { username: tokenUsername },
            updated_at: new Date().toISOString()
          })
        });
        console.log('Mapeamento __uid__ criado:', tokenData.auth_uid, '->', tokenUsername);
      }

      // Invalida token usado
      await supabaseQuery(`/user_data?user_id=eq.__tgtoken__${tokenLimpo}`, 'DELETE');
      await supabaseQuery(
        `/telegram_tokens?token=eq.${tokenLimpo}`,
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
    // Resolve username: vinculo pode ter UUID (legado) ou username direto
    // Tenta mapeamento __uid__ para garantir que user_id seja o username correto
    let user_id = vinculo.user_id;
    const vinculo_user_id = vinculo.user_id; // UUID original — usado para queries em telegram_vinculos
    console.log('user_id do vínculo:', user_id);
    if (user_id && user_id.includes('-')) { // parece UUID
      const uidMap = await supabaseQuery(`/user_data?user_id=eq.__uid__${user_id}&select=data`);
      const mappedUser = uidMap?.[0]?.data?.username;
      console.log('Resolução UUID:', user_id, '->', mappedUser || '(não encontrado)');
      if (mappedUser) user_id = mappedUser;
      else console.warn('AVISO: UUID não resolvido para username — faturas e dados não encontrados!');
    }
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
      if (!audioUrl) {
        await sendTelegram(chat_id, '❌ Não consegui baixar o áudio. Tente novamente.');
        return res.status(200).json({ ok: true });
      }
      mensagem_original = '[Áudio]';
    } else if (msg.photo) {
      tipo_midia = 'foto';
      const file_id = msg.photo[msg.photo.length - 1].file_id;
      mimeType = 'image/jpeg';
      fotoUrl = await getTelegramFileUrl(file_id);
      if (!fotoUrl) {
        await sendTelegram(chat_id, '❌ Não consegui baixar a imagem. Tente novamente.');
        return res.status(200).json({ ok: true });
      }
      mensagem_original = msg.caption ? `[Foto] ${msg.caption}` : '[Foto]';
    } else if (msg.document && msg.document.mime_type === 'application/pdf') {
      tipo_midia = 'pdf';
      const file_id = msg.document.file_id;
      mimeType = 'application/pdf';
      fotoUrl = await getTelegramFileUrl(file_id);
      if (!fotoUrl) {
        await sendTelegram(chat_id, '❌ Não consegui baixar o PDF. Tente novamente.');
        return res.status(200).json({ ok: true });
      }
      mensagem_original = msg.caption ? `[PDF] ${msg.caption}` : '[PDF]';
    }

    // ── Comandos explícitos de cancelamento/reset ────────────────────────────
    const _cancelCmds = ['cancela','cancelar','cancela tudo','esquece','esqueça','esquecer','recomeça','recomeçar','cancela gasto','cancela lançamento','cancela isso','apaga isso','descarta','voltar','começa de novo'];
    if (_cancelCmds.some(cw => texto.toLowerCase().trim() === cw || texto.toLowerCase().trim().startsWith(cw+' '))) {
      if (ctx.aguardando) {
        await limparContexto(chat_id);
        await sendTelegram(chat_id, `✅ Cancelado! Me envie um novo gasto, tarefa ou comando quando quiser.`);
      } else {
        await sendTelegram(chat_id, `Nenhuma ação em andamento para cancelar.`);
      }
      return res.status(200).json({ ok: true });
    }

    // ── Detecção de nova intenção: evita que contexto antigo capture mensagem nova ──
    // Se o usuário estiver num fluxo (modalidade, cartão, etc.) e enviar uma mensagem
    // com intenção claramente diferente, limpa o contexto e processa do zero.
    const _estadosMidFlow = ['modalidade','cartao','valor','descricao','categoria','descricao_receita','descricao_foto','parcelamento','num_parcelas','mercado_multiplos','menu_ajuda','resposta_reagendamento','contraproposta_prazo','resposta_contraproposta','receita_tipo','receita_dia'];
    const _novosIntentosKw = [
      'atribui','atribuir','criar tarefa','nova tarefa','tarefa para','tarefa:',
      'recebi','recebi de','entrou na conta','salário','salario','freelance',
      'gastei','gasto ','comprei','paguei','transferi',
      'minhas tarefas','lista tarefas','ver tarefas','pendências',
      'concluí','conclui','terminei','finalizei','já fiz',
      'faturas','fatura','gastos','saldo','resumo','alertas','tarefas','pendentes'
    ];
    if (ctx.aguardando && _estadosMidFlow.includes(ctx.aguardando)) {
      const _tl = texto.toLowerCase();
      if (_novosIntentosKw.some(kw => _tl.includes(kw))) {
        await limparContexto(chat_id);
        ctx.aguardando = null; // limpa localmente para não entrar no bloco abaixo
      }
    }

    // ── Central de Ajuda ─────────────────────────────────────────────────────
    const _textoAjuda = texto.toLowerCase().trim();
    const _ajudaExato = ['ajuda','help','socorro','/help','/start','/menu','menu','guia','funcoes','funções','funcionalidades','funcionalidade','o que voce faz','o que vc faz','o que você faz','oque voce faz','sobre','inicio','início','oi','ola','olá','eai','eaí','ei','opa','hey','hi','hello','bom dia','boa tarde','boa noite'];
    const _ajudaContem = ['como funciona','como usar','sobre o sistema','sobre o bot','sobre o by finance','o que pode','quais funcoes','quais funções','me explica','tudo sobre','o que e isso','o que é isso','o que e o by','o que é o by','o que sou','o que faz','me conta sobre','ver funcoes','ver funções','me mostra','todas as funções','todas as funcoes','explorar','conhecer o sistema','sobre o'];
    const _isAjuda = !audioUrl && !fotoUrl && (_ajudaExato.includes(_textoAjuda) || _ajudaContem.some(kw => _textoAjuda.includes(kw)));
    if (_isAjuda) {
      if (ctx.aguardando) await limparContexto(chat_id);
      await setContexto(chat_id, { aguardando: 'menu_ajuda' });
      await sendTelegram(chat_id,
        `📋 *BY Finance — Central de Ajuda*\n\n` +
        `Sou o assistente do *BY Finance*. Escolha uma área:\n\n` +
        `1️⃣ Lançar gastos e despesas\n` +
        `2️⃣ Registrar receitas\n` +
        `3️⃣ Tarefas — criar, atribuir e responder\n` +
        `4️⃣ Autorizar lançamentos pendentes\n` +
        `5️⃣ Compras de mercado\n` +
        `6️⃣ Fotos, áudios e PDFs\n` +
        `7️⃣ Dispositivos vinculados\n\n` +
        `Digite o número para saber mais, ou *0* para fechar.`
      );
      return res.status(200).json({ ok: true });
    }

    // ── Fluxo de contexto: resposta a pergunta anterior ──────────────────────
    if (ctx.aguardando && texto) {
      const campo = ctx.aguardando;
      const gasto = ctx.gasto_parcial || {};

      if (campo === 'menu_ajuda') {
        const _op = texto.trim();
        const _menuPrincipal =
          `📋 *BY Finance — Central de Ajuda*\n\n` +
          `1️⃣ Lançar gastos e despesas\n` +
          `2️⃣ Registrar receitas\n` +
          `3️⃣ Tarefas — criar, atribuir e responder\n` +
          `4️⃣ Autorizar lançamentos pendentes\n` +
          `5️⃣ Compras de mercado\n` +
          `6️⃣ Fotos, áudios e PDFs\n` +
          `7️⃣ Dispositivos vinculados\n\n` +
          `Digite o número para saber mais, ou *0* para fechar.`;
        if (_op === '0' || /^(fechar|fecha|sair|voltar|cancelar)$/i.test(_op)) {
          await limparContexto(chat_id);
          await sendTelegram(chat_id, `✅ Menu fechado. Me envie um gasto, receita ou tarefa quando quiser!`);
          return res.status(200).json({ ok: true });
        }
        const _detalhes = {
          '1':
            `💸 *Lançar gastos e despesas*\n\n` +
            `Registre qualquer despesa pelo chat.\n\n` +
            `📝 *Por texto:*\n` +
            `• "Gastei 50 no iFood"\n` +
            `• "Uber 23 reais no débito Nubank"\n` +
            `• "Netflix 45 crédito"\n` +
            `• "200 em 3x no cartão Nubank"\n\n` +
            `🎤 *Por áudio:* grave falando o gasto normalmente\n\n` +
            `📸 *Por foto ou PDF:* foto de cupom, nota ou comprovante\n\n` +
            `O bot pergunta forma de pagamento, cartão e parcelas quando necessário. O lançamento fica *pendente* no BY Finance aguardando autorização.\n\n` +
            `_Digite outro número ou 0 para fechar._`,
          '2':
            `💰 *Registrar receitas*\n\n` +
            `Registre entradas de dinheiro da mesma forma que gastos.\n\n` +
            `Exemplos:\n` +
            `• "Recebi 2000 de salário"\n` +
            `• "Entrou 500 de freelance"\n` +
            `• "Cliente pagou 800"\n` +
            `• Foto de comprovante Pix recebido\n\n` +
            `O bot identifica como receita automaticamente e aguarda autorização no BY Finance.\n\n` +
            `_Digite outro número ou 0 para fechar._`,
          '3':
            `📝 *Tarefas*\n\n` +
            `*Criar tarefa própria:*\n` +
            `• "Criar tarefa pagar contas"\n` +
            `• "Lembrar de ligar pro banco sexta"\n\n` +
            `*Atribuir para alguém vinculado:*\n` +
            `• "Criar tarefa lavar o carro para Bruna"\n` +
            `• A pessoa recebe notificação e responde:\n` +
            `  1️⃣ Aceitar   2️⃣ Reagendar   3️⃣ Negar\n\n` +
            `*Concluir tarefa:*\n` +
            `• "Conclui a tarefa pagar contas"\n` +
            `• "Terminei de lavar o carro"\n\n` +
            `As tarefas aparecem no quadro do BY Finance em tempo real.\n\n` +
            `_Digite outro número ou 0 para fechar._`,
          '4':
            `✅ *Autorizar lançamentos pendentes*\n\n` +
            `Todo lançamento registrado fica *pendente por 7 dias*.\n\n` +
            `Para autorizar: abra o BY Finance, clique no ícone do Telegram no topo e escolha Autorizar ou Rejeitar.\n\n` +
            `Na tela de autorização você define:\n` +
            `• Forma de pagamento real\n` +
            `• Cartão utilizado\n` +
            `• Estabelecimento (opcional)\n` +
            `• Bem vinculado (opcional)\n\n` +
            `Com 2+ dispositivos vinculados: qualquer pessoa pode autorizar e todos recebem notificação de confirmação.\n\n` +
            `_Digite outro número ou 0 para fechar._`,
          '5':
            `🛒 *Compras de mercado*\n\n` +
            `Ao fotografar um cupom fiscal, o bot pergunta se é supermercado/mercado.\n\n` +
            `Se *Sim*: cada item entra na lista de compras variáveis do mês no BY Finance, com rastreio de preço por item ao longo do tempo.\n\n` +
            `Se *Não*: os itens são salvos normalmente sem vínculo com a lista de mercado.\n\n` +
            `Ideal para controlar quanto você gasta em cada produto e comparar preços mês a mês.\n\n` +
            `_Digite outro número ou 0 para fechar._`,
          '6':
            `📸 *Fotos, áudios e PDFs*\n\n` +
            `*Foto ou PDF:*\n` +
            `• Cupom com vários itens → extrai cada produto separado\n` +
            `• Comprovante Pix recebido → registra como receita\n` +
            `• Comprovante Pix enviado → registra como despesa\n` +
            `• Comprovante de cartão → registra valor e estabelecimento\n\n` +
            `*Áudio:*\n` +
            `• Fale o gasto: _"cinquenta reais no mercado"_\n` +
            `• O bot transcreve e interpreta igual ao texto\n\n` +
            `Dica: para cupons com muitos itens o bot pergunta se é mercado antes de salvar.\n\n` +
            `_Digite outro número ou 0 para fechar._`,
          '7':
            `📱 *Dispositivos vinculados*\n\n` +
            `Conecte múltiplos Telegrams ao mesmo BY Finance.\n\n` +
            `*Como vincular:*\n` +
            `Acesse BY Finance → Configurações → Vincular Telegram e use o código gerado.\n\n` +
            `*Com 2+ dispositivos:*\n` +
            `• Um registra o gasto, o outro recebe notificação\n` +
            `• Tarefas podem ser criadas e atribuídas entre vinculados\n` +
            `• Qualquer vinculado pode autorizar lançamentos\n` +
            `• Confirmações e notificações chegam para todos\n\n` +
            `*Casos de uso:*\n` +
            `• Casal controlando finanças juntos\n` +
            `• Sócios gerindo gastos do negócio\n\n` +
            `_Digite outro número ou 0 para fechar._`
        };
        if (_detalhes[_op]) {
          await sendTelegram(chat_id, _detalhes[_op]);
        } else {
          await sendTelegram(chat_id, `Opção inválida.\n\n` + _menuPrincipal);
        }
        return res.status(200).json({ ok: true });
      }

      if (campo === 'confirmar_lancamento_foto') {
        const _t=texto.toLowerCase().trim();
        const sim = ['sim','s','ok','certo','correto','pode','confirma','confirmar','yes','y','continua','continuar','envia','enviar','tá bom','ta bom','exato','isso','perfeito','👍','beleza','blz','combinado','fechado','claro','pode ser','bora','top','show','tudo certo','tudo bem','correto','positivo','afirmativo'].some(p=>_t.startsWith(p)||_t===p);
        const nao = ['não','nao','n','errado','errada','editar','edita','mudar','muda','corrigir','corrige','incorreto','incorreta','errou','wrong','no','negativo','negativo','tá errado','ta errado','não está','nao esta','incorreto','muda','alterar','altera','ajustar','ajusta'].some(p=>_t.startsWith(p)||_t===p);

        if (sim) {
          const _modConf = (gasto.modalidade || '').toLowerCase();
          const _isCDConf = _modConf.includes('créd') || _modConf.includes('cred') || _modConf.includes('déb') || _modConf.includes('deb');
          const _isCredConf = _modConf.includes('créd') || _modConf.includes('cred');
          if (!gasto.modalidade) {
            await setContexto(chat_id, { aguardando: 'modalidade', gasto_parcial: gasto });
            await sendTelegram(chat_id, `💳 Como foi o pagamento?\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro\n5️⃣ Crédito Parcelado`);
          } else if (_isCDConf && (!gasto.cartao || gasto.cartao === 'Não informado')) {
            await setContexto(chat_id, { aguardando: 'cartao', gasto_parcial: gasto });
            await sendTelegram(chat_id, `💳 Qual cartão ou banco?\n\nEx: Nubank, Inter, Itaú, Bradesco...`);
          } else if (_isCredConf && !gasto.parcelas && gasto.tipo !== 'multiplos') {
            await setContexto(chat_id, { aguardando: 'parcelamento', gasto_parcial: gasto });
            await sendTelegram(chat_id, `💳 Foi à vista ou parcelado?\n\n1️⃣ À vista\n2️⃣ Parcelado`);
          } else {
            if (gasto.tipo === 'multiplos') {
              await setContexto(chat_id, { aguardando: 'mercado_multiplos', gasto_parcial: gasto });
              await sendTelegram(chat_id, `🛒 Essa compra foi no mercado/supermercado?\n\n1️⃣ Compra do mês\n2️⃣ Compra variável (semana)\n3️⃣ Não é mercado`);
              return res.status(200).json({ ok: true });
            }
            await limparContexto(chat_id);
            await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, nomeRemetente);
            const vConf = (parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
            const _parcelaConf = gasto.parcelas && gasto.parcelas > 1 ? `\n🔄 ${gasto.parcelas}x de ${parseFloat(gasto.valor_parcela||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}` : '';
            await sendTelegram(chat_id,
              `✅ *Lançamento registrado!*\n\n` +
              `📝 ${gasto.descricao||'(sem descrição)'}\n` +
              `💰 ${vConf}${_parcelaConf}\n` +
              `🏷 ${gasto.categoria||'Outros'}\n` +
              `💳 ${fmtCartao(gasto.cartao||'Não informado')}\n` +
              `${iconeModalidade(gasto.modalidade)} ${gasto.modalidade||'Não informado'}\n` +
              `📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n` +
              `⏳ Aguardando sua autorização no BY Finance.\n` +
              `Você tem *7 dias* para aprovar ou rejeitar.`
            );
            const outrosConf = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
            for (const o of (outrosConf||[])) {
              await sendTelegram(o.chat_id,
                `📱 *${escapeMd(nomeRemetente)} registrou um gasto pendente*\n\n` +
                `📝 ${escapeMd(gasto.descricao||'(sem descrição)')}\n` +
                `💰 ${vConf}${_parcelaConf}\n` +
                `🏷 ${escapeMd(gasto.categoria||'Outros')}\n` +
                `💳 ${escapeMd(fmtCartao(gasto.cartao||'Não informado'))}\n` +
                `${iconeModalidade(gasto.modalidade)} ${escapeMd(gasto.modalidade||'Não informado')}\n` +
                `📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n` +
                `_Acesse o BY Finance para autorizar\\._`
              );
            }
          }
          return res.status(200).json({ ok: true });
        }

        if (nao) {
          if (gasto.tipo === 'multiplos') {
            await limparContexto(chat_id);
            await sendTelegram(chat_id, `❌ Lançamento cancelado.`);
            return res.status(200).json({ ok: true });
          }
          const _vMenu=(parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
          await setContexto(chat_id, { aguardando: 'editar_menu_foto', gasto_parcial: gasto });
          await sendTelegram(chat_id,
            `✏️ *Qual campo deseja editar?*\n\n` +
            `1️⃣ ${escapeMd(gasto.descricao||'(sem descrição)')}\n` +
            `2️⃣ ${_vMenu}\n` +
            `3️⃣ ${escapeMd(gasto.categoria||'Outros')}\n` +
            `4️⃣ ${escapeMd(fmtCartao(gasto.cartao||'Não informado'))}\n` +
            `5️⃣ ${escapeMd(gasto.modalidade||'Não informado')}\n` +
            `6️⃣ ${fmtData(gasto.data_lancamento)}\n\n` +
            `Digite o número do campo.`
          );
          return res.status(200).json({ ok: true });
        }

        // Não entendeu
        await sendTelegram(chat_id, `Responda *sim* para confirmar ou *não* para editar.`);
        return res.status(200).json({ ok: true });

      } else if (campo === 'editar_menu_foto') {
        // Usuário escolhe qual campo editar pelo número (1-6) ou por nome
        const t = texto.trim();
        const tl = t.toLowerCase();
        const fieldMap = { '1':'descricao','2':'valor','3':'categoria','4':'cartao','5':'modalidade','6':'data' };
        let escolhido = fieldMap[t];
        if (!escolhido) {
          if (tl.includes('descri') || tl.includes('nome') || tl.includes('estabelec')) escolhido = 'descricao';
          else if (tl.includes('valor') || tl.includes('preço') || tl.includes('preco') || tl === 'r$') escolhido = 'valor';
          else if (tl.includes('categ')) escolhido = 'categoria';
          else if (tl.includes('cartão') || tl.includes('cartao') || tl.includes('banco') || tl.includes('nubank') || tl.includes('inter') || tl.includes('itaú') || tl.includes('bradesco')) escolhido = 'cartao';
          else if (tl.includes('modal') || tl.includes('forma') || tl.includes('pix') || tl.includes('créd') || tl.includes('cred') || tl.includes('déb') || tl.includes('deb') || tl.includes('dinheiro')) escolhido = 'modalidade';
          else if (tl.includes('data') || tl.includes('dia') || tl.includes('/')) escolhido = 'data';
        }
        if (!escolhido) {
          const _vM=(parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
          await sendTelegram(chat_id,
            `✏️ *Qual campo deseja editar?*\n\n` +
            `1️⃣ ${escapeMd(gasto.descricao||'(sem descrição)')}\n` +
            `2️⃣ ${_vM}\n` +
            `3️⃣ ${escapeMd(gasto.categoria||'Outros')}\n` +
            `4️⃣ ${escapeMd(fmtCartao(gasto.cartao||'Não informado'))}\n` +
            `5️⃣ ${escapeMd(gasto.modalidade||'Não informado')}\n` +
            `6️⃣ ${fmtData(gasto.data_lancamento)}\n\n` +
            `Digite o número do campo.`
          );
          return res.status(200).json({ ok: true });
        }
        const pergLabels = {
          descricao: `📝 *Descrição* (atual: _${gasto.descricao||'(sem descrição)'}_)\n\nDigite o novo valor:`,
          valor: `💰 *Valor* (atual: _${(parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}_)\n\nDigite o novo valor:`,
          categoria: `🏷 *Categoria* (atual: _${gasto.categoria||'Outros'}_)\n\nEx: Alimentação, Transporte, Mercado, Saúde, Lazer`,
          cartao: `💳 *Cartão ou banco* (atual: _${fmtCartao(gasto.cartao||'Não informado')}_)\n\nEx: Nubank, Inter, Itaú, Bradesco...`,
          modalidade: `💳 *Forma de pagamento* (atual: _${gasto.modalidade||'Não informado'}_)\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro\n5️⃣ Crédito Parcelado`,
          data: `📅 *Data* (atual: _${fmtData(gasto.data_lancamento)}_)\n\nEx: 22/05 ou hoje`,
        };
        await setContexto(chat_id, { aguardando: 'editar_valor_campo', gasto_parcial: gasto, campo_editar: escolhido });
        await sendTelegram(chat_id, pergLabels[escolhido]);
        return res.status(200).json({ ok: true });

      } else if (campo === 'editar_valor_campo') {
        // Recebe o novo valor do campo escolhido
        const campoEditar = ctx.campo_editar;
        if (campoEditar === 'descricao') {
          gasto.descricao = texto.trim();
        } else if (campoEditar === 'valor') {
          const v = parseFloat(texto.replace(',','.').replace(/[^\d.]/g,''));
          if (!isNaN(v) && v > 0) gasto.valor = v;
        } else if (campoEditar === 'categoria') {
          gasto.categoria = texto.trim();
        } else if (campoEditar === 'cartao') {
          gasto.cartao = fmtCartao(texto.trim());
        } else if (campoEditar === 'modalidade') {
          const normMod = normalizeModalidade(texto);
          gasto.modalidade = normMod;
          const modLow2 = normMod.toLowerCase();
          if (modLow2 === 'pix' || modLow2 === 'dinheiro') gasto.cartao = normMod;
        } else if (campoEditar === 'data') {
          const _novaData = parsePrazo(texto);
          if (_novaData) gasto.data_lancamento = _novaData;
        }
        // Mostra resumo atualizado e volta para confirmar
        const vFinal = (parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
        await setContexto(chat_id, { aguardando: 'confirmar_lancamento_foto', gasto_parcial: gasto });
        await sendTelegram(chat_id,
          `📋 *Dados revisados:*\n\n` +
          `📝 ${gasto.descricao||'(sem descrição)'}\n` +
          `💰 ${vFinal}\n` +
          `🏷 ${gasto.categoria||'Outros'}\n` +
          `💳 ${fmtCartao(gasto.cartao||'Não informado')}\n` +
          `${iconeModalidade(gasto.modalidade)} ${gasto.modalidade||'Não informado'}\n` +
          `📅 ${fmtData(gasto.data_lancamento)}\n\n` +
          `Confirma? *sim* para enviar ou *não* para editar outro campo.`
        );
        return res.status(200).json({ ok: true });

      } else if (campo === 'descricao_foto') {
        // Usuário respondeu após foto não reconhecida — interpreta com Gemini
        const gastoFoto = await interpretarComGemini({ texto, audioUrl: null, fotoUrl: null, mimeType: null });
        if (gastoFoto.tipo === 'lancamento' || gastoFoto.tipo === 'lancamento_parcial') {
          // Mescla com o gasto parcial (preserva data)
          const merged = { ...gasto, ...gastoFoto };
          if (!merged.descricao || merged.descricao === '(sem descrição)') {
            merged.descricao = texto.trim();
          }
          // Continua fluxo normal com verificações completas
          const _modDF = (merged.modalidade||'').toLowerCase();
          const _isCDDF = _modDF.includes('créd')||_modDF.includes('cred')||_modDF.includes('déb')||_modDF.includes('deb');
          const _isCredDF = _modDF.includes('créd')||_modDF.includes('cred');
          if (!merged.modalidade) {
            await setContexto(chat_id, { aguardando: 'modalidade', gasto_parcial: merged });
            await sendTelegram(chat_id, `💳 Como foi o pagamento?\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro\n5️⃣ Crédito Parcelado`);
          } else if (_isCDDF && (!merged.cartao || merged.cartao === 'Não informado')) {
            await setContexto(chat_id, { aguardando: 'cartao', gasto_parcial: merged });
            await sendTelegram(chat_id, `💳 Qual cartão ou banco?\n\nEx: Nubank, Inter, Itaú, Bradesco...`);
          } else if (_isCredDF && !merged.parcelas) {
            await setContexto(chat_id, { aguardando: 'parcelamento', gasto_parcial: merged });
            await sendTelegram(chat_id, `💳 Foi à vista ou parcelado?\n\n1️⃣ À vista\n2️⃣ Parcelado`);
          } else {
            await limparContexto(chat_id);
            await salvarPendente(chat_id, user_id, merged, tipo_midia, mensagem_original, nomeRemetente);
            const vFoto = (parseFloat(merged.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
            const _parcelaFoto = merged.parcelas && merged.parcelas > 1 ? `\n🔄 ${merged.parcelas}x de ${parseFloat(merged.valor_parcela||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}` : '';
            await sendTelegram(chat_id, `✅ *Lançamento registrado!*\n\n📝 ${escapeMd(merged.descricao||'(sem descrição)')}\n💰 ${vFoto}${_parcelaFoto}\n🏷 ${merged.categoria||'Outros'}\n💳 ${fmtCartao(merged.cartao||'Não informado')}\n${iconeModalidade(merged.modalidade)} ${merged.modalidade}\n📅 ${fmtData(merged.data_lancamento||new Date().toISOString().split('T')[0])}\n\n⏳ Aguardando autorização no BY Finance.`);
            const _outrosFoto = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
            for (const o of (_outrosFoto||[])) { await sendTelegram(o.chat_id, `📱 *${escapeMd(nomeRemetente)} registrou um gasto pendente*\n\n📝 ${escapeMd(merged.descricao||'(sem descrição)')}\n💰 ${vFoto}${_parcelaFoto}\n💳 ${escapeMd(fmtCartao(merged.cartao||'Não informado'))}\n${iconeModalidade(merged.modalidade)} ${escapeMd(merged.modalidade)}\n\n_Acesse o BY Finance para autorizar\\._`); }
          }
        } else {
          // Ainda não entendeu — pede valor e descrição separados
          await setContexto(chat_id, { aguardando: 'valor', gasto_parcial: { tipo: 'lancamento', descricao: texto.trim(), data_lancamento: new Date().toISOString().split('T')[0] } });
          await sendTelegram(chat_id, `💰 Qual o valor?`);
        }
        return res.status(200).json({ ok: true });

      } else if (campo === 'resposta_tarefa') {
        const resposta = texto.toLowerCase().trim();
        const tarefaCtx = gasto;

        const _aceitarWords = ['1','aceitar','aceito','aceita','sim','s','ok','pode','beleza','blz','combinado','fechado','claro','topo','top','show','bora','certo','correto','afirmativo','positivo','yes','y','farei','faço','vou fazer','tá bom','ta bom','pode ser','tranquilo','com prazer','com certeza'];
        const _negarWords = ['3','negar','nego','nega','não','nao','n','no','recusar','recuso','recusa','impossível','impossivel','não posso','nao posso','não dá','nao da','não consigo','nao consigo','não quero','nao quero','negativo','sem condições'];
        const _reagendarWords = ['2','reagendar','reagenda','remarcar','remarca','outro dia','mudar data','adiar','adia','mais tarde','não agora','nao agora','depois','outra data','outra hora'];
        // Entradas curtas (<=2 chars) usam match exato para evitar falso positivo (ex: 'n' em 'reagendar')
        const _matchTarefa = (words, resp) => words.some(p =>
          p.length <= 2 ? resp === p : (resp === p || resp.startsWith(p + ' ') || resp.includes(p))
        );
        const _isReagendar = _matchTarefa(_reagendarWords, resposta);
        const _isAceitar = _matchTarefa(_aceitarWords, resposta);
        const _isNegar = _matchTarefa(_negarWords, resposta);

        // Reagendar tem prioridade — verifica primeiro para evitar conflito com palavras curtas
        if (_isReagendar) {
          await setContexto(chat_id, { aguardando: 'reagendar_tarefa', gasto_parcial: tarefaCtx });
          await sendTelegram(chat_id, `📅 Para quando você quer reagendar?\n\nEx: amanhã, sexta, 25/05`);
          return res.status(200).json({ ok: true });
        }

        if (_isAceitar) {
          await limparContexto(chat_id);
          await sendTelegram(tarefaCtx.atribuidor_chat_id,
            `✅ *${nomeRemetente} aceitou a tarefa!*\n\n📝 ${tarefaCtx.titulo}\n📅 ${tarefaCtx.prazo ? fmtData(tarefaCtx.prazo) : 'Sem prazo'}`
          );
          await sendTelegram(chat_id, `✅ Tarefa aceita! Está no seu quadro de tarefas no BY Finance.`);
          return res.status(200).json({ ok: true });
        }

        if (_isNegar) {
          await limparContexto(chat_id);
          await sendTelegram(tarefaCtx.atribuidor_chat_id,
            `❌ *${nomeRemetente} negou a tarefa*\n\n📝 ${tarefaCtx.titulo}`
          );
          const dadosU = await supabaseQuery(`/user_data?user_id=eq.${tarefaCtx.atribuidor_user_id}&select=data`);
          const dadosNeg = dadosU?.[0]?.data || {};
          dadosNeg[tarefaCtx.atribuidor_user_id + '_tarefas'] = (dadosNeg[tarefaCtx.atribuidor_user_id + '_tarefas'] || []).filter(t => t.id !== tarefaCtx.tarefa_id);
          await supabaseQuery(`/user_data?user_id=eq.${tarefaCtx.atribuidor_user_id}`, 'PATCH', {
            data: dadosNeg,
            updated_at: new Date().toISOString()
          });
          await sendTelegram(chat_id, `❌ Tarefa negada e removida.`);
          return res.status(200).json({ ok: true });
        }

        await sendTelegram(chat_id, `Não entendi. Responda:\n1️⃣ *Aceitar*\n2️⃣ *Reagendar*\n3️⃣ *Negar*`);
        return res.status(200).json({ ok: true });

      } else if (campo === 'reagendar_tarefa') {
        const novoPrazo = parsePrazo(texto);
        if (!novoPrazo) {
          await sendTelegram(chat_id, `❌ Não entendi a data. Tente: *25/05* ou *amanhã*`);
          return res.status(200).json({ ok: true });
        }
        const tarefaRg = gasto;
        await limparContexto(chat_id);
        // Não atualiza prazo ainda — envia proposta ao criador para confirmar
        await setContexto(tarefaRg.atribuidor_chat_id, {
          aguardando: 'resposta_reagendamento',
          gasto_parcial: {
            titulo: tarefaRg.titulo,
            tarefa_id: tarefaRg.tarefa_id,
            atribuidor_user_id: tarefaRg.atribuidor_user_id,
            atribuido_chat_id: chat_id,
            atribuido_user_id: user_id,
            novo_prazo: novoPrazo
          }
        });
        await sendTelegram(tarefaRg.atribuidor_chat_id,
          `📅 *${nomeRemetente} propôs reagendar a tarefa!*\n\n` +
          `📝 ${tarefaRg.titulo}\n` +
          `📅 Prazo proposto: *${fmtData(novoPrazo)}*\n\n` +
          `1️⃣ *Aceitar* a proposta\n` +
          `2️⃣ *Propor* outro dia`
        );
        await sendTelegram(chat_id, `📤 Proposta enviada! Aguardando resposta.`);
        return res.status(200).json({ ok: true });

      } else if (campo === 'resposta_reagendamento') {
        const respRg = texto.toLowerCase().trim();
        const ctxRg = gasto;
        const _matchRg = (words, r) => words.some(p => p.length <= 2 ? r === p : (r === p || r.includes(p)));
        const _aceitarRg = _matchRg(['1','aceitar','aceito','sim','s','ok','pode','beleza','blz','top','show','bora','combinado','fechado'], respRg);
        const _proporRg  = _matchRg(['2','propor','proposta','outro dia','outra data','outro prazo','mudar','diferente','contraproposta'], respRg);

        if (_aceitarRg) {
          const dadosAc = (await supabaseQuery(`/user_data?user_id=eq.${ctxRg.atribuidor_user_id}&select=data`))?.[0]?.data || {};
          const tarefaAc = (dadosAc[ctxRg.atribuidor_user_id + '_tarefas'] || []).find(t => t.id === ctxRg.tarefa_id);
          if (tarefaAc) {
            tarefaAc.prazo = ctxRg.novo_prazo;
            await supabaseQuery(`/user_data?user_id=eq.${ctxRg.atribuidor_user_id}`, 'PATCH', { data: dadosAc, updated_at: new Date().toISOString() });
          }
          await limparContexto(chat_id);
          await sendTelegram(ctxRg.atribuido_chat_id,
            `✅ *Proposta aceita!*\n\n📝 ${ctxRg.titulo}\n📅 Novo prazo: *${fmtData(ctxRg.novo_prazo)}*`
          );
          await sendTelegram(chat_id, `✅ Prazo atualizado para *${fmtData(ctxRg.novo_prazo)}*.`);
          return res.status(200).json({ ok: true });
        }

        if (_proporRg) {
          await setContexto(chat_id, { aguardando: 'contraproposta_prazo', gasto_parcial: ctxRg });
          await sendTelegram(chat_id, `📅 Para quando você quer propor?\n\nEx: amanhã, sexta, 25/05`);
          return res.status(200).json({ ok: true });
        }

        await sendTelegram(chat_id, `Não entendi. Responda:\n1️⃣ *Aceitar* a proposta\n2️⃣ *Propor* outro dia`);
        return res.status(200).json({ ok: true });

      } else if (campo === 'contraproposta_prazo') {
        const contraData = parsePrazo(texto);
        if (!contraData) {
          await sendTelegram(chat_id, `❌ Não entendi a data. Tente: *25/05* ou *amanhã*`);
          return res.status(200).json({ ok: true });
        }
        const ctxContra = gasto;
        await setContexto(ctxContra.atribuido_chat_id, {
          aguardando: 'resposta_contraproposta',
          gasto_parcial: {
            titulo: ctxContra.titulo,
            tarefa_id: ctxContra.tarefa_id,
            atribuidor_user_id: ctxContra.atribuidor_user_id,
            atribuidor_chat_id: chat_id,
            contraproposta_prazo: contraData
          }
        });
        await limparContexto(chat_id);
        await sendTelegram(ctxContra.atribuido_chat_id,
          `📅 *${nomeRemetente} propõe outro prazo!*\n\n` +
          `📝 ${ctxContra.titulo}\n` +
          `📅 Prazo proposto: *${fmtData(contraData)}*\n\n` +
          `1️⃣ *Aceitar*\n` +
          `2️⃣ *Negar* (cancelar tarefa)`
        );
        await sendTelegram(chat_id, `📤 Contraproposta enviada!`);
        return res.status(200).json({ ok: true });

      } else if (campo === 'resposta_contraproposta') {
        const respCP = texto.toLowerCase().trim();
        const ctxCP = gasto;
        const _matchCP = (words, r) => words.some(p => p.length <= 2 ? r === p : (r === p || r.includes(p)));
        const _aceitarCP = _matchCP(['1','aceitar','aceito','sim','s','ok','pode','beleza','blz','top','show','bora','combinado','fechado'], respCP);
        const _negarCP   = _matchCP(['2','negar','nego','nega','não','nao','n','no','recusar','cancelar','cancela'], respCP);

        if (_aceitarCP) {
          const dadosCP = (await supabaseQuery(`/user_data?user_id=eq.${ctxCP.atribuidor_user_id}&select=data`))?.[0]?.data || {};
          const tarefaCP = (dadosCP[ctxCP.atribuidor_user_id + '_tarefas'] || []).find(t => t.id === ctxCP.tarefa_id);
          if (tarefaCP) {
            tarefaCP.prazo = ctxCP.contraproposta_prazo;
            await supabaseQuery(`/user_data?user_id=eq.${ctxCP.atribuidor_user_id}`, 'PATCH', { data: dadosCP, updated_at: new Date().toISOString() });
          }
          await limparContexto(chat_id);
          await sendTelegram(ctxCP.atribuidor_chat_id,
            `✅ *${nomeRemetente} aceitou o novo prazo!*\n\n📝 ${ctxCP.titulo}\n📅 Prazo: *${fmtData(ctxCP.contraproposta_prazo)}*`
          );
          await sendTelegram(chat_id, `✅ Prazo aceito! Tarefa atualizada para *${fmtData(ctxCP.contraproposta_prazo)}*.`);
          return res.status(200).json({ ok: true });
        }

        if (_negarCP) {
          const dadosNCP = (await supabaseQuery(`/user_data?user_id=eq.${ctxCP.atribuidor_user_id}&select=data`))?.[0]?.data || {};
          dadosNCP[ctxCP.atribuidor_user_id + '_tarefas'] = (dadosNCP[ctxCP.atribuidor_user_id + '_tarefas'] || []).filter(t => t.id !== ctxCP.tarefa_id);
          await supabaseQuery(`/user_data?user_id=eq.${ctxCP.atribuidor_user_id}`, 'PATCH', { data: dadosNCP, updated_at: new Date().toISOString() });
          await limparContexto(chat_id);
          await sendTelegram(ctxCP.atribuidor_chat_id,
            `❌ *${nomeRemetente} negou a contraproposta.*\n\n📝 ${ctxCP.titulo}\n_Tarefa removida._`
          );
          await sendTelegram(chat_id, `❌ Tarefa cancelada.`);
          return res.status(200).json({ ok: true });
        }

        await sendTelegram(chat_id, `Não entendi. Responda:\n1️⃣ *Aceitar*\n2️⃣ *Negar*`);
        return res.status(200).json({ ok: true });

      } else if (campo === 'descricao_receita') {
        // Valida que a descrição não é genérica
        const _descGen2 = ['recebimento','pagamento','transferencia','transferência','deposito','depósito','entrada','dinheiro','valor','receita','renda','pix','ted','doc'];
        if (!texto.trim() || _descGen2.includes(texto.toLowerCase().trim()) || texto.trim().length < 3) {
          await sendTelegram(chat_id, `📝 Descrição muito vaga\\. Seja mais específico:\nEx: *Salário maio*, *Freelance logo cliente*, *Aluguel apartamento João*`);
          return res.status(200).json({ ok: true });
        }
        gasto.descricao = texto.trim();
        gasto.tipo = 'receita';
        // Pergunta se é fixa ou variável
        await setContexto(chat_id, { aguardando: 'receita_tipo', gasto_parcial: { ...gasto } });
        await sendTelegram(chat_id,
          `💰 *${escapeMd(gasto.descricao)}* — ${parseFloat(gasto.valor).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}\n\n` +
          `♾ *É uma receita fixa ou variável?*\n\n` +
          `1️⃣ *Fixa* — se repete todo mês \\(salário, aluguel, pensão\\.\\.\\.\\)\n` +
          `2️⃣ *Variável* — só desta vez \\(freela pontual, venda, bônus\\.\\.\\.\\)`
        );
        return res.status(200).json({ ok: true });

      } else if (campo === 'receita_tipo') {
        const t = texto.toLowerCase().trim();
        const isFix = /^(1|fix|fixa|todo mes|todo mês|mensal|sempre|recorrente|recorr|regular)/.test(t);
        const isVar = /^(2|var|variav|variável|pontual|so essa|só essa|uma vez|esporadic|eventual)/.test(t);
        if (!isFix && !isVar) {
          await sendTelegram(chat_id, `Responda:\n1️⃣ *Fixa* \\(todo mês\\)\n2️⃣ *Variável* \\(só desta vez\\)`);
          return res.status(200).json({ ok: true });
        }
        if (isFix) {
          await setContexto(chat_id, { aguardando: 'receita_dia', gasto_parcial: { ...gasto, receita_tipo: 'fixa' } });
          await sendTelegram(chat_id,
            `📅 *Qual o dia do mês que costuma receber?*\n\nEx: dia 5, dia 15, último dia...\n_(Se variar, informe o dia mais comum)_`
          );
        } else {
          await _salvarReceitaTelegram({ gasto, user_id, chat_id, tipo_midia, mensagem_original, nomeRemetente, receita_tipo: 'variavel', dia: null, res });
        }
        return res.status(200).json({ ok: true });

      } else if (campo === 'receita_dia') {
        let dia = 5;
        const t = texto.toLowerCase().replace(/[^\d]/g,'');
        if (t) dia = Math.min(31, Math.max(1, parseInt(t)));
        else if (/[uú]ltimo|fim/i.test(texto)) dia = 31;
        await _salvarReceitaTelegram({ gasto: { ...gasto, receita_tipo: 'fixa' }, user_id, chat_id, tipo_midia, mensagem_original, nomeRemetente, receita_tipo: 'fixa', dia, res });
        return res.status(200).json({ ok: true });

      } else if (campo === 'prazo_tarefa_atribuida') {
        const prazoA = parsePrazo(texto);
        console.log('Prazo calculado:', prazoA, 'Texto recebido:', texto);
        gasto.prazo = prazoA;  // atualiza o gasto_parcial com o prazo recém calculado
        gasto.pedir_prazo = false;
        // Cria a tarefa com atribuição usando prazoA (não gasto_parcial original)
        const tarefasAtrib = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dadosAtrib = tarefasAtrib?.[0]?.data || {};
        const listaAtrib = dadosAtrib[user_id + '_tarefas'] || [];
        let novaAtrib = {
          id: Date.now(),
          titulo: gasto.titulo,
          prazo: prazoA,  // usa prazoA diretamente, não gasto.prazo que pode ser null do parcial
          prio: gasto.prioridade || 'Media',
          concluida: false,
          origem: 'telegram',
          origem_nome: nomeRemetente,
          atribuidor_chat_id: chat_id,
          atribuidor_nome: nomeRemetente,
          atribuido_para: gasto.atribuir_para
        };
        listaAtrib.push(novaAtrib);
        dadosAtrib[user_id + '_tarefas'] = listaAtrib;
        await fetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${user_id}`,{method:'PATCH',headers:{'Content-Type':'application/json','apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Prefer':'return=minimal'},body:JSON.stringify({data:dadosAtrib,updated_at:new Date().toISOString()})});
        await limparContexto(chat_id);
        const nomeAtribCtx = gasto.atribuir_para.toLowerCase().trim();
        const todosVinculosCtx = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&select=chat_id,nome`);
        const vinculoAtribCtx = (todosVinculosCtx || []).find(v => v.nome && v.nome.toLowerCase().includes(nomeAtribCtx));
        if (vinculoAtribCtx && vinculoAtribCtx.chat_id !== chat_id) {
          await sendTelegram(vinculoAtribCtx.chat_id,
            `📋 *${nomeRemetente} atribuiu uma tarefa para você!*\n\n` +
            `📝 ${gasto.titulo}\n` +
            `📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo'}\n` +
            `🎯 Prioridade: ${gasto.prioridade || 'Média'}\n\n` +
            `Responda:\n1️⃣ *Aceitar*\n2️⃣ *Reagendar*\n3️⃣ *Negar*`
          );
          await setContexto(vinculoAtribCtx.chat_id, {
            aguardando: 'resposta_tarefa',
            gasto_parcial: {
              titulo: gasto.titulo,
              prazo: gasto.prazo,
              prioridade: gasto.prioridade,
              atribuidor_chat_id: chat_id,
              atribuidor_nome: nomeRemetente,
              atribuidor_user_id: user_id,
              tarefa_id: novaAtrib.id
            }
          });
        }
        await sendTelegram(chat_id,
          `✅ *Tarefa criada e atribuída para ${gasto.atribuir_para}!*\n\n` +
          `📝 ${gasto.titulo}\n` +
          `📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo'}\n\n` +
          `_Aguardando resposta de ${gasto.atribuir_para}._`
        );
        return res.status(200).json({ ok: true });

      } else if (campo === 'prazo_tarefa') {
        const prazo = parsePrazo(texto);
        gasto.prazo = prazo;
        gasto.pedir_prazo = false;
        const tarefasD = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dadosD = tarefasD?.[0]?.data || {};
        const listaD = dadosD[user_id + '_tarefas'] || [];
        listaD.push({id:Date.now(),titulo:gasto.titulo,prazo:gasto.prazo||null,prio:gasto.prioridade||'Media',concluida:false,origem:'telegram',origem_nome:nomeRemetente});
        dadosD[user_id + '_tarefas'] = listaD;
        await fetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${user_id}`,{method:'PATCH',headers:{'Content-Type':'application/json','apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Prefer':'return=minimal'},body:JSON.stringify({data:dadosD,updated_at:new Date().toISOString()})});
        await limparContexto(chat_id);
        const prazoTxt = gasto.prazo ? ` · 📅 ${new Date(gasto.prazo+'T12:00:00').toLocaleDateString('pt-BR')}` : '';
        await sendTelegram(chat_id, `✅ *Tarefa criada!*\n\n📋 ${gasto.titulo}${prazoTxt}\n🎯 Prioridade: ${gasto.prioridade||'Média'}`);
        const _outrosPT = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
        for (const o of (_outrosPT||[])) {
          await sendTelegram(o.chat_id, `📋 *${nomeRemetente} criou uma tarefa!*\n\n📝 ${gasto.titulo}\n📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo'}\n🎯 Prioridade: ${gasto.prioridade||'Média'}`);
        }
        return res.status(200).json({ ok: true });

      } else if (campo === 'descricao') {
        // Se usuário mandou um número (ex: "60"), é o valor — atualiza e repergunta descrição
        const _numDescricao = parseFloat(texto.trim().replace(',','.').replace(/[^\d.]/g,''));
        if (!isNaN(_numDescricao) && _numDescricao > 0 && /^[\d.,\sR$]+$/.test(texto.trim())) {
          gasto.valor = _numDescricao;
          await setContexto(chat_id, { aguardando: 'descricao', gasto_parcial: gasto });
          const _vDesc = _numDescricao.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
          await sendTelegram(chat_id, `📝 O que foi essa compra de ${_vDesc}?\n\nEx: iFood, mercado, farmácia, uber...`);
          return res.status(200).json({ ok: true });
        }
        // Valida que a descrição de despesa não é genérica
        const _descGastoGen = ['gasto','compra','pagamento','despesa','transferencia','transferência','coisa','algo','item','produto','serviço','servico'];
        if (!texto.trim() || _descGastoGen.includes(texto.toLowerCase().trim()) || texto.trim().length < 3) {
          await sendTelegram(chat_id, `📝 O que foi essa compra? Seja mais específico:\n\nEx: iFood, mercado, farmácia, uber...`);
          return res.status(200).json({ ok: true });
        }
        gasto.descricao = texto.trim();
        gasto.tipo = 'lancamento';
        // Continua para verificar campos restantes abaixo
      } else if (campo === 'modalidade') {
        const _normMod = normalizeModalidade(texto);
        const _validMods = ['PIX', 'Crédito', 'Débito', 'Dinheiro', 'Crédito Parcelado'];
        if (!_validMods.includes(_normMod)) {
          await sendTelegram(chat_id, `Não entendi. Escolha uma das opções:\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro\n5️⃣ Crédito Parcelado`);
          return res.status(200).json({ ok: true });
        }
        // "Crédito Parcelado" = Crédito mas já sabe que vai parcelar
        const _jaParcelado = _normMod === 'Crédito Parcelado';
        gasto.modalidade = _jaParcelado ? 'Crédito' : _normMod;
        if (_jaParcelado) gasto.ja_parcelado = true;
        if (gasto.tipo !== 'multiplos') gasto.tipo = 'lancamento';
        const modLow = gasto.modalidade.toLowerCase();
        const isPix = modLow.includes('pix');
        const isDinheiro = modLow.includes('dinheiro') || modLow.includes('especie') || modLow.includes('espécie');

        if (isPix || isDinheiro) {
          gasto.cartao = gasto.modalidade;
          if (gasto.tipo === 'multiplos') {
            await setContexto(chat_id, { aguardando: 'mercado_multiplos', gasto_parcial: gasto });
            await sendTelegram(chat_id, `🛒 Essa compra foi no mercado/supermercado?\n\n1️⃣ Compra do mês\n2️⃣ Compra variável (semana)\n3️⃣ Não é mercado`);
            return res.status(200).json({ ok: true });
          }
          await limparContexto(chat_id);
          await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, nomeRemetente);
          const valorCtx1 = (parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
          const msgCtx1 = `✅ *Lançamento registrado!*\n\n📝 ${gasto.descricao||'(sem descrição)'}\n💰 ${valorCtx1}\n🏷 ${gasto.categoria||'Outros'}\n${iconeModalidade(gasto.modalidade)} ${gasto.modalidade||'Não informado'}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n⏳ Aguardando sua autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`;
          await sendTelegram(chat_id, msgCtx1);
          const outrosCtx1 = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
          for (const o of (outrosCtx1||[])) { await sendTelegram(o.chat_id, `📱 *${escapeMd(nomeRemetente)} registrou um gasto pendente*\n\n📝 ${escapeMd(gasto.descricao||'(sem descrição)')}\n💰 ${valorCtx1}\n🏷 ${escapeMd(gasto.categoria||'Outros')}\n${iconeModalidade(gasto.modalidade)} ${escapeMd(gasto.modalidade||'Não informado')}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n_Acesse o BY Finance para autorizar\\._`); }
        } else {
          // Crédito/Débito → precisa do cartão/banco
          await setContexto(chat_id, { aguardando: 'cartao', gasto_parcial: gasto });
          await sendTelegram(chat_id, `💳 Qual cartão ou banco?\n\nEx: Nubank, Inter, Itaú, Bradesco...`);
        }
        return res.status(200).json({ ok: true });

      } else if (campo === 'cartao') {
        gasto.cartao = fmtCartao(texto.trim());
        if (gasto.tipo !== 'multiplos') gasto.tipo = 'lancamento';
        if (gasto.tipo === 'multiplos') {
          await setContexto(chat_id, { aguardando: 'mercado_multiplos', gasto_parcial: gasto });
          await sendTelegram(chat_id, `🛒 Essa compra foi no mercado/supermercado?\n\n1️⃣ Compra do mês\n2️⃣ Compra variável (semana)\n3️⃣ Não é mercado`);
          return res.status(200).json({ ok: true });
        } else {
          const _isCredCartao = (gasto.modalidade || '').toLowerCase().includes('cred');
          if (_isCredCartao && !gasto.parcelas) {
            if (gasto.ja_parcelado) {
              // Opção 5 (Crédito Parcelado): vai direto para número de parcelas
              await setContexto(chat_id, { aguardando: 'num_parcelas', gasto_parcial: gasto });
              await sendTelegram(chat_id, `🔢 Em quantas parcelas?\n\nEx: 2, 3, 6, 12`);
            } else {
              await setContexto(chat_id, { aguardando: 'parcelamento', gasto_parcial: gasto });
              await sendTelegram(chat_id, `💳 Foi à vista ou parcelado?\n\n1️⃣ À vista\n2️⃣ Parcelado`);
            }
            return res.status(200).json({ ok: true });
          }
          await limparContexto(chat_id);
          await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, nomeRemetente);
          const valorCtx2 = (parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
          const _parcelaCtx2 = gasto.parcelas && gasto.parcelas > 1 ? `\n🔄 ${gasto.parcelas}x de ${parseFloat(gasto.valor_parcela||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}` : '';
          const msgCtx2 = `✅ *Lançamento registrado!*\n\n📝 ${gasto.descricao||'(sem descrição)'}\n💰 ${valorCtx2}${_parcelaCtx2}\n🏷 ${gasto.categoria||'Outros'}\n💳 ${fmtCartao(gasto.cartao)}\n${iconeModalidade(gasto.modalidade)} ${gasto.modalidade||gasto.cartao||'Não informado'}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n⏳ Aguardando sua autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`;
          await sendTelegram(chat_id, msgCtx2);
          const outrosCtx2 = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
          for (const o of (outrosCtx2||[])) { await sendTelegram(o.chat_id, `📱 *${escapeMd(nomeRemetente)} registrou um gasto pendente*\n\n📝 ${escapeMd(gasto.descricao||'(sem descrição)')}\n💰 ${valorCtx2}${_parcelaCtx2}\n🏷 ${escapeMd(gasto.categoria||'Outros')}\n💳 ${escapeMd(fmtCartao(gasto.cartao||'Não informado'))}\n${iconeModalidade(gasto.modalidade)} ${escapeMd(gasto.modalidade||'Não informado')}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n_Acesse o BY Finance para autorizar\\._`); }
        }
        return res.status(200).json({ ok: true });

      } else if (campo === 'mercado_multiplos') {
        const _tMkt = texto.trim().toLowerCase();
        const _isMes = _tMkt === '1'
          || /^(compra\s*do\s*m[eê]s|m[eê]s|mensal|lista|lista\s*do\s*m[eê]s|b[aá]sico|b[aá]sicos|compra\s*grande|grande|fixo|fixos|essencial|essenciais)$/i.test(_tMkt);
        const _isVariavel = _tMkt === '2'
          || /^(vari[aá]vel|vari[aá]veis|semana|semanal|semanais|extra|extras|avulso|avulsa|avulsos|r[aá]pida|r[aá]pido|pontual|pontuais|eventual|eventuais)$/i.test(_tMkt);
        const _isNao = _tMkt === '3'
          || /^(n[aã]o|nao|n|negar|outro|outros|nenhum|nenhuma|cancel|cancelar|nope|no|negativo)$/i.test(_tMkt);
        if (!_isMes && !_isVariavel && !_isNao) {
          await sendTelegram(chat_id, `Não entendi 🤔\n\nResponda:\n1️⃣ Compra do mês\n2️⃣ Compra variável (semana)\n3️⃣ Não é mercado`);
          return res.status(200).json({ ok: true });
        }
        const _lansM = gasto.lancamentos || [];
        _lansM.forEach(l => {
          l.modalidade = gasto.modalidade;
          l.cartao = gasto.cartao;
          if (_isMes) { l.mktTipo = 'mes'; if (!l.categoria) l.categoria = 'Mercado'; }
          else if (_isVariavel) { l.mktTipo = 'variavel'; if (!l.categoria) l.categoria = 'Mercado'; }
          else { l.mktTipo = null; if (!l.categoria) l.categoria = 'Outros'; }
          if (!l.data_lancamento) l.data_lancamento = new Date().toISOString().split('T')[0];
        });
        await limparContexto(chat_id);
        for (const l of _lansM) await salvarPendente(chat_id, user_id, l, tipo_midia, mensagem_original, nomeRemetente);
        const _listaMkt = _lansM.map(l=>`• ${l.descricao} — ${parseFloat(l.valor||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}`).join('\n');
        const _cartaoMktStr = gasto.cartao && gasto.cartao !== gasto.modalidade ? `💳 ${fmtCartao(gasto.cartao)}\n` : '';
        await sendTelegram(chat_id, `✅ *${_lansM.length} lançamentos registrados!*\n\n${_listaMkt}\n\n${_cartaoMktStr}${iconeModalidade(gasto.modalidade)} ${gasto.modalidade}\n\n⏳ Aguardando autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`);
        const _outrosMkt = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
        for (const o of (_outrosMkt||[])) { await sendTelegram(o.chat_id, `📱 *${escapeMd(nomeRemetente)} registrou ${_lansM.length} gastos pendentes*\n\n${_listaMkt}\n\n${_cartaoMktStr ? escapeMd(_cartaoMktStr) : ''}${iconeModalidade(gasto.modalidade)} ${escapeMd(gasto.modalidade)}\n📅 ${fmtData(_lansM[0]?.data_lancamento||new Date().toISOString().split('T')[0])}\n\n_Acesse o BY Finance para autorizar\\._`); }
        return res.status(200).json({ ok: true });

      } else if (campo === 'parcelamento') {
        const _tP = texto.toLowerCase().trim();
        const _mParc = _tP.match(/^(\d+)\s*x?$/);
        if (_mParc && parseInt(_mParc[1]) > 1) {
          // Usuário digitou número de parcelas direto (ex: "12" ou "12x")
          const np = parseInt(_mParc[1]);
          gasto.parcelas = np;
          gasto.valor_parcela = parseFloat((parseFloat(gasto.valor||0) / np).toFixed(2));
          gasto.observacao = `Parcelado em ${np}x`;
          await limparContexto(chat_id);
          await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, nomeRemetente);
          const _vP = (parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
          const _vpP = parseFloat(gasto.valor_parcela).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
          await sendTelegram(chat_id, `✅ *Lançamento registrado!*\n\n📝 ${gasto.descricao||'(sem descrição)'}\n💰 ${_vP}\n🔄 ${np}x de ${_vpP}\n🏷 ${gasto.categoria||'Outros'}\n💳 ${fmtCartao(gasto.cartao||'Não informado')}\n${iconeModalidade(gasto.modalidade)} ${gasto.modalidade}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n⏳ Aguardando sua autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`);
          const _outrosP = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
          for (const o of (_outrosP||[])) { await sendTelegram(o.chat_id, `📱 *${escapeMd(nomeRemetente)} registrou um gasto parcelado*\n\n📝 ${escapeMd(gasto.descricao||'(sem descrição)')}\n💰 ${_vP}\n🔄 ${np}x de ${_vpP}\n💳 ${escapeMd(fmtCartao(gasto.cartao||'Não informado'))}\n\n_Acesse o BY Finance para autorizar\\._`); }
          return res.status(200).json({ ok: true });
        }
        const _isVista = ['1','vista','à vista','a vista','avista','não','nao','inteiro','integral'].some(p => _tP === p || _tP.startsWith(p+' '));
        const _isParcPerg = ['2','parcelado','parcelada','sim','parcela','parcelas'].some(p => _tP === p || _tP.startsWith(p+' '));
        if (_isVista) {
          gasto.parcelas = null; gasto.valor_parcela = null;
          await limparContexto(chat_id);
          await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, nomeRemetente);
          const _vV = (parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
          await sendTelegram(chat_id, `✅ *Lançamento registrado!*\n\n📝 ${gasto.descricao||'(sem descrição)'}\n💰 ${_vV}\n🏷 ${gasto.categoria||'Outros'}\n💳 ${fmtCartao(gasto.cartao||'Não informado')}\n${iconeModalidade(gasto.modalidade)} ${gasto.modalidade}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n⏳ Aguardando sua autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`);
          const _outrosV = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
          for (const o of (_outrosV||[])) { await sendTelegram(o.chat_id, `📱 *${escapeMd(nomeRemetente)} registrou um gasto pendente*\n\n📝 ${escapeMd(gasto.descricao||'(sem descrição)')}\n💰 ${_vV}\n💳 ${escapeMd(fmtCartao(gasto.cartao||'Não informado'))}\n${iconeModalidade(gasto.modalidade)} ${escapeMd(gasto.modalidade)}\n\n_Acesse o BY Finance para autorizar\\._`); }
          return res.status(200).json({ ok: true });
        }
        if (_isParcPerg) {
          await setContexto(chat_id, { aguardando: 'num_parcelas', gasto_parcial: gasto });
          await sendTelegram(chat_id, `🔢 Em quantas parcelas?\n\nEx: 2, 3, 6, 12`);
          return res.status(200).json({ ok: true });
        }
        await sendTelegram(chat_id, `Não entendi. Responda:\n1️⃣ *À vista*\n2️⃣ *Parcelado*`);
        return res.status(200).json({ ok: true });

      } else if (campo === 'num_parcelas') {
        const _mNP = texto.trim().match(/(\d+)/);
        if (!_mNP || parseInt(_mNP[1]) < 2) {
          await sendTelegram(chat_id, `❓ Número inválido. Digite quantas parcelas:\n\nEx: 2, 3, 6, 12`);
          return res.status(200).json({ ok: true });
        }
        const _np = parseInt(_mNP[1]);
        gasto.parcelas = _np;
        gasto.valor_parcela = parseFloat((parseFloat(gasto.valor||0) / _np).toFixed(2));
        gasto.observacao = (gasto.observacao ? gasto.observacao + ' · ' : '') + `Parcelado em ${_np}x`;
        await limparContexto(chat_id);
        await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, nomeRemetente);
        const _vNP = (parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
        const _vpNP = parseFloat(gasto.valor_parcela).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
        await sendTelegram(chat_id, `✅ *Lançamento registrado!*\n\n📝 ${gasto.descricao||'(sem descrição)'}\n💰 ${_vNP}\n🔄 ${_np}x de ${_vpNP}\n🏷 ${gasto.categoria||'Outros'}\n💳 ${fmtCartao(gasto.cartao||'Não informado')}\n${iconeModalidade(gasto.modalidade)} ${gasto.modalidade}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n⏳ Aguardando sua autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`);
        const _outrosNP = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
        for (const o of (_outrosNP||[])) { await sendTelegram(o.chat_id, `📱 *${escapeMd(nomeRemetente)} registrou um gasto parcelado*\n\n📝 ${escapeMd(gasto.descricao||'(sem descrição)')}\n💰 ${_vNP}\n🔄 ${_np}x de ${_vpNP}\n💳 ${escapeMd(fmtCartao(gasto.cartao||'Não informado'))}\n\n_Acesse o BY Finance para autorizar\\._`); }
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
          `${iconeModalidade('')} Como foi o pagamento?\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro`
        );
        return res.status(200).json({ ok: true });
      }
    }

    // Pré-processamento: comandos diretos não precisam do Gemini
    const _preCmd = (!audioUrl && !fotoUrl) ? preProcessarComando(texto) : null;
    const gasto = _preCmd || await interpretarComGemini({ texto, audioUrl, fotoUrl, mimeType });
    if (_preCmd) console.log('Pré-processado:', JSON.stringify(_preCmd));

    if (gasto.tipo === 'erro' || gasto.erro) {
      // Se era foto/PDF, tenta salvar como parcial pedindo o valor
      if (tipo_midia === 'foto' || tipo_midia === 'pdf') {
        await setContexto(chat_id, {
          aguardando: 'descricao_foto',
          gasto_parcial: { tipo: 'lancamento', valor: 0, data_lancamento: new Date().toISOString().split('T')[0] }
        });
        await sendTelegram(chat_id,
          `📸 Recebi a imagem mas não consegui ler os dados com clareza.\n\n` +
          `Me diga:\n*Qual o valor?* (ex: 11 ou 11,00)\n*O que foi?* (ex: Mercado Pago, lanche, farmácia...)`
        );
      } else {
        await sendTelegram(chat_id,
          `❌ Não consegui identificar um gasto.\n\n` +
          `Tente assim: _"gastei 47 reais no iFood cartão Nubank"_`
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (gasto.tipo === 'lancamento_parcial') {
      const campo = gasto.campo_faltando;
      if (campo === 'descricao') {
        await setContexto(chat_id, { aguardando: 'descricao', gasto_parcial: gasto });
        await sendTelegram(chat_id, `📝 O que foi essa compra? Seja mais específico:\n\nEx: iFood, mercado, farmácia, uber...`);
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
        const faturas = userData?.[0]?.data?.[user_id + '_faturas'] || {};
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

      if (gasto.pergunta === 'resumo') {
        await sendTelegram(chat_id, `⏳ Buscando seu resumo...`);
        const cronUrl = `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/cron-alertas`;
        try {
          await fetch(cronUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id, user_id })
          });
        } catch(_e) {
          // fallback inline se o fetch interno falhar
          const _ud = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
          const _d  = _ud?.[0]?.data || {};
          const _mesIdx = new Date().getMonth();
          const _fat  = _d[user_id + '_faturas'] || {};
          const _gf   = _d[user_id + '_gastosFixos'] || [];
          const _rf   = _d[user_id + '_receitasFixas'] || [];
          const _tFat = Object.values(_fat).reduce((a, arr) => a + (arr[_mesIdx] || 0), 0);
          const _tGf  = _gf.reduce((a, g) => a + (g.val || 0), 0);
          const _tRf  = _rf.reduce((a, r) => a + (r.val || 0), 0);
          const _res  = _tRf - _tFat - _tGf;
          const _pend = await supabaseQuery(`/telegram_pendentes?user_id=eq.${user_id}&status=eq.pendente&select=id,descricao,valor`);
          const _tar  = (_d[user_id + '_tarefas'] || []).filter(t => !t.concluida);
          const _mNm  = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][_mesIdx];
          let _msg = `📊 *RESUMO — ${_mNm.toUpperCase()}*\n\n`;
          _msg += _res >= 0 ? `▲ *SUPERÁVIT: ${(_res).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}* ✅\n` : `▼ *DÉFICIT: ${Math.abs(_res).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}* ⚠️\n`;
          _msg += `💰 Receitas: ${_tRf.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})} · 💳 Faturas: ${_tFat.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})} · 📋 Fixos: ${_tGf.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}\n\n`;
          if (_pend.length) _msg += `🔔 *${_pend.length} gasto${_pend.length>1?'s':''} pendente${_pend.length>1?'s':''}* aguardando autorização\n\n`;
          if (_tar.length) _msg += `📋 *${_tar.length} tarefa${_tar.length>1?'s':''} pendente${_tar.length>1?'s':''}*\n`;
          await sendTelegram(chat_id, _msg + `\n━━━━━━━━━━━━━━\n_BY Persona Finance_`);
        }
        return res.status(200).json({ ok: true });
      }

      if (gasto.pergunta === 'gastos_mes') {
        const _ud = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const _d = _ud?.[0]?.data || {};
        const _mi = new Date().getMonth();
        const _mNm = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][_mi];
        const _fat = _d[user_id + '_faturas'] || {};
        const _gf  = _d[user_id + '_gastosFixos'] || [];
        const _totalFat = Object.values(_fat).reduce((a,arr) => a + (arr[_mi]||0), 0);
        const _totalGf  = _gf.reduce((a,g) => a + (g.val||0), 0);
        const _total = _totalFat + _totalGf;
        const _pend = await supabaseQuery(`/telegram_pendentes?user_id=eq.${user_id}&status=eq.pendente&select=id,descricao,valor`);
        const _totalPend = (_pend||[]).reduce((a,p) => a + parseFloat(p.valor||0), 0);
        let _msg = `💸 *Gastos de ${_mNm}:*\n\n`;
        _msg += `💳 Faturas: *${_totalFat.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}*\n`;
        _msg += `📋 Fixos: *${_totalGf.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}*\n`;
        _msg += `━━━━━━━━━━━━━━\n`;
        _msg += `💰 *Total: ${_total.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}*\n`;
        if (_pend.length > 0) _msg += `\n🔔 ${_pend.length} lançamento(s) pendente(s): *${_totalPend.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}* aguardando autorização`;
        await sendTelegram(chat_id, _msg);
        return res.status(200).json({ ok: true });
      }

      if (gasto.pergunta === 'gastos_hoje') {
        const _hoje = new Date().toISOString().split('T')[0];
        const _pend = await supabaseQuery(`/telegram_pendentes?user_id=eq.${user_id}&status=eq.pendente&data_lancamento=eq.${_hoje}&select=descricao,valor,categoria`);
        if (!_pend || !_pend.length) {
          await sendTelegram(chat_id, `✅ Nenhum gasto registrado hoje.`);
        } else {
          const _total = _pend.reduce((a,p) => a + parseFloat(p.valor||0), 0);
          const _lista = _pend.map(p => `• ${p.descricao||'(sem desc)'} — ${parseFloat(p.valor||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}`).join('\n');
          await sendTelegram(chat_id, `💸 *Gastos de hoje:*\n\n${_lista}\n\n*Total: ${_total.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}*\n_Aguardando autorização no app_`);
        }
        return res.status(200).json({ ok: true });
      }

      if (gasto.pergunta === 'saldo') {
        const _ud = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const _d = _ud?.[0]?.data || {};
        const _mi = new Date().getMonth();
        const _mNm = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][_mi];
        const _fat = _d[user_id + '_faturas'] || {};
        const _gf  = _d[user_id + '_gastosFixos'] || [];
        const _rf  = _d[user_id + '_receitasFixas'] || [];
        const _tFat = Object.values(_fat).reduce((a,arr) => a + (arr[_mi]||0), 0);
        const _tGf  = _gf.reduce((a,g) => a + (g.val||0), 0);
        const _tRf  = _rf.reduce((a,r) => a + (r.val||0), 0);
        const _res  = _tRf - _tFat - _tGf;
        const _icon = _res >= 0 ? '▲' : '▼';
        const _label = _res >= 0 ? 'SUPERÁVIT' : 'DÉFICIT';
        await sendTelegram(chat_id,
          `📊 *Situação — ${_mNm}:*\n\n` +
          `💰 Receitas: *${_tRf.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}*\n` +
          `💳 Faturas: *-${_tFat.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}*\n` +
          `📋 Fixos: *-${_tGf.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}*\n` +
          `━━━━━━━━━━━━━━\n` +
          `${_icon} *${_label}: ${Math.abs(_res).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}*`
        );
        return res.status(200).json({ ok: true });
      }

      await sendTelegram(chat_id, `📊 Consulta não reconhecida. Tente: _faturas_, _gastos_, _saldo_, _resumo_`);
      return res.status(200).json({ ok: true });
    }

    if (gasto.tipo === 'tarefa') {
      if (gasto.acao === 'listar') {
        const tarefas = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dados = tarefas?.[0]?.data || {};
        const lista = (dados[user_id + '_tarefas'] || []).filter(t => !t.concluida).slice(0, 8);
        if (!lista.length) {
          await sendTelegram(chat_id, `✅ Nenhuma tarefa pendente!`);
        } else {
          const txt = lista.map(t => {
            const prazo = t.prazo ? ` · 📅 ${new Date(t.prazo+'T12:00:00').toLocaleDateString('pt-BR')}` : '';
            const prio = t.prio === 'Alta' ? ' 🔴' : t.prio === 'Media' ? ' 🟡' : ' 🟢';
            return `• ${t.titulo}${prio}${prazo}`;
          }).join('\n');
          await sendTelegram(chat_id, `📋 *Tarefas pendentes:*\n\n${txt}`);
        }
        return res.status(200).json({ ok: true });
      }

      if (gasto.acao === 'criar' && gasto.titulo && gasto.pedir_prazo && !gasto.atribuir_para) {
        await setContexto(chat_id, { aguardando: 'prazo_tarefa', gasto_parcial: gasto });
        await sendTelegram(chat_id,
          `📅 Para quando é essa tarefa?\nEx: amanhã, sexta, 25/05, semana que vem`
        );
        return res.status(200).json({ ok: true });
      }

      if (gasto.acao === 'criar' && gasto.titulo) {
        // Ask for prazo BEFORE saving to avoid double-save when prazo_tarefa_atribuida handler runs later
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

        const tarefas = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dados = tarefas?.[0]?.data || {};
        const lista = dados[user_id + '_tarefas'] || [];
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
        dados[user_id + '_tarefas'] = lista;
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

        // Atribuição para pessoa específica
        if (gasto.atribuir_para) {
          const nomeAtrib = gasto.atribuir_para.toLowerCase().trim();
          const todosVinculos = await supabaseQuery(
            `/telegram_vinculos?user_id=eq.${vinculo_user_id}&select=chat_id,nome`
          );
          const vinculoAtrib = (todosVinculos || []).find(v =>
            v.nome && v.nome.toLowerCase().includes(nomeAtrib)
          );
          if (vinculoAtrib && vinculoAtrib.chat_id !== chat_id) {
            await sendTelegram(vinculoAtrib.chat_id,
              `📋 *${nomeRemetente} atribuiu uma tarefa para você!*\n\n` +
              `📝 ${gasto.titulo}\n` +
              `📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo'}\n` +
              `🎯 Prioridade: ${gasto.prioridade || 'Média'}\n\n` +
              `Responda:\n1️⃣ *Aceitar*\n2️⃣ *Reagendar*\n3️⃣ *Negar*`
            );
            await setContexto(vinculoAtrib.chat_id, {
              aguardando: 'resposta_tarefa',
              gasto_parcial: {
                titulo: gasto.titulo,
                prazo: gasto.prazo,
                prioridade: gasto.prioridade,
                atribuidor_chat_id: chat_id,
                atribuidor_nome: nomeRemetente,
                atribuidor_user_id: user_id,
                tarefa_id: nova.id
              }
            });
            await sendTelegram(chat_id,
              `✅ *Tarefa criada e atribuída para ${gasto.atribuir_para}!*\n\n` +
              `📝 ${gasto.titulo}\n` +
              `📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo'}\n\n` +
              `_Aguardando resposta de ${gasto.atribuir_para}._`
            );
          } else if (!vinculoAtrib) {
            await sendTelegram(chat_id,
              `✅ Tarefa criada!\n\n⚠ Não encontrei "${gasto.atribuir_para}" nos números vinculados desta conta.`
            );
          } else {
            // Atribuiu para si mesmo
            await sendTelegram(chat_id, `✅ *Tarefa criada!*\n\n📋 ${gasto.titulo}${prazoTxt}\n🎯 Prioridade: ${gasto.prioridade || 'Média'}`);
          }
          await limparContexto(chat_id);
          return res.status(200).json({ ok: true });
        }

        // Sem atribuição — notifica criação e avisa outros
        await sendTelegram(chat_id, `✅ *Tarefa criada!*\n\n📋 ${gasto.titulo}${prazoTxt}\n🎯 Prioridade: ${gasto.prioridade || 'Média'}`);
        const outrosVinculos = await supabaseQuery(
          `/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`
        );
        for (const outro of (outrosVinculos || [])) {
          await sendTelegram(outro.chat_id,
            `📋 *${nomeRemetente} criou uma tarefa!*\n\n` +
            `📝 ${gasto.titulo}\n` +
            `📅 ${gasto.prazo ? fmtData(gasto.prazo) : 'Sem prazo'}\n` +
            `🎯 Prioridade: ${gasto.prioridade || 'Média'}`
          );
        }
        await limparContexto(chat_id);
        return res.status(200).json({ ok: true });
      }

      if (gasto.acao === 'concluir' && gasto.titulo) {
        const tarefas = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dados = tarefas?.[0]?.data || {};
        const lista = dados[user_id + '_tarefas'] || [];
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
          dados[user_id + '_tarefas'] = lista;
          await supabaseQuery(`/user_data?user_id=eq.${user_id}`, 'PATCH', {
            data: dados,
            updated_at: new Date().toISOString()
          });
          const dadosAtualizados = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
          const tarefasAtualizadas = dadosAtualizados?.[0]?.data?.[user_id + '_tarefas'] || [];
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
            `/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`
          );
          for (const outro of (outrosConcluir || [])) {
            await sendTelegram(outro.chat_id,
              `✅ *${nomeRemetente} concluiu uma tarefa!*\n\n📝 ${lista[idx].titulo || lista[idx].desc}`
            );
          }
        }
        await limparContexto(chat_id);
        return res.status(200).json({ ok: true });
      }
    }

    // Bloqueia lançamento completamente vazio (sem descrição E sem valor real)
    if (gasto.tipo === 'lancamento' && (!gasto.valor || parseFloat(gasto.valor) <= 0) && !gasto.descricao) {
      await sendTelegram(chat_id,
        `❓ Não entendi o que você quis dizer.\n\n` +
        `Se for um *gasto*, me diga: _"gastei 50 no mercado"_\n` +
        `Se for uma *tarefa*, tente: _"conclui a tarefa X"_ ou _"cria tarefa Y"_`
      );
      return res.status(200).json({ ok: true });
    }

    if (gasto.tipo === 'receita') {
      // Descrições genéricas não aceitas — obriga detalhamento
      const _descGenericas = ['recebimento','pagamento','transferencia','transferência','deposito','depósito','pix recebido','pix','ted','doc','entrada','dinheiro','valor','receita','renda','caiu','caiu aqui'];
      const _descReceitaRaw = (gasto.descricao || '').toLowerCase().trim();
      const _descGenerica = !_descReceitaRaw || _descGenericas.includes(_descReceitaRaw) || _descReceitaRaw.length < 3;
      if (_descGenerica) {
        await setContexto(chat_id, { aguardando: 'descricao_receita', gasto_parcial: { ...gasto, tipo: 'receita' } });
        await sendTelegram(chat_id,
          `💰 Receita de *${parseFloat(gasto.valor).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}* identificada\\!\n\n` +
          `📝 *O que foi essa entrada de dinheiro?*\n` +
          `Ex: Salário maio, Freela site, Aluguel apart, Pagamento cliente João, Comissão venda\\.\\.\\.`
        );
        return res.status(200).json({ ok: true });
      }
      if (!gasto.data_lancamento) gasto.data_lancamento = new Date().toISOString().split('T')[0];
      // Pergunta fixa/variável
      await setContexto(chat_id, { aguardando: 'receita_tipo', gasto_parcial: { ...gasto } });
      const _vFmt = parseFloat(gasto.valor).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
      await sendTelegram(chat_id,
        `💰 *${escapeMd(gasto.descricao)}* — ${_vFmt}\n\n` +
        `♾ *É uma receita fixa ou variável?*\n\n` +
        `1️⃣ *Fixa* — se repete todo mês \\(salário, aluguel, pensão\\.\\.\\.\\)\n` +
        `2️⃣ *Variável* — só desta vez \\(freela pontual, venda, bônus\\.\\.\\.\\)`
      );
      return res.status(200).json({ ok: true });
    }

    // ── helper interno para salvar receita após coletar tipo/dia ──
    async function _salvarReceitaTelegram({ gasto, user_id, chat_id, tipo_midia, mensagem_original, nomeRemetente, receita_tipo, dia }) {
      await limparContexto(chat_id);
      const _obs = receita_tipo === 'fixa' ? `[receita_fixa:dia${dia||5}]` : null;
      await supabaseQuery('/telegram_pendentes', 'POST', {
        user_id,
        descricao: gasto.descricao,
        valor: gasto.valor,
        categoria: gasto.categoria || 'Outros',
        cartao: gasto.conta || 'Não informado',
        data_lancamento: gasto.data_lancamento || new Date().toISOString().split('T')[0],
        origem: 'telegram', tipo_midia, mensagem_original, chat_id,
        status: 'pendente', tipo: 'receita', remetente: nomeRemetente,
        observacao: _obs, parcelas: null, valor_parcela: null, modalidade: null
      });
      const valor = parseFloat(gasto.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const tipoLabel = receita_tipo === 'fixa' ? `♾ Fixa \\(dia ${dia||5}\\)` : `≈ Variável`;
      await sendTelegram(chat_id,
        `✅ *Receita registrada\\!*\n\n` +
        `📝 ${escapeMd(gasto.descricao)}\n` +
        `💰 ${valor}\n` +
        `🏷 ${escapeMd(gasto.categoria || 'Outros')}\n` +
        `📋 ${tipoLabel}\n` +
        `📅 ${fmtData(gasto.data_lancamento)}\n\n` +
        `⏳ Aguardando sua autorização no BY Finance\\.`
      );
      const _outros = await supabaseQuery(`/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
      for (const o of (_outros||[])) {
        await sendTelegram(o.chat_id, `💰 *${escapeMd(nomeRemetente)} registrou uma receita*\n\n📝 ${escapeMd(gasto.descricao)}\n💰 ${valor}\n📅 ${fmtData(gasto.data_lancamento)}\n\n_Acesse o BY Finance para autorizar\\._`);
      }
    }

    if (gasto.tipo === 'comando' && gasto.acao === 'listar_pendentes') {
      const _pends = await supabaseQuery(
        `/telegram_pendentes?user_id=eq.${user_id}&status=eq.pendente&order=created_at.desc&select=descricao,valor,categoria,data_lancamento&limit=10`
      );
      if (!_pends || !_pends.length) {
        await sendTelegram(chat_id, `✅ Nenhum lançamento pendente de autorização.`);
      } else {
        const _lista = _pends.map(p =>
          `▸ ${p.descricao||'(sem desc)'} — *${parseFloat(p.valor||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}*`
        ).join('\n');
        await sendTelegram(chat_id,
          `🔔 *${_pends.length} lançamento(s) aguardando autorização:*\n\n${_lista}\n\n_Acesse o BY Finance para autorizar._`
        );
      }
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
      await limparContexto(chat_id);
      return res.status(200).json({ ok: true });
    }

    // Tipos reconhecidos para lançamento — qualquer outro tipo cai no erro abaixo
    if (!['lancamento','multiplos'].includes(gasto.tipo)) {
      await sendTelegram(chat_id, `❓ Não consegui identificar o que você quis dizer.\n\nTente: _"gastei 50 no mercado"_ ou _"cria tarefa X"_`);
      return res.status(200).json({ ok: true });
    }

    const lancamentos = gasto.tipo === 'multiplos' ? gasto.lancamentos : [gasto];

    // ── Para fotos e PDFs: mostra esboço e pede confirmação antes de prosseguir ──
    if ((tipo_midia === 'foto' || tipo_midia === 'pdf') && gasto.tipo === 'lancamento') {
      const vEsb = (parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
      await setContexto(chat_id, { aguardando: 'confirmar_lancamento_foto', gasto_parcial: gasto });
      await sendTelegram(chat_id,
        `📋 *Esboço do lançamento identificado:*\n\n` +
        `📝 ${gasto.descricao || '(sem descrição)'}\n` +
        `💰 ${vEsb}\n` +
        `🏷 ${gasto.categoria || 'Outros'}\n` +
        `💳 ${fmtCartao(gasto.cartao || 'Não informado')}\n` +
        `📅 ${fmtData(gasto.data_lancamento || new Date().toISOString().split('T')[0])}\n\n` +
        `Está correto? Responda *sim* para confirmar ou *não* para editar.`
      );
      return res.status(200).json({ ok: true });
    }

    // Cupom fiscal com múltiplos itens → esboço com lista antes de pedir modalidade
    if ((tipo_midia === 'foto' || tipo_midia === 'pdf') && gasto.tipo === 'multiplos') {
      const _lans = gasto.lancamentos || [];
      const _totalEsb = _lans.reduce((s,l)=>s+parseFloat(l.valor||0),0);
      const _listaEsb = _lans.map(l=>`• ${l.descricao} — ${parseFloat(l.valor||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}`).join('\n');
      await setContexto(chat_id, { aguardando: 'confirmar_lancamento_foto', gasto_parcial: gasto });
      await sendTelegram(chat_id,
        `📋 *${_lans.length} itens identificados no cupom:*\n\n${_listaEsb}\n\n` +
        `💰 Total: *${_totalEsb.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}*\n\n` +
        `Está correto? *sim* para confirmar ou *não* para cancelar.`
      );
      return res.status(200).json({ ok: true });
    }

    // Pós-Gemini: perguntar modalidade PRIMEIRO, depois cartão se necessário
    if (gasto.tipo === 'lancamento' && !gasto.modalidade) {
      await setContexto(chat_id, { aguardando: 'modalidade', gasto_parcial: gasto });
      await sendTelegram(chat_id,
        `Entendi! ${iconeModalidade('')} Como foi o pagamento?\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro`
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

    // B4: Text multiplos without modalidade — ask before saving all items
    if (gasto.tipo === 'multiplos' && !gasto.modalidade) {
      await setContexto(chat_id, { aguardando: 'modalidade', gasto_parcial: gasto });
      await sendTelegram(chat_id,
        `Entendi! ${iconeModalidade('')} Como foi o pagamento?\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro`
      );
      return res.status(200).json({ ok: true });
    }

    // B3: Crédito with full Gemini data but no parcelamento decision yet — ask before saving
    if (gasto.tipo === 'lancamento') {
      const _modB3 = (gasto.modalidade || '').toLowerCase();
      if ((_modB3.includes('créd') || _modB3.includes('cred')) && !gasto.parcelas) {
        await setContexto(chat_id, { aguardando: 'parcelamento', gasto_parcial: gasto });
        await sendTelegram(chat_id, `💳 Foi à vista ou parcelado?\n\n1️⃣ À vista\n2️⃣ Parcelado`);
        return res.status(200).json({ ok: true });
      }
    }

    for (const l of lancamentos) {
      await salvarPendente(chat_id, user_id, l, tipo_midia, mensagem_original, nomeRemetente);
    }

    {
      const valorNum = parseFloat(gasto.valor) || 0;
      const valor = valorNum.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const parcelaInfo = gasto.parcelas ? `\n🔄 ${gasto.parcelas}x de ${parseFloat(gasto.valor_parcela||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}` : '';
      const remetenteInfo = !isPrincipal ? `\n👤 Enviado por: *${nomeRemetente}*` : '';
      const descricao = gasto.descricao || '(sem descrição)';
      const categoria = gasto.categoria || 'Outros';
      const cartaoFmt = fmtCartao(gasto.cartao || 'Não informado');
      const modalidadeFmt = gasto.modalidade || gasto.cartao || 'Não informado';
      const dataFmt = fmtData(gasto.data_lancamento || new Date().toISOString().split('T')[0]);
      const msgConfirm =
        `✅ *Lançamento registrado!*\n\n` +
        `📝 ${descricao}\n` +
        `💰 ${valor}${parcelaInfo}\n` +
        `🏷 ${categoria}\n` +
        `💳 ${cartaoFmt}\n` +
        `${iconeModalidade(modalidadeFmt)} ${modalidadeFmt}\n` +
        `📅 ${dataFmt}${remetenteInfo}\n\n` +
        `⏳ Aguardando sua autorização no BY Finance.\n` +
        `Você tem *7 dias* para aprovar ou rejeitar.`;
      await sendTelegram(chat_id, msgConfirm);
      // Notifica outros vínculos da conta sobre o novo pendente
      const outrosNotif = await supabaseQuery(
        `/telegram_vinculos?user_id=eq.${vinculo_user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`
      );
      for (const outro of (outrosNotif || [])) {
        await sendTelegram(outro.chat_id,
          `📱 *${escapeMd(nomeRemetente)} registrou um gasto pendente*\n\n` +
          `📝 ${escapeMd(descricao)}\n` +
          `💰 ${valor}\n` +
          `🏷 ${escapeMd(categoria)}\n` +
          `💳 ${escapeMd(cartaoFmt)}\n` +
          `${iconeModalidade(modalidadeFmt)} ${escapeMd(modalidadeFmt)}\n` +
          `📅 ${dataFmt}\n\n` +
          `_Acesse o BY Finance para autorizar\\._`
        );
      }
    }

  } catch (err) {
    console.error('Erro no webhook:', err);
    await sendTelegram(chat_id, '❌ Erro interno. Tente novamente.');
  }

  return res.status(200).json({ ok: true });
}