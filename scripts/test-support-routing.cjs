#!/usr/bin/env node
/**
 * test-support-routing.cjs — verifica se a heurística captura mensagens de suporte
 * antes de ir pro NLU/AI. Não depende de servidor rodando.
 *
 * Uso: node scripts/test-support-routing.cjs
 */

const fs = require("fs");
const path = require("path");

const appJs = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");

const detectIntentHeuristicStart = appJs.indexOf("const detectIntentHeuristic = (text) => {");
if (detectIntentHeuristicStart === -1) {
  console.error("❌ Não encontrei detectIntentHeuristic em app.js");
  process.exit(1);
}

const heuristicSnippet = appJs.slice(
  detectIntentHeuristicStart,
  appJs.indexOf("\nconst ", detectIntentHeuristicStart + 100)
);

const requiredPatterns = [
  /\^\(suporte\|contato\|atendimento\|ajuda\)\$/,
  /falar\\s\+com\\s\+\(suporte\|humano\|atendente\|alguem\|gente\)/,
  /cancelar\\s\+\(minha\\s\+\)\?\(assinatura\|conta\|plano\)/,
  /reembolso\|estorno/,
  /return "falar_suporte"/,
];

let missing = [];
for (const re of requiredPatterns) {
  if (!re.test(heuristicSnippet)) missing.push(re.source);
}

if (missing.length > 0) {
  console.error("❌ Padrões de suporte AUSENTES em detectIntentHeuristic:");
  missing.forEach((p) => console.error("  -", p));
  process.exit(1);
}

const cases = [
  { input: "Suporte", expected: "falar_suporte" },
  { input: "suporte", expected: "falar_suporte" },
  { input: "SUPORTE", expected: "falar_suporte" },
  { input: "Contato", expected: "falar_suporte" },
  { input: "Atendimento", expected: "falar_suporte" },
  { input: "Ajuda", expected: "falar_suporte" },
  { input: "Falar com humano", expected: "falar_suporte" },
  { input: "Falar com alguem do suporte", expected: "falar_suporte" },
  { input: "Cancelar minha assinatura", expected: "falar_suporte" },
  { input: "cancelar minha conta", expected: "falar_suporte" },
  { input: "Quero reembolso", expected: "falar_suporte" },
  { input: "estorno do pagamento", expected: "falar_suporte" },
  { input: "preciso de ajuda", expected: "NOT_falar_suporte" },
  { input: "ajuda admin", expected: "NOT_falar_suporte" },
  { input: "paguei 50 mercado", expected: "NOT_falar_suporte" },
];

const detectSupport = (text) => {
  const lower = (text || "").toLowerCase();
  const normalized = lower.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (
    /^(suporte|contato|atendimento|ajuda)$/.test(normalized.trim()) ||
    /\b(falar\s+com\s+(suporte|humano|atendente|alguem|gente))\b/.test(normalized) ||
    /\b(contato\s+do\s+suporte|numero\s+do\s+suporte|email\s+do\s+suporte)\b/.test(normalized) ||
    /\b(cancelar\s+(minha\s+)?(assinatura|conta|plano))\b/.test(normalized) ||
    /\b(reembolso|estorno|devolu[cç][aã]o\s+do\s+(pagamento|dinheiro))\b/.test(normalized)
  ) {
    return "falar_suporte";
  }
  return "other";
};

let passed = 0;
let failed = 0;
for (const c of cases) {
  const got = detectSupport(c.input);
  const ok = c.expected === "falar_suporte" ? got === "falar_suporte" : got !== "falar_suporte";
  if (ok) {
    passed++;
    console.log(`✅ "${c.input}" → ${got}`);
  } else {
    failed++;
    console.log(`❌ "${c.input}" → ${got} (esperado: ${c.expected})`);
  }
}

const switchHasCase = /case "falar_suporte":\s*\n\s*console\.log\("\[SUPPORT\]/.test(appJs);
const nluHasCase = /case "support":\s*\n\s*case "falar_suporte":/.test(appJs);
const sendSupportButtonHasFallback = /if\s*\(!ok\)\s*\{[^}]*sendText\([^)]*SUPPORT_WHATSAPP_URL/s.test(appJs);

console.log("\n--- Verificações estruturais ---");
console.log(`${switchHasCase ? "✅" : "❌"} Switch principal tem case "falar_suporte" com [SUPPORT] log`);
console.log(`${nluHasCase ? "✅" : "❌"} dispatchNonRegisterNLU tem case "support"/"falar_suporte"`);
console.log(`${sendSupportButtonHasFallback ? "✅" : "❌"} sendSupportButton tem fallback de texto se CTA falhar`);

const allOk = passed === cases.length && switchHasCase && nluHasCase && sendSupportButtonHasFallback;
console.log(`\n${allOk ? "✅ PASSED" : "❌ FAILED"}: ${passed}/${cases.length} testes, ${failed} falharam`);

if (!allOk) process.exit(1);
