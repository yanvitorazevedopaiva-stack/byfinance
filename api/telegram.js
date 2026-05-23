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
  if (t === '2' || t.includes('créd') || t.includes('cred')) return 'Crédito';
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
    observacao: gasto.mktTipo === 'variavel' ? ('[mkt:variavel]'+(gasto.observacao?' '+gasto.observacao:'')) : (gasto.observacao||null),
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
    // sempre retorna array; se vier objeto de erro do Supabase, retorna []
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

GATILHOS DE RECEITA — qualquer uma dessas expressões indica uma entrada de dinheiro:
"recebi", "recebi X", "recebi de", "recebi do", "recebi da"
"entrou", "entrou X", "entrou na conta", "entrou no banco", "caiu", "caiu na conta", "caiu X"
"pintou X", "pintou uma grana", "chegou o pagamento", "chegou X"
"me pagaram", "me transferiram", "mandaram X", "depositaram"
"depósito", "deposito", "ted recebido", "pix recebido", "transferência recebida"
"salário", "salario", "vale", "adiantamento", "13º", "décimo terceiro"
"freelance", "freela", "bico", "trabalho extra", "trampo extra"
"aluguel recebido", "recebi aluguel", "inquilino pagou"
"rendimento", "dividendo", "juros recebido", "cdb venceu", "resgate"
"renda", "renda extra", "pagamento recebido", "honorários", "comissão"
"bonus", "bônus", "participação nos lucros", "PLR", "reembolso", "devolução"

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

GATILHOS DE CONCLUIR TAREFA — qualquer variação abaixo indica conclusão:
"concluí", "conclui", "já conclui", "já concluí", "concluído", "concluída"
"terminei", "terminou", "já terminei", "já terminou"
"fiz", "já fiz", "fiz a tarefa", "já fiz a tarefa", "foi feito"
"resolvi", "já resolvi", "resolvido", "resolvida"
"pronto", "pronta", "tá pronto", "ta pronto", "tá feito", "ta feito"
"feito", "feita", "ok a tarefa", "ok feito", "missão cumprida"
"marca como feito", "marca como concluído", "marca como concluída", "risca da lista"
"já paguei", "já liguei", "já fui", "já comprei"
"finalizado", "finalizada", "finalizei", "acabei", "já acabei"
"cumpri", "já cumpri", "cumprido", "executei", "já executei"
IMPORTANTE: Se a mensagem diz "Já conclui/concluí/terminei/fiz [algo]" → tipo tarefa acao concluir

ATRIBUIÇÃO DE TAREFA — qualquer uma dessas expressões:
"atribui tarefa X para Bruna", "cria tarefa X para Bruna"
"atribuir tarefa para [nome] hoje de [fazer algo]" → titulo=[fazer algo], atribuir_para=[nome]
"atribuir [nome] de [tarefa]", "atribuir [tarefa] para [nome]"
"tarefa X é para Bruna", "passa tarefa X para Bruna"
"delega tarefa X para Bruna", "tarefa X fica com Bruna"
"Bruna tem que fazer X", "X é tarefa da Bruna"
"atribui para Bruna: X", "para Bruna: X"
"passa pra Yan lavar o carro", "diz pra Bruna fazer X"
Quando identificar nome de pessoa após "para", "à", "ao", "pra" e houver uma ação/tarefa → campo "atribuir_para": "nome"
Se o prazo estiver na mensagem (hoje, amanhã, sexta, 25/05) → "prazo": "[data calculada]", "pedir_prazo": false
Se NÃO houver prazo → "prazo": null, "pedir_prazo": true

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
    const _estadosMidFlow = ['modalidade','cartao','valor','descricao','categoria','descricao_receita','descricao_foto','parcelamento','num_parcelas','mercado_multiplos'];
    const _novosIntentosKw = [
      'atribui','atribuir','criar tarefa','nova tarefa','tarefa para','tarefa:',
      'recebi','recebi de','entrou na conta','salário','salario','freelance',
      'gastei','gasto ','comprei','paguei','transferi',
      'minhas tarefas','lista tarefas','ver tarefas','pendências',
      'concluí','conclui','terminei','finalizei','já fiz'
    ];
    if (ctx.aguardando && _estadosMidFlow.includes(ctx.aguardando)) {
      const _tl = texto.toLowerCase();
      if (_novosIntentosKw.some(kw => _tl.includes(kw))) {
        await limparContexto(chat_id);
        ctx.aguardando = null; // limpa localmente para não entrar no bloco abaixo
      }
    }

    // ── Fluxo de contexto: resposta a pergunta anterior ──────────────────────
    if (ctx.aguardando && texto) {
      const campo = ctx.aguardando;
      const gasto = ctx.gasto_parcial || {};

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
            await sendTelegram(chat_id, `💳 Como foi o pagamento?\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro`);
          } else if (_isCDConf && (!gasto.cartao || gasto.cartao === 'Não informado')) {
            await setContexto(chat_id, { aguardando: 'cartao', gasto_parcial: gasto });
            await sendTelegram(chat_id, `💳 Qual cartão ou banco?\n\nEx: Nubank, Inter, Itaú, Bradesco...`);
          } else if (_isCredConf && !gasto.parcelas && gasto.tipo !== 'multiplos') {
            await setContexto(chat_id, { aguardando: 'parcelamento', gasto_parcial: gasto });
            await sendTelegram(chat_id, `💳 Foi à vista ou parcelado?\n\n1️⃣ À vista\n2️⃣ Parcelado`);
          } else {
            if (gasto.tipo === 'multiplos') {
              await setContexto(chat_id, { aguardando: 'mercado_multiplos', gasto_parcial: gasto });
              await sendTelegram(chat_id, `🛒 Essa compra foi em supermercado ou mercado?\n\n1️⃣ Sim\n2️⃣ Não`);
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
            const outrosConf = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
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
          modalidade: `💳 *Forma de pagamento* (atual: _${gasto.modalidade||'Não informado'}_)\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro`,
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
            await sendTelegram(chat_id, `💳 Como foi o pagamento?\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro`);
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
            const _outrosFoto = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
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
          dadosNeg.tarefas = (dadosNeg.tarefas || []).filter(t => t.id !== tarefaCtx.tarefa_id);
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
        const dadosRg = (await supabaseQuery(`/user_data?user_id=eq.${tarefaRg.atribuidor_user_id}&select=data`))?.[0]?.data || {};
        const tarefaRgObj = (dadosRg.tarefas || []).find(t => t.id === tarefaRg.tarefa_id);
        if (tarefaRgObj) {
          tarefaRgObj.prazo = novoPrazo;
          await supabaseQuery(`/user_data?user_id=eq.${tarefaRg.atribuidor_user_id}`, 'PATCH', { data: dadosRg, updated_at: new Date().toISOString() });
        }
        await sendTelegram(tarefaRg.atribuidor_chat_id,
          `📅 *${nomeRemetente} reagendou a tarefa!*\n\n📝 ${tarefaRg.titulo}\n📅 Novo prazo: *${fmtData(novoPrazo)}*`
        );
        await sendTelegram(chat_id, `✅ Tarefa reagendada para *${fmtData(novoPrazo)}*!`);
        return res.status(200).json({ ok: true });

      } else if (campo === 'descricao_receita') {
        // Valida que a descrição não é genérica
        const _descGen2 = ['recebimento','pagamento','transferencia','transferência','deposito','depósito','entrada','dinheiro','valor'];
        if (!texto.trim() || _descGen2.includes(texto.toLowerCase().trim()) || texto.trim().length < 3) {
          await sendTelegram(chat_id, `📝 Descrição muito vaga. Seja mais específico:\nEx: *Salário maio*, *Freelance logo cliente*, *Aluguel apartamento João*`);
          return res.status(200).json({ ok: true });
        }
        gasto.descricao = texto.trim();
        gasto.tipo = 'receita';
        // Salva a receita com a descrição correta
        await supabaseQuery('/telegram_pendentes', 'POST', {
          user_id,
          descricao: gasto.descricao,
          valor: gasto.valor,
          categoria: gasto.categoria || 'Outros',
          cartao: gasto.conta || 'Não informado',
          data_lancamento: gasto.data_lancamento || new Date().toISOString().split('T')[0],
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
        await limparContexto(chat_id);
        const valorR = parseFloat(gasto.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        await sendTelegram(chat_id,
          `✅ *Receita registrada!*\n\n📝 ${gasto.descricao}\n💰 ${valorR}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n⏳ Aguardando sua autorização no BY Finance.`
        );
        return res.status(200).json({ ok: true });

      } else if (campo === 'prazo_tarefa_atribuida') {
        const prazoA = parsePrazo(texto);
        console.log('Prazo calculado:', prazoA, 'Texto recebido:', texto);
        gasto.prazo = prazoA;  // atualiza o gasto_parcial com o prazo recém calculado
        gasto.pedir_prazo = false;
        // Cria a tarefa com atribuição usando prazoA (não gasto_parcial original)
        const tarefasAtrib = await supabaseQuery(`/user_data?user_id=eq.${user_id}&select=data`);
        const dadosAtrib = tarefasAtrib?.[0]?.data || {};
        const listaAtrib = dadosAtrib.tarefas || [];
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
        dadosAtrib.tarefas = listaAtrib;
        await fetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${user_id}`,{method:'PATCH',headers:{'Content-Type':'application/json','apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Prefer':'return=minimal'},body:JSON.stringify({data:dadosAtrib,updated_at:new Date().toISOString()})});
        await limparContexto(chat_id);
        const nomeAtribCtx = gasto.atribuir_para.toLowerCase().trim();
        const todosVinculosCtx = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&select=chat_id,nome`);
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
        const listaD = dadosD.tarefas || [];
        listaD.push({id:Date.now(),titulo:gasto.titulo,prazo:gasto.prazo||null,prio:gasto.prioridade||'Media',concluida:false,origem:'telegram',origem_nome:nomeRemetente});
        dadosD.tarefas = listaD;
        await fetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${user_id}`,{method:'PATCH',headers:{'Content-Type':'application/json','apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Prefer':'return=minimal'},body:JSON.stringify({data:dadosD,updated_at:new Date().toISOString()})});
        await limparContexto(chat_id);
        const prazoTxt = gasto.prazo ? ` · 📅 ${new Date(gasto.prazo+'T12:00:00').toLocaleDateString('pt-BR')}` : '';
        await sendTelegram(chat_id, `✅ *Tarefa criada!*\n\n📋 ${gasto.titulo}${prazoTxt}\n🎯 Prioridade: ${gasto.prioridade||'Média'}`);
        const _outrosPT = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
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
        // Usuário respondeu a modalidade (aceita número 1-4 ou texto)
        const _normMod = normalizeModalidade(texto);
        const _validMods = ['PIX', 'Crédito', 'Débito', 'Dinheiro'];
        if (!_validMods.includes(_normMod)) {
          // Resposta inválida — repergunta sem consumir o contexto
          await sendTelegram(chat_id, `Não entendi. Escolha uma das opções:\n\n1️⃣ PIX\n2️⃣ Crédito\n3️⃣ Débito\n4️⃣ Dinheiro`);
          return res.status(200).json({ ok: true });
        }
        gasto.modalidade = _normMod;
        // preserva tipo (pode ser 'multiplos')
        if (gasto.tipo !== 'multiplos') gasto.tipo = 'lancamento';
        const modLow = gasto.modalidade.toLowerCase();
        const isPix = modLow.includes('pix');
        const isDinheiro = modLow.includes('dinheiro') || modLow.includes('especie') || modLow.includes('espécie');

        if (isPix || isDinheiro) {
          gasto.cartao = gasto.modalidade;
          if (gasto.tipo === 'multiplos') {
            await setContexto(chat_id, { aguardando: 'mercado_multiplos', gasto_parcial: gasto });
            await sendTelegram(chat_id, `🛒 Essa compra foi em supermercado ou mercado?\n\n1️⃣ Sim\n2️⃣ Não`);
            return res.status(200).json({ ok: true });
          }
          await limparContexto(chat_id);
          await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, nomeRemetente);
          const valorCtx1 = (parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
          const msgCtx1 = `✅ *Lançamento registrado!*\n\n📝 ${gasto.descricao||'(sem descrição)'}\n💰 ${valorCtx1}\n🏷 ${gasto.categoria||'Outros'}\n${iconeModalidade(gasto.modalidade)} ${gasto.modalidade||'Não informado'}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n⏳ Aguardando sua autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`;
          await sendTelegram(chat_id, msgCtx1);
          const outrosCtx1 = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
          for (const o of (outrosCtx1||[])) { await sendTelegram(o.chat_id, `📱 *${escapeMd(nomeRemetente)} registrou um gasto pendente*\n\n📝 ${escapeMd(gasto.descricao||'(sem descrição)')}\n💰 ${valorCtx1}\n🏷 ${escapeMd(gasto.categoria||'Outros')}\n${iconeModalidade(gasto.modalidade)} ${escapeMd(gasto.modalidade||'Não informado')}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n_Acesse o BY Finance para autorizar\\._`); }
        } else {
          // Crédito/Débito → precisa saber o cartão/banco
          await setContexto(chat_id, { aguardando: 'cartao', gasto_parcial: gasto });
          await sendTelegram(chat_id,
            `💳 Qual cartão ou banco?\n\nEx: Nubank, Inter, Itaú, Bradesco...`
          );
        }
        return res.status(200).json({ ok: true });

      } else if (campo === 'cartao') {
        gasto.cartao = fmtCartao(texto.trim());
        if (gasto.tipo !== 'multiplos') gasto.tipo = 'lancamento';
        if (gasto.tipo === 'multiplos') {
          await setContexto(chat_id, { aguardando: 'mercado_multiplos', gasto_parcial: gasto });
          await sendTelegram(chat_id, `🛒 Essa compra foi em supermercado ou mercado?\n\n1️⃣ Sim\n2️⃣ Não`);
          return res.status(200).json({ ok: true });
        } else {
          // Crédito sem parcelas → perguntar antes de salvar
          const _isCredCartao = (gasto.modalidade || '').toLowerCase().includes('cred');
          if (_isCredCartao && !gasto.parcelas) {
            await setContexto(chat_id, { aguardando: 'parcelamento', gasto_parcial: gasto });
            await sendTelegram(chat_id, `💳 Foi à vista ou parcelado?\n\n1️⃣ À vista\n2️⃣ Parcelado`);
            return res.status(200).json({ ok: true });
          }
          await limparContexto(chat_id);
          await salvarPendente(chat_id, user_id, gasto, tipo_midia, mensagem_original, nomeRemetente);
          const valorCtx2 = (parseFloat(gasto.valor)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
          const _parcelaCtx2 = gasto.parcelas && gasto.parcelas > 1 ? `\n🔄 ${gasto.parcelas}x de ${parseFloat(gasto.valor_parcela||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}` : '';
          const msgCtx2 = `✅ *Lançamento registrado!*\n\n📝 ${gasto.descricao||'(sem descrição)'}\n💰 ${valorCtx2}${_parcelaCtx2}\n🏷 ${gasto.categoria||'Outros'}\n💳 ${fmtCartao(gasto.cartao)}\n${iconeModalidade(gasto.modalidade)} ${gasto.modalidade||gasto.cartao||'Não informado'}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n⏳ Aguardando sua autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`;
          await sendTelegram(chat_id, msgCtx2);
          const outrosCtx2 = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
          for (const o of (outrosCtx2||[])) { await sendTelegram(o.chat_id, `📱 *${escapeMd(nomeRemetente)} registrou um gasto pendente*\n\n📝 ${escapeMd(gasto.descricao||'(sem descrição)')}\n💰 ${valorCtx2}${_parcelaCtx2}\n🏷 ${escapeMd(gasto.categoria||'Outros')}\n💳 ${escapeMd(fmtCartao(gasto.cartao||'Não informado'))}\n${iconeModalidade(gasto.modalidade)} ${escapeMd(gasto.modalidade||'Não informado')}\n📅 ${fmtData(gasto.data_lancamento||new Date().toISOString().split('T')[0])}\n\n_Acesse o BY Finance para autorizar\\._`); }
        }
        return res.status(200).json({ ok: true });

      } else if (campo === 'mercado_multiplos') {
        const _isMkt = texto.trim() === '1' || /^sim$/i.test(texto.trim());
        const _lansM = gasto.lancamentos || [];
        _lansM.forEach(l => {
          l.modalidade = gasto.modalidade;
          l.cartao = gasto.cartao;
          if (_isMkt) { if (!l.mktTipo) l.mktTipo = 'variavel'; if (!l.categoria) l.categoria = 'Mercado'; }
          else { l.mktTipo = null; if (!l.categoria) l.categoria = 'Outros'; }
          if (!l.data_lancamento) l.data_lancamento = new Date().toISOString().split('T')[0];
        });
        await limparContexto(chat_id);
        for (const l of _lansM) await salvarPendente(chat_id, user_id, l, tipo_midia, mensagem_original, nomeRemetente);
        const _listaMkt = _lansM.map(l=>`• ${l.descricao} — ${parseFloat(l.valor||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}`).join('\n');
        const _cartaoMktStr = gasto.cartao && gasto.cartao !== gasto.modalidade ? `💳 ${fmtCartao(gasto.cartao)}\n` : '';
        await sendTelegram(chat_id, `✅ *${_lansM.length} lançamentos registrados!*\n\n${_listaMkt}\n\n${_cartaoMktStr}${iconeModalidade(gasto.modalidade)} ${gasto.modalidade}\n\n⏳ Aguardando autorização no BY Finance.\nVocê tem *7 dias* para aprovar ou rejeitar.`);
        const _outrosMkt = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
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
          const _outrosP = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
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
          const _outrosV = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
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
        const _outrosNP = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
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

    const gasto = await interpretarComGemini({ texto, audioUrl, fotoUrl, mimeType });

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
        await limparContexto(chat_id);
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
      const _descGenericas = ['recebimento','pagamento','transferencia','transferência','deposito','depósito','pix recebido','entrada','dinheiro','valor','receita','renda'];
      const _descReceitaRaw = (gasto.descricao || '').toLowerCase().trim();
      const _descGenerica = !_descReceitaRaw || _descGenericas.includes(_descReceitaRaw) || _descReceitaRaw.length < 3;
      if (_descGenerica) {
        await setContexto(chat_id, { aguardando: 'descricao_receita', gasto_parcial: { ...gasto, tipo: 'receita' } });
        await sendTelegram(chat_id,
          `💰 Receita de *${parseFloat(gasto.valor).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}* identificada!\n\n` +
          `📝 *O que foi essa entrada de dinheiro?*\n` +
          `Ex: Salário maio, Freelance site, Aluguel apartamento, Pagamento cliente João...`
        );
        return res.status(200).json({ ok: true });
      }
      // Sem data — usa hoje mas avisa
      if (!gasto.data_lancamento) {
        gasto.data_lancamento = new Date().toISOString().split('T')[0];
      }
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
      const _outrosReceita = await supabaseQuery(`/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`);
      for (const o of (_outrosReceita||[])) {
        await sendTelegram(o.chat_id, `💰 *${escapeMd(nomeRemetente)} registrou uma receita*\n\n📝 ${escapeMd(gasto.descricao)}\n💰 ${valor}\n📅 ${fmtData(gasto.data_lancamento)}\n\n_Acesse o BY Finance para autorizar\\._`);
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
        `/telegram_vinculos?user_id=eq.${user_id}&chat_id=neq.${chat_id}&select=chat_id,nome`
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