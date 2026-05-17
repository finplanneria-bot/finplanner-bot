#!/usr/bin/env node
/**
 * blind-test.cjs — Testa o NLU parser antes de cada deploy
 * Uso: node scripts/blind-test.cjs [--verbose]
 * CI:  npm run blind-test  (exit 1 se score < 90%)
 *
 * Prompt em sync com buildNLUPrompt() em app.js (manter sincronizado manualmente).
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const OpenAI = require("openai");

const VERBOSE = process.argv.includes("--verbose");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_INTENT_MODEL || "gpt-4o-mini";
const TODAY = new Date().toISOString().slice(0, 10);
const THIS_MONTH = TODAY.slice(0, 8); // "YYYY-MM-"

// ─── Prompt de produção (sync com buildNLUPrompt em app.js) ──────────────────
const SYSTEM_PROMPT = `Você é o parser do FinPlanner IA (bot brasileiro de finanças no WhatsApp).
Hoje: ${TODAY}.

Retorne JSON válido (sem markdown) com a estrutura:
{"intent":"...","entries":[...],"query":{...},"delete_target":{...},"confidence":0-1}

INTENTS VÁLIDOS:
register | query_balance | query_pending | query_report | list_entries | delete | edit | help | menu | cancel | off_topic | unknown

ENTRIES (apenas para intent="register"):
[{"type":"payment|income","amount":N,"description":"string","category":"slug","status":"paid|received|pending","due_date":"YYYY-MM-DD|null"}]
- type: payment=gasto/saída; income=entrada/recebimento
- amount: valor em reais (número). Gírias ×1: "pila","mango","prata" = reais. Gíria ×1000: "conto/contos" = R$1000. "80 pila"→80, "2 contos"→2000.
- description: CURTA (≤25 chars), limpa, sem verbos/gírias/números. Ex: "Uber", "Almoço", "Pix do João".
- category: slug fixo da lista abaixo
- status: paid=pago/realizado, received=recebido, pending=ainda vai vencer ou "vence dia X"
- due_date: ISO YYYY-MM-DD se mencionada, null se não mencionada

CATEGORIAS (slugs fixos):
alimentacao, mercado, transporte, moradia, saude, lazer, internet_telefonia,
educacao, roupas, pets, presentes, salario_trabalho, vendas_receitas, banco_financeiro, outros

QUERY (para query_report, query_balance, query_pending):
{"categories":["slug",...],"period":"month|last_month|today|yesterday|year","tag":"string|null"}
- "comida"/"alimentação" como conceito amplo → categories: ["alimentacao","mercado"]

DELETE_TARGET (para delete):
{"description_hint":"string","amount_hint":N}

REGRAS CRÍTICAS:
- Múltiplos lançamentos em uma frase → retornar TODOS em entries[]
- PIX/transferência pessoal entre pessoas físicas → category="outros" (NÃO "vendas_receitas")
- Venda real/serviço prestado → category="vendas_receitas"
- "to no negativo/positivo?","to bem de grana?","como ando financeiramente?" → query_balance
- "to devendo","minhas dívidas","contas atrasadas" → query_pending
- Verbos que indicam status paid: paguei, comprei, almocei, jantei, lanchei, gastei, botei, usei, abasteci, assinei, fiz, comi, tomei
- Verbos que indicam status received: recebi, caiu, entrou, depositaram, creditaram
- Sem verbo ou "vence dia X" → status=pending
- Description sem: verbos de ação, gírias monetárias, preposições iniciais, artigos

EXEMPLOS:
"recebi um pix do joao de 80 pila"
→{"intent":"register","entries":[{"type":"income","amount":80,"description":"Pix do João","category":"outros","status":"received","due_date":null}],"confidence":0.95}

"paguei 25 no uber e 15 num lanche"
→{"intent":"register","entries":[{"type":"payment","amount":25,"description":"Uber","category":"transporte","status":"paid","due_date":null},{"type":"payment","amount":15,"description":"Lanche","category":"alimentacao","status":"paid","due_date":null}],"confidence":0.95}

"to no negativo ou positivo?"
→{"intent":"query_balance","confidence":0.9}

"quanto gastei com comida esse mes"
→{"intent":"query_report","query":{"categories":["alimentacao","mercado"],"period":"month"},"confidence":0.9}

"conta de luz 150 vence dia 20"
→{"intent":"register","entries":[{"type":"payment","amount":150,"description":"Conta de luz","category":"moradia","status":"pending","due_date":"${THIS_MONTH}20"}],"confidence":0.95}

"pix do joao 50"
→{"intent":"register","entries":[{"type":"income","amount":50,"description":"Pix do João","category":"outros","status":"received","due_date":null}],"confidence":0.85}

"apaga o pix do joao"
→{"intent":"delete","delete_target":{"description_hint":"pix do joão","amount_hint":null},"confidence":0.9}

"almocei 30"
→{"intent":"register","entries":[{"type":"payment","amount":30,"description":"Almoço","category":"alimentacao","status":"paid","due_date":null}],"confidence":0.95}

"excluir 23"
→{"intent":"delete","delete_target":{"description_hint":null,"amount_hint":null,"index_hint":23},"confidence":0.85}

"ta com algum erro no total ai? ta dando 100 milhoes"
→{"intent":"off_topic","confidence":0.95}

"tem um lançamento de 100 milhoes que n foi eu, tira isso de lá"
→{"intent":"delete","delete_target":{"description_hint":"100 milhoes","amount_hint":null},"confidence":0.85}

"deu algum erro no sistema?"
→{"intent":"off_topic","confidence":0.9}

"paguei 2 contos no mercado"
→{"intent":"register","entries":[{"type":"payment","amount":2000,"description":"Mercado","category":"mercado","status":"paid","due_date":null}],"confidence":0.95}

"como ando financeiramente?"
→{"intent":"query_balance","confidence":0.9}

"to bem de grana?"
→{"intent":"query_balance","confidence":0.9}

"kuanto gastei mes pasado"
→{"intent":"query_report","query":{"categories":[],"period":"last_month","tag":null},"confidence":0.85}`;

const buildPrompt = (text) => [
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user",   content: text },
];

async function callNLU(text) {
  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages: buildPrompt(text),
      temperature: 0,
      max_tokens: 800,
    });
    const raw = resp.choices[0]?.message?.content?.trim() || "";
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    return { intent: "error", _error: e.message };
  }
}

// ─── Utilitários de asserção ──────────────────────────────────────────────────
const hasEntry = (r, pred) => Array.isArray(r.entries) && r.entries.some(pred);
const allEntries = (r, pred) => Array.isArray(r.entries) && r.entries.length > 0 && r.entries.every(pred);
const descClean = (desc) =>
  desc &&
  desc.length <= 25 &&
  !/\b(paguei|gastei|recebi|comprei|almocei|comi|abasteci|botei|usei)\b/i.test(desc) &&
  !/\b(pila|mango|prata|conto|contos)\b/i.test(desc);

// ─── Casos de teste ───────────────────────────────────────────────────────────
const CASES = [
  // ════════════════════════════════════════════════════════════════════════════
  // A — Gírias monetárias
  // ════════════════════════════════════════════════════════════════════════════
  { id: "a-1",
    input: "recebi um pix do joao de 80 pila",
    check: r => r.intent === "register" && hasEntry(r, e => e.amount === 80) && !hasEntry(r, e => /pila/i.test(e.description || "")),
    desc: "80 pila → amount=80, sem 'pila' na descrição" },

  { id: "a-2",
    input: "paguei 2 contos no mercado",
    check: r => hasEntry(r, e => e.amount === 2000),
    desc: "2 contos → R$2.000" },

  { id: "a-3",
    input: "gastei 50 mango no uber",
    check: r => hasEntry(r, e => e.amount === 50),
    desc: "50 mango → 50 (×1, não ×1000)" },

  { id: "a-4",
    input: "paguei 1 conto de luz",
    check: r => hasEntry(r, e => e.amount === 1000),
    desc: "1 conto → R$1.000" },

  { id: "a-5",
    input: "10 contos de aluguel",
    check: r => hasEntry(r, e => e.amount === 10000),
    desc: "10 contos → R$10.000" },

  // ════════════════════════════════════════════════════════════════════════════
  // B — Multi-entry
  // ════════════════════════════════════════════════════════════════════════════
  { id: "b-1",
    input: "paguei 25 no uber e 15 num lanche",
    check: r => r.intent === "register" && r.entries?.length === 2
             && hasEntry(r, e => e.amount === 25) && hasEntry(r, e => e.amount === 15),
    desc: "dois lançamentos: uber 25 + lanche 15" },

  { id: "b-2",
    input: "almoço 30 e gasolina 80",
    check: r => r.entries?.length >= 2
             && hasEntry(r, e => e.amount === 30) && hasEntry(r, e => e.amount === 80),
    desc: "multi-entry sem verbo explícito" },

  { id: "b-3",
    input: "paguei 50 uber, 30 no lanche e 20 no café",
    check: r => r.entries?.length >= 3,
    desc: "três lançamentos com vírgula" },

  { id: "b-4",
    input: "recebi 1000 de freelance e gastei 200 no mercado",
    check: r => r.entries?.length === 2
             && hasEntry(r, e => e.type === "income" && e.amount === 1000)
             && hasEntry(r, e => e.type === "payment" && e.amount === 200),
    desc: "income + payment na mesma frase" },

  // ════════════════════════════════════════════════════════════════════════════
  // C — PIX / transferência pessoal vs venda real
  // ════════════════════════════════════════════════════════════════════════════
  { id: "c-1",
    input: "recebi pix do joao 80",
    check: r => hasEntry(r, e => e.category === "outros"),
    desc: "PIX pessoal → outros (não vendas_receitas)" },

  { id: "c-2",
    input: "transferência da Maria 200",
    check: r => hasEntry(r, e => e.category === "outros"),
    desc: "transferência pessoal → outros" },

  { id: "c-3",
    input: "vendi meu celular 500",
    check: r => hasEntry(r, e => e.category === "vendas_receitas"),
    desc: "venda real de bem → vendas_receitas" },

  { id: "c-4",
    input: "paguei pix para o Pedro 100",
    check: r => hasEntry(r, e => e.category === "outros"),
    desc: "pix enviado para pessoa → outros" },

  // ════════════════════════════════════════════════════════════════════════════
  // D — Consulta de saldo / situação financeira
  // ════════════════════════════════════════════════════════════════════════════
  { id: "d-1",
    input: "to no negativo ou positivo?",
    check: r => r.intent === "query_balance",
    desc: "'to no negativo' → query_balance" },

  { id: "d-2",
    input: "como ando financeiramente?",
    check: r => r.intent === "query_balance",
    desc: "'como ando financeiramente' → query_balance" },

  { id: "d-3",
    input: "to bem de grana?",
    check: r => r.intent === "query_balance",
    desc: "'to bem de grana' → query_balance" },

  { id: "d-4",
    input: "to no azul ou no vermelho",
    check: r => r.intent === "query_balance",
    desc: "'no azul/vermelho' → query_balance" },

  { id: "d-5",
    input: "qual meu saldo esse mês?",
    check: r => r.intent === "query_balance",
    desc: "'qual meu saldo' → query_balance" },

  // ════════════════════════════════════════════════════════════════════════════
  // E — Contas pendentes / dívidas
  // ════════════════════════════════════════════════════════════════════════════
  { id: "e-1",
    input: "minhas dívidas",
    check: r => r.intent === "query_pending",
    desc: "'minhas dívidas' → query_pending" },

  { id: "e-2",
    input: "contas atrasadas",
    check: r => r.intent === "query_pending",
    desc: "'contas atrasadas' → query_pending" },

  { id: "e-3",
    input: "o que to devendo",
    check: r => ["query_pending", "register"].includes(r.intent),
    desc: "'to devendo' → pending ou register" },

  // ════════════════════════════════════════════════════════════════════════════
  // F — Relatórios de gastos por categoria / período
  // ════════════════════════════════════════════════════════════════════════════
  { id: "f-1",
    input: "quanto gastei com comida esse mes",
    check: r => r.intent === "query_report"
             && r.query?.categories?.includes("alimentacao")
             && r.query?.categories?.includes("mercado"),
    desc: "'comida' → categories=[alimentacao, mercado]" },

  { id: "f-2",
    input: "me mostra os gastos do mês",
    check: r => ["query_report", "list_entries"].includes(r.intent),
    desc: "'gastos do mês' → query_report" },

  { id: "f-3",
    input: "gastei muito com transporte esse mês",
    check: r => r.intent === "query_report"
             && r.query?.categories?.some(c => c === "transporte"),
    desc: "'transporte' → categories=[transporte]" },

  { id: "f-4",
    input: "kuanto gastei mes pasado",
    check: r => ["query_report", "list_entries"].includes(r.intent)
             && r.query?.period === "last_month",
    desc: "typo + 'mês passado' → period=last_month" },

  { id: "f-5",
    input: "gastos de ontem",
    check: r => ["query_report", "list_entries"].includes(r.intent)
             && r.query?.period === "yesterday",
    desc: "'ontem' → period=yesterday" },

  { id: "f-6",
    input: "quanto gastei esse ano",
    check: r => ["query_report", "list_entries"].includes(r.intent)
             && r.query?.period === "year",
    desc: "'esse ano' → period=year" },

  // ════════════════════════════════════════════════════════════════════════════
  // G — Inferência de status (paid / received / pending)
  // ════════════════════════════════════════════════════════════════════════════
  { id: "g-1",
    input: "almocei 30",
    check: r => hasEntry(r, e => e.status === "paid" && e.amount === 30),
    desc: "'almocei' → status=paid" },

  { id: "g-2",
    input: "abasteci hoje 150",
    check: r => hasEntry(r, e => e.status === "paid" && e.amount === 150),
    desc: "'abasteci' → status=paid" },

  { id: "g-3",
    input: "conta de luz 180 vence dia 15",
    check: r => hasEntry(r, e => e.status === "pending" && e.amount === 180),
    desc: "'vence dia' → status=pending" },

  { id: "g-4",
    input: "minha aposentadoria caiu hoje 1500",
    check: r => hasEntry(r, e => e.type === "income" && e.amount === 1500),
    desc: "'caiu' → type=income, status=received" },

  { id: "g-5",
    input: "comi 25 num lanche",
    check: r => hasEntry(r, e => e.status === "paid"),
    desc: "'comi' → status=paid" },

  { id: "g-6",
    input: "jantei fora 120",
    check: r => hasEntry(r, e => e.status === "paid" && e.amount === 120),
    desc: "'jantei' → status=paid" },

  { id: "g-7",
    input: "tomei um táxi 35",
    check: r => hasEntry(r, e => e.status === "paid" && e.amount === 35),
    desc: "'tomei' → status=paid" },

  { id: "g-8",
    input: "salário do mês 4500",
    check: r => hasEntry(r, e => e.type === "income" && e.amount === 4500),
    desc: "salário sem verbo → type=income" },

  // ════════════════════════════════════════════════════════════════════════════
  // H — Exclusão (delete)
  // ════════════════════════════════════════════════════════════════════════════
  { id: "h-1",
    input: "apaga o ultimo lançamento",
    check: r => r.intent === "delete",
    desc: "'apaga o ultimo' → delete" },

  { id: "h-2",
    input: "excluir 23",
    check: r => r.intent === "delete",
    desc: "'excluir 23' → delete (nunca register)" },

  { id: "h-3",
    input: "exclui o lançamento do uber",
    check: r => r.intent === "delete"
             && /uber/i.test(r.delete_target?.description_hint || ""),
    desc: "excluir com descrição → delete_target com 'uber'" },

  { id: "h-4",
    input: "apaga o pix do joao",
    check: r => r.intent === "delete",
    desc: "'apaga o pix do joao' → delete" },

  { id: "h-5",
    input: "tem um lançamento de 100 milhoes que n foi eu, tira isso de lá",
    check: r => r.intent === "delete",
    desc: "reclamação de valor errado → delete (não register)" },

  // ════════════════════════════════════════════════════════════════════════════
  // I — Off-topic / frases de erro / reclamação
  // ════════════════════════════════════════════════════════════════════════════
  { id: "i-1",
    input: "qual a previsão do tempo?",
    check: r => ["off_topic", "unknown"].includes(r.intent),
    desc: "off-topic irrelevante" },

  { id: "i-2",
    input: "ta com algum erro no total ai? ta dando 100 milhoes",
    check: r => r.intent !== "register",
    desc: "'ta dando 100 milhoes' → NÃO register" },

  { id: "i-3",
    input: "deu algum erro no sistema?",
    check: r => ["off_topic", "unknown"].includes(r.intent),
    desc: "pergunta sobre erro → off_topic" },

  { id: "i-4",
    input: "você é uma inteligência artificial?",
    check: r => ["off_topic", "unknown", "help"].includes(r.intent),
    desc: "pergunta existencial → off_topic ou help" },

  // ════════════════════════════════════════════════════════════════════════════
  // J — Qualidade da descrição
  // ════════════════════════════════════════════════════════════════════════════
  { id: "j-1",
    input: "paguei 50 almoço",
    check: r => hasEntry(r, e => descClean(e.description)),
    desc: "descrição limpa: sem verbo, sem valor, ≤25 chars" },

  { id: "j-2",
    input: "recebi pix do joao 80 pila",
    check: r => hasEntry(r, e => descClean(e.description) && !/pila/i.test(e.description || "")),
    desc: "descrição sem gíria monetária 'pila'" },

  { id: "j-3",
    input: "gastei 35 no uber",
    check: r => hasEntry(r, e => e.description && e.description.length <= 25 && !/gastei|35/i.test(e.description)),
    desc: "descrição: 'Uber' (sem verbo nem valor)" },

  // ════════════════════════════════════════════════════════════════════════════
  // K — Categorias específicas
  // ════════════════════════════════════════════════════════════════════════════
  { id: "k-1",
    input: "paguei 150 de mercado",
    check: r => hasEntry(r, e => e.amount === 150 && e.category === "mercado"),
    desc: "'mercado' explícito → category=mercado" },

  { id: "k-2",
    input: "academia 100",
    check: r => hasEntry(r, e => ["saude", "lazer"].includes(e.category)),
    desc: "'academia' → saude ou lazer" },

  { id: "k-3",
    input: "spotify 45",
    check: r => hasEntry(r, e => ["lazer", "internet_telefonia"].includes(e.category)),
    desc: "'spotify' → lazer ou internet_telefonia" },

  { id: "k-4",
    input: "conta de luz 200",
    check: r => hasEntry(r, e => e.category === "moradia"),
    desc: "'conta de luz' → moradia" },

  { id: "k-5",
    input: "farmácia 80",
    check: r => hasEntry(r, e => e.category === "saude"),
    desc: "'farmácia' → saude" },

  // ════════════════════════════════════════════════════════════════════════════
  // L — Frases mínimas (sem verbo)
  // ════════════════════════════════════════════════════════════════════════════
  { id: "l-1",
    input: "uber 35",
    check: r => hasEntry(r, e => e.amount === 35 && e.category === "transporte"),
    desc: "frase mínima: 'uber 35' → transporte, 35" },

  { id: "l-2",
    input: "150 luz",
    check: r => hasEntry(r, e => e.amount === 150),
    desc: "frase mínima invertida: '150 luz'" },

  { id: "l-3",
    input: "pix mãe 200",
    check: r => hasEntry(r, e => e.amount === 200),
    desc: "pix para familiar → amount=200" },

  // ════════════════════════════════════════════════════════════════════════════
  // M — Regionalismos e gírias
  // ════════════════════════════════════════════════════════════════════════════
  { id: "m-1",
    input: "bah, 80 pilas no almoço",
    check: r => hasEntry(r, e => e.amount === 80),
    desc: "gaúcho: '80 pilas' → amount=80" },

  { id: "m-2",
    input: "mano paguei 50 num lanche véi",
    check: r => hasEntry(r, e => e.amount === 50 && e.status === "paid"),
    desc: "gíria jovem SP: amount=50, paid" },

  { id: "m-3",
    input: "minha aposentadoria caiu hoje 1500",
    check: r => hasEntry(r, e => e.type === "income" && e.amount === 1500),
    desc: "'caiu' → income, 1500" },

  { id: "m-4",
    input: "botei 60 de gasolina",
    check: r => hasEntry(r, e => e.amount === 60 && e.status === "paid"),
    desc: "'botei' (nordestino) → status=paid" },

  // ════════════════════════════════════════════════════════════════════════════
  // N — Tolerância a erros de digitação
  // ════════════════════════════════════════════════════════════════════════════
  { id: "n-1",
    input: "paguie 30 almoço",
    check: r => hasEntry(r, e => e.amount === 30),
    desc: "'paguie' (typo) → amount=30" },

  { id: "n-2",
    input: "ressebi 500 de freelance",
    check: r => hasEntry(r, e => e.type === "income" && e.amount === 500),
    desc: "'ressebi' (typo) → income, 500" },

  { id: "n-3",
    input: "kanto gastei hj",
    check: r => ["query_report", "query_balance", "list_entries"].includes(r.intent),
    desc: "'kanto gastei hj' (typos) → consulta (não register)" },

  // ════════════════════════════════════════════════════════════════════════════
  // O — Datas explícitas
  // ════════════════════════════════════════════════════════════════════════════
  { id: "o-1",
    input: "conta de água 90 vence dia 10",
    check: r => hasEntry(r, e => e.status === "pending" && e.due_date === `${THIS_MONTH}10`),
    desc: "'vence dia 10' → due_date=YYYY-MM-10, pending" },

  { id: "o-2",
    input: "aluguel 1200 vence dia 5",
    check: r => hasEntry(r, e => e.status === "pending" && e.amount === 1200),
    desc: "'aluguel vence dia 5' → pending, 1200" },

  // ════════════════════════════════════════════════════════════════════════════
  // P — Regressão: comportamentos básicos preservados
  // ════════════════════════════════════════════════════════════════════════════
  { id: "p-1",
    input: "paguei 50 almoço",
    check: r => r.intent === "register"
             && hasEntry(r, e => e.amount === 50 && e.status === "paid" && e.category === "alimentacao"),
    desc: "registro básico: 50, paid, alimentacao" },

  { id: "p-2",
    input: "recebi 3000 salário",
    check: r => hasEntry(r, e => e.type === "income" && e.amount === 3000),
    desc: "recebimento básico: income, 3000" },

  { id: "p-3",
    input: "contas a pagar",
    check: r => r.intent === "query_pending",
    desc: "'contas a pagar' → query_pending" },

  { id: "p-4",
    input: "ajuda",
    check: r => r.intent === "help",
    desc: "'ajuda' → help" },

  { id: "p-5",
    input: "cancelar",
    check: r => r.intent === "cancel",
    desc: "'cancelar' → cancel" },

  { id: "p-6",
    input: "paguei 150 de mercado",
    check: r => hasEntry(r, e => e.amount === 150 && e.category === "mercado"),
    desc: "categoria mercado explícita preservada" },

  { id: "p-7",
    input: "meus gastos com alimentação",
    check: r => r.intent === "query_report"
             && r.query?.categories?.includes("alimentacao"),
    desc: "'alimentação' → category=alimentacao no report" },
];

// ─── Runner ───────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n🔍 FinPlanner Blind Test v2 — ${CASES.length} casos (model: ${MODEL})\n`);

  let passed = 0;
  const failures = [];

  for (const tc of CASES) {
    const result = await callNLU(tc.input);
    const ok = (() => { try { return tc.check(result); } catch { return false; } })();

    if (ok) {
      passed++;
      if (VERBOSE) console.log(`  ✅ [${tc.id}] ${tc.desc}`);
    } else {
      failures.push({ ...tc, result });
      if (!VERBOSE) {
        console.log(`  ❌ [${tc.id}] ${tc.desc}`);
        console.log(`      Input:    "${tc.input}"`);
        console.log(`      Esperado: ${tc.desc}`);
        console.log(`      Recebido: ${JSON.stringify(result).slice(0, 220)}`);
      } else {
        console.log(`  ❌ [${tc.id}] ${tc.desc}`);
        console.log(`      Input:    "${tc.input}"`);
        console.log(`      Recebido: ${JSON.stringify(result, null, 2).split("\n").slice(0, 20).join("\n")}`);
      }
    }
  }

  const score = Math.round((passed / CASES.length) * 100);
  const filled = Math.floor(score / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);

  console.log(`\n${"─".repeat(54)}`);
  console.log(`📊 Score: ${passed}/${CASES.length} (${score}%)`);
  console.log(`   [${bar}]`);

  // Resumo por família
  const families = {};
  for (const tc of CASES) {
    const fam = tc.id.split("-")[0];
    if (!families[fam]) families[fam] = { pass: 0, total: 0 };
    families[fam].total++;
    const ok = !failures.find(f => f.id === tc.id);
    if (ok) families[fam].pass++;
  }
  console.log("\n   Por família:");
  for (const [fam, stats] of Object.entries(families)) {
    const icon = stats.pass === stats.total ? "✅" : "❌";
    console.log(`   ${icon} ${fam.toUpperCase().padEnd(3)} ${stats.pass}/${stats.total}`);
  }

  if (failures.length === 0) {
    console.log(`\n✅ Todos os casos passaram — ok para deploy\n`);
    process.exit(0);
  }

  console.log(`\n❌ ${failures.length} caso(s) falhando:`);
  failures.forEach(f => console.log(`   • [${f.id}] ${f.desc}`));

  if (score < 90) {
    console.log(`\n🚫 Score < 90% — BLOQUEAR deploy\n`);
    process.exit(1);
  } else {
    console.log(`\n⚠️  Score >= 90% — ok para deploy (revisar falhas)\n`);
    process.exit(0);
  }
}

run();
