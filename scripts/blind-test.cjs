#!/usr/bin/env node
/**
 * blind-test.js — Testa o NLU parser antes de cada deploy
 * Uso: node scripts/blind-test.js [--verbose]
 * CI:  npm run blind-test  (exit 1 se score < 90%)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const OpenAI = require("openai");

const VERBOSE = process.argv.includes("--verbose");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_INTENT_MODEL || "gpt-4o-mini";
const TODAY = new Date().toISOString().slice(0, 10);
const THIS_MONTH = TODAY.slice(0, 8); // "YYYY-MM-"

// Mesmo prompt do app.js — mantido em sync manual
const buildPrompt = (text) => [
  {
    role: "system",
    content: `Você é o parser do FinPlanner IA (bot brasileiro de finanças no WhatsApp).
Hoje: ${TODAY}.

Retorne JSON válido (sem markdown) com a estrutura:
{"intent":"...","entries":[...],"query":{...},"delete_target":{...},"confidence":0-1}

INTENTS: register | query_balance | query_pending | query_report | list_entries | delete | edit | help | menu | cancel | off_topic | unknown

ENTRIES (intent="register"):
[{"type":"payment|income","amount":N,"description":"string","category":"slug","status":"paid|received|pending","due_date":"YYYY-MM-DD|null"}]
- type: payment=gasto; income=entrada/recebimento
- amount: Gírias ×1: "pila","mango","prata" = reais. Gíria ×1000: "conto/contos" = R$1000. "80 pila"→80, "2 contos"→2000.
- description LIMPA ≤25 chars: sem verbos, sem gírias, sem preposições iniciais
- status: paid: paguei/comprei/almocei/gastei/abasteci/fiz/etc. received: recebi/caiu/entrou. pending: sem verbo / "vence dia X"

QUERY (query_report, query_balance, query_pending):
{"categories":["slug",...],"period":"month|last_month|today","tag":"string|null"}
- "comida"/"alimentação" como conceito amplo → categories:["alimentacao","mercado"]
- "quanto gastei X" → query_report; "qual meu saldo/to no negativo?" → query_balance

CATEGORIAS: alimentacao, mercado, transporte, moradia, saude, lazer, internet_telefonia, educacao, roupas, pets, presentes, salario_trabalho, vendas_receitas, banco_financeiro, outros

REGRAS CRÍTICAS:
- Múltiplos lançamentos em uma frase → retornar TODOS em entries[]
- PIX/transferência pessoal entre pessoas físicas → category="outros" (NÃO "vendas_receitas")
- "to no negativo/positivo?","to bem de grana?","como ando financeiramente?","no azul ou vermelho?" → query_balance
- "to devendo","minhas dívidas","contas atrasadas" → query_pending
- Verbos paid: paguei, comprei, almocei, jantei, lanchei, gastei, botei, usei, abasteci, assinei, fiz, comi
- Verbos received: recebi, caiu, entrou, depositaram, creditaram

EXEMPLOS:
"recebi um pix do joao de 80 pila"
→{"intent":"register","entries":[{"type":"income","amount":80,"description":"Pix do João","category":"outros","status":"received","due_date":null}],"confidence":0.95}

"paguei 2 contos no mercado"
→{"intent":"register","entries":[{"type":"payment","amount":2000,"description":"Mercado","category":"mercado","status":"paid","due_date":null}],"confidence":0.95}

"paguei 25 no uber e 15 num lanche"
→{"intent":"register","entries":[{"type":"payment","amount":25,"description":"Uber","category":"transporte","status":"paid","due_date":null},{"type":"payment","amount":15,"description":"Lanche","category":"alimentacao","status":"paid","due_date":null}],"confidence":0.95}

"to no negativo ou positivo?"
→{"intent":"query_balance","confidence":0.9}

"como ando financeiramente?"
→{"intent":"query_balance","confidence":0.9}

"to bem de grana?"
→{"intent":"query_balance","confidence":0.9}

"quanto gastei com comida esse mes"
→{"intent":"query_report","query":{"categories":["alimentacao","mercado"],"period":"month","tag":null},"confidence":0.9}

"kuanto gastei mes pasado"
→{"intent":"query_report","query":{"categories":[],"period":"last_month","tag":null},"confidence":0.85}

"almocei 30"
→{"intent":"register","entries":[{"type":"payment","amount":30,"description":"Almoço","category":"alimentacao","status":"paid","due_date":null}],"confidence":0.95}`,
  },
  { role: "user", content: text },
];

async function callNLU(text) {
  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages: buildPrompt(text),
      temperature: 0,
      max_tokens: 600,
    });
    const raw = resp.choices[0]?.message?.content?.trim() || "";
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    return { intent: "error", _error: e.message };
  }
}

// Casos de teste — cada um com check(resultado) → bool
const CASES = [
  // ─── Família BUG 1: gírias monetárias ──────────────────────────────────────
  { id: "b1-1", input: "recebi um pix do joao de 80 pila",
    check: r => r.intent === "register" && r.entries?.[0]?.amount === 80
              && !/pila/i.test(r.entries?.[0]?.description || ""),
    desc: "80 pila → amount=80, sem 'pila' na descrição" },

  { id: "b1-2", input: "paguei 2 contos no mercado",
    check: r => r.entries?.[0]?.amount === 2000,
    desc: "2 contos → 2000" },

  { id: "b1-3", input: "gastei 50 mango no uber",
    check: r => r.entries?.[0]?.amount === 50,
    desc: "50 mango → 50" },

  // ─── Família BUG 2: multi-entry ────────────────────────────────────────────
  { id: "b2-1", input: "paguei 25 no uber e 15 num lanche",
    check: r => r.intent === "register" && r.entries?.length === 2
              && r.entries.some(e => e.amount === 25)
              && r.entries.some(e => e.amount === 15),
    desc: "multi-entry: 2 lançamentos distintos" },

  { id: "b2-2", input: "almoço 30 e gasolina 80",
    check: r => r.entries?.length === 2,
    desc: "multi-entry sem verbo explícito" },

  { id: "b2-3", input: "paguei 50 uber, 30 no lanche e 20 no café",
    check: r => r.entries?.length >= 2,
    desc: "multi-entry com vírgula" },

  // ─── Família BUG 3: P2P categoria ──────────────────────────────────────────
  { id: "b3-1", input: "recebi pix do joao 80",
    check: r => r.entries?.[0]?.category === "outros",
    desc: "PIX pessoal → outros (não vendas_receitas)" },

  { id: "b3-2", input: "transferência da Maria 200",
    check: r => r.entries?.[0]?.category === "outros",
    desc: "transferência pessoal → outros" },

  { id: "b3-3", input: "vendi meu celular 500",
    check: r => r.entries?.[0]?.category === "vendas_receitas",
    desc: "venda real → vendas_receitas" },

  // ─── Família BUG 4: variantes de saldo ─────────────────────────────────────
  { id: "b4-1", input: "to no negativo ou positivo?",
    check: r => r.intent === "query_balance",
    desc: "'to no negativo' → query_balance" },

  { id: "b4-2", input: "como ando financeiramente?",
    check: r => r.intent === "query_balance",
    desc: "variante natural de saldo" },

  { id: "b4-3", input: "to bem de grana?",
    check: r => r.intent === "query_balance",
    desc: "gíria de saldo" },

  { id: "b4-4", input: "to no azul ou no vermelho",
    check: r => r.intent === "query_balance",
    desc: "'no azul/vermelho' → query_balance" },

  // ─── Família BUG 6: semântica de categoria em query ────────────────────────
  { id: "b6-1", input: "quanto gastei com comida esse mes",
    check: r => r.intent === "query_report"
              && Array.isArray(r.query?.categories)
              && r.query.categories.includes("alimentacao")
              && r.query.categories.includes("mercado"),
    desc: "'comida' → categories inclui alimentacao E mercado" },

  { id: "b6-2", input: "meus gastos com alimentação",
    check: r => r.query?.categories?.includes("alimentacao"),
    desc: "'alimentação' → alimentacao" },

  { id: "b6-3", input: "quanto gastei no mercado",
    check: r => r.query?.categories?.includes("mercado"),
    desc: "'mercado' → mercado" },

  // ─── Família BUG 7: status sutil ───────────────────────────────────────────
  { id: "b7-1", input: "almocei 30",
    check: r => r.entries?.[0]?.status === "paid" && r.entries?.[0]?.amount === 30,
    desc: "'almocei' → status paid" },

  { id: "b7-2", input: "abasteci hoje 150",
    check: r => r.entries?.[0]?.status === "paid",
    desc: "'abasteci' → status paid" },

  { id: "b7-3", input: "conta de luz 180 vence dia 15",
    check: r => r.entries?.[0]?.status === "pending" && r.entries?.[0]?.amount === 180,
    desc: "vencimento → status pending" },

  // ─── Regressão: comportamento existente ────────────────────────────────────
  { id: "r-1", input: "paguei 50 almoço",
    check: r => r.entries?.[0]?.amount === 50 && r.entries?.[0]?.status === "paid"
              && r.entries?.[0]?.category === "alimentacao",
    desc: "registro básico preservado" },

  { id: "r-2", input: "recebi 3000 salário",
    check: r => r.entries?.[0]?.type === "income" && r.entries?.[0]?.amount === 3000,
    desc: "recebimento básico preservado" },

  { id: "r-3", input: "contas a pagar",
    check: r => r.intent === "query_pending",
    desc: "'contas a pagar' → query_pending" },

  { id: "r-4", input: "ajuda",
    check: r => r.intent === "help",
    desc: "'ajuda' → help" },

  { id: "r-5", input: "me mostra os gastos do mês",
    check: r => ["query_report", "relatorio_pagamentos_mes"].includes(r.intent),
    desc: "query de gastos → query_report" },

  { id: "r-6", input: "apaga o ultimo lançamento",
    check: r => r.intent === "delete",
    desc: "exclusão → delete" },

  { id: "r-7", input: "paguei 150 de mercado",
    check: r => r.entries?.[0]?.amount === 150 && r.entries?.[0]?.category === "mercado",
    desc: "mercado explícito → categoria mercado" },

  // ─── Regionalismos e gírias ────────────────────────────────────────────────
  { id: "s-1", input: "bah, 80 pilas no almoço",
    check: r => r.entries?.[0]?.amount === 80,
    desc: "gaúcho: '80 pilas'" },

  { id: "s-2", input: "mano paguei 50 num lanche véi",
    check: r => r.entries?.[0]?.amount === 50 && r.entries?.[0]?.status === "paid",
    desc: "gíria jovem SP" },

  { id: "s-3", input: "minha aposentadoria caiu hoje 1500",
    check: r => r.entries?.[0]?.type === "income" && r.entries?.[0]?.amount === 1500,
    desc: "'caiu' → recebimento" },

  { id: "s-4", input: "to devendo 800 do cartão",
    check: r => ["query_pending", "register"].includes(r.intent),
    desc: "'to devendo' → pendente ou registro" },

  // ─── Frases mínimas / sem verbo ────────────────────────────────────────────
  { id: "m-1", input: "uber 35",
    check: r => r.entries?.[0]?.amount === 35 && r.entries?.[0]?.category === "transporte",
    desc: "frase mínima com categoria" },

  { id: "m-2", input: "150 luz",
    check: r => r.entries?.[0]?.amount === 150,
    desc: "frase mínima sem verbo" },

  { id: "m-3", input: "pix mãe 200",
    check: r => r.entries?.[0]?.amount === 200,
    desc: "pix com nome" },

  // ─── Off-topic ─────────────────────────────────────────────────────────────
  { id: "o-1", input: "qual a previsão do tempo?",
    check: r => ["off_topic", "unknown"].includes(r.intent),
    desc: "off-topic detectado" },

  { id: "o-2", input: "você é uma inteligência artificial?",
    check: r => ["off_topic", "unknown", "help"].includes(r.intent),
    desc: "pergunta sobre o bot" },

  // ─── Digitação ruim / erros comuns ─────────────────────────────────────────
  { id: "t-1", input: "kuanto gastei mes pasado",
    check: r => ["query_report", "relatorio_pagamentos_mes"].includes(r.intent),
    desc: "tolerância a erros de digitação" },

  { id: "t-2", input: "paguie 30 almoço",
    check: r => r.entries?.[0]?.amount === 30,
    desc: "tolerância a erro ortográfico em verbo" },
];

async function run() {
  console.log(`\n🔍 FinPlanner Blind Test — ${CASES.length} casos\n`);

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
      console.log(`  ❌ [${tc.id}] ${tc.desc}`);
      if (VERBOSE) console.log(`      Input:    "${tc.input}"`);
      console.log(`      Esperado: ${tc.desc}`);
      console.log(`      Recebido: ${JSON.stringify(result).slice(0, 200)}`);
    }
  }

  const score = Math.round((passed / CASES.length) * 100);
  const bar = "█".repeat(Math.floor(score / 5)) + "░".repeat(20 - Math.floor(score / 5));

  console.log(`\n${"─".repeat(50)}`);
  console.log(`📊 Score: ${passed}/${CASES.length} (${score}%)`);
  console.log(`   [${bar}]`);

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
    console.log(`\n⚠️  Score ≥ 90% — ok para deploy (revisar falhas)\n`);
    process.exit(0);
  }
}

run();
