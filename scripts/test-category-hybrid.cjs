#!/usr/bin/env node
/**
 * test-category-hybrid.cjs — valida que o heurístico captura morango, oferta, cheque especial.
 * Sem chamadas à OpenAI; só testa as keywords e a estrutura do resolveCategory.
 */

const fs = require("fs");
const path = require("path");

const appJs = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");

// Extrai as keywords da categoria mercado
const mercadoMatch = appJs.match(/slug: "mercado"[\s\S]*?keywords: \[([\s\S]*?)\]/);
if (!mercadoMatch) {
  console.error("❌ Não encontrei keywords de mercado");
  process.exit(1);
}
const mercadoKeywords = mercadoMatch[1]
  .split(",")
  .map((s) => s.trim().replace(/^"|"$/g, ""))
  .filter(Boolean);

const presentesMatch = appJs.match(/slug: "presentes"[\s\S]*?keywords: \[([\s\S]*?)\]/);
const presentesKeywords = presentesMatch[1]
  .split(",")
  .map((s) => s.trim().replace(/^"|"$/g, ""))
  .filter(Boolean);

const bancoMatch = appJs.match(/slug: "banco_financeiro"[\s\S]*?keywords: \[([\s\S]*?)\]/);
const bancoKeywords = bancoMatch[1]
  .split(",")
  .map((s) => s.trim().replace(/^"|"$/g, ""))
  .filter(Boolean);

const requiredMercado = ["morango", "fruta", "banana", "tomate", "arroz", "feijão"];
const requiredPresentes = ["oferta", "dízimo"];
const requiredBanco = ["cheque especial"];

let pass = 0;
let fail = 0;

const normalize = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const detectCategory = (description) => {
  const normalized = normalize(description);
  let best = null;
  let bestLen = 0;
  const check = (slug, keywords) => {
    for (const kw of keywords) {
      const kwNorm = normalize(kw);
      if (kwNorm && kwNorm.length > bestLen && normalized.includes(kwNorm)) {
        best = slug;
        bestLen = kwNorm.length;
      }
    }
  };
  check("mercado", mercadoKeywords);
  check("presentes", presentesKeywords);
  check("banco_financeiro", bancoKeywords);
  return best;
};

const cases = [
  { input: "Morango", expected: "mercado" },
  { input: "morango", expected: "mercado" },
  { input: "Caixa de banana", expected: "mercado" },
  { input: "Tomate", expected: "mercado" },
  { input: "Arroz e feijão", expected: "mercado" },
  { input: "Frutas variadas", expected: "mercado" },
  { input: "Oferta", expected: "presentes" },
  { input: "Oferta na igreja", expected: "presentes" },
  { input: "Dízimo", expected: "presentes" },
  { input: "Cheque especial", expected: "banco_financeiro" },
  { input: "Conta cheque especial", expected: "banco_financeiro" },
];

console.log("--- Detecção heurística de categorias ---");
for (const c of cases) {
  const got = detectCategory(c.input);
  if (got === c.expected) {
    pass++;
    console.log(`✅ "${c.input}" → ${got}`);
  } else {
    fail++;
    console.log(`❌ "${c.input}" → ${got} (esperado: ${c.expected})`);
  }
}

// Verificações estruturais no resolveCategory
const hasHeuristicGuard = /heuristicIsConfident\s*=\s*fallback\?\.\s*slug\s*&&\s*fallback\.slug\s*!==\s*"outros"/.test(appJs);
const hasHeuristicReturn = /if\s*\(heuristicIsConfident\)\s*\{\s*\n\s*return\s*\{\s*slug:\s*fallback\.slug/.test(appJs);
const hasRelatorioGuard = /fallbackIntent\s*===\s*"relatorio_completo"\s*&&\s*\n?\s*isExplicitRelatorio/.test(appJs);

console.log("\n--- Verificações estruturais ---");
console.log(`${hasHeuristicGuard ? "✅" : "❌"} resolveCategory tem heuristicIsConfident flag`);
console.log(`${hasHeuristicReturn ? "✅" : "❌"} resolveCategory retorna slug do heurístico quando confiante`);
console.log(`${hasRelatorioGuard ? "✅" : "❌"} detectIntentWithContext protege relatorio_completo de degradação`);

const ok = pass === cases.length && hasHeuristicGuard && hasHeuristicReturn && hasRelatorioGuard;
console.log(`\n${ok ? "✅ PASSED" : "❌ FAILED"}: ${pass}/${cases.length} testes`);
process.exit(ok ? 0 : 1);
