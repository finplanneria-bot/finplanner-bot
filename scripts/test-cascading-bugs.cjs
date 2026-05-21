#!/usr/bin/env node
/**
 * test-cascading-bugs.cjs — verifica os 3 bugs cascata do teste de 2026-05-20 23:59–00:02
 *
 * Bug 1: "Oferta da igreja pastor raposo 20" → off_topic (era), agora deve → register/presentes
 * Bug 2: "Sim" após clarificação → "sim sobre o quê?" (era), agora prompt proíbe perguntas de sim/não
 * Bug 3: "Sim o valor é 20" → editava morango (era), agora não dispara inline edit
 */

const fs = require("fs");
const path = require("path");

const appJs = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");

let pass = 0;
let fail = 0;

const check = (label, condition) => {
  if (condition) {
    pass++;
    console.log(`✅ ${label}`);
  } else {
    fail++;
    console.log(`❌ ${label}`);
  }
};

// ─── BUG 3 FIX: inline edit regex não deve capturar "valor e X" sem verbo ─────
console.log("\n─── BUG 3: Inline edit — regex NFD false positive ───");

// Extrai o bloco valorEditMatch do app.js
const editBlock = appJs.slice(
  appJs.indexOf("// Edição em linguagem natural"),
  appJs.indexOf("const dataEditMatch =") + 300
);

// O padrão perigoso NÃO deve mais estar em chamadas .match() (pode aparecer em comentários)
// Verifica que não há .match( com esse padrão — string literal no JS source
const dangerousInCall = /\.match\(\/\\bvalor\\s\+\(\?:e\|eh\|=\)/.test(editBlock);
check(
  "Padrão /\\bvalor\\s+(?:e|eh|=)/ REMOVIDO de chamadas .match()",
  !dangerousInCall
);

// Simular comportamento da regex atual
const normalizeDiacritics = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const valorEditRegex =
  /\b(?:muda|altera|atualiza|corrige|corrigi|coloca|poe|p[oõ]e)r?\s+(?:o\s+)?valor\s+(?:pra|para|pro|p|:)?\s*([\d,\.]+)/;

const testCases = [
  { input: "Sim o valor é 20",           shouldMatch: false, desc: "Sim o valor é 20 (NFD: valor e 20)" },
  { input: "valor é 20",                 shouldMatch: false, desc: "valor é 20 (NFD: valor e 20)" },
  { input: "muda o valor pra 20",        shouldMatch: true,  desc: "muda o valor pra 20 (edit legítimo)" },
  { input: "altera valor para 150",      shouldMatch: true,  desc: "altera valor para 150 (edit legítimo)" },
  { input: "corrige o valor pra 50,50",  shouldMatch: true,  desc: "corrige o valor pra 50,50 (edit legítimo)" },
  { input: "Oferta da igreja 20",        shouldMatch: false, desc: "Oferta da igreja 20 (não é edit)" },
];

for (const tc of testCases) {
  const normalized = normalizeDiacritics(tc.input);
  const matched = valorEditRegex.test(normalized);
  const ok = matched === tc.shouldMatch;
  if (ok) {
    pass++;
    console.log(`✅ "${tc.input}" → ${matched ? "MATCH edit" : "sem match"} (correto)`);
  } else {
    fail++;
    console.log(`❌ "${tc.input}" → ${matched ? "MATCH edit (FALSO POSITIVO!)" : "sem match (FALSO NEGATIVO!)"}`);
  }
}

// ─── BUG 1 FIX: NLU deve ter exemplos de oferta/presentes ─────────────────────
console.log("\n─── BUG 1: NLU exemplos para oferta da igreja ───");

const nluSection = (() => {
  const start = appJs.indexOf("const buildNLUPrompt");
  const end = appJs.indexOf("\nconst ", start + 50);
  return appJs.slice(start, end);
})();

check(
  'NLU tem exemplo: "oferta da igreja 20" → register/presentes',
  /oferta da igreja 20/.test(nluSection)
);
check(
  'NLU tem exemplo: "oferta da igreja pastor raposo 20" → register/presentes',
  /oferta da igreja pastor raposo 20/.test(nluSection)
);
check(
  'NLU tem exemplo: "dízimo 200" → register/presentes',
  /dízimo 200/.test(nluSection)
);
check(
  'NLU tem categoria presentes no CATEGORIAS AMBÍGUAS',
  /oferta.*presentes/.test(nluSection)
);

// ─── BUG 2 FIX: prompt de clarificação proíbe perguntas de sim/não ────────────
console.log("\n─── BUG 2: Clarificação AI — sem perguntas sim/não ───");

const clarStart = appJs.indexOf("const FINPLANNER_CLARIFICATION_PROMPT");
const clarEnd = appJs.indexOf("\nconst ", clarStart + 50);
const clarSection = appJs.slice(clarStart, clarEnd);

check(
  'CLARIFICATION_PROMPT proíbe "quer X?" / "gostaria de Y?"',
  /NUNCA pergunte.*quer X.*gostaria de Y/s.test(clarSection) ||
  /NUNCA.*pergunte.*sim.*n.o/.test(clarSection) ||
  /NUNCA.*pergunt.*gostaria.*beco/.test(clarSection)
);
check(
  'CLARIFICATION_PROMPT tem exemplo de "oferta" → sugere comando',
  /oferta.*Me manda|oferta.*Oferta/.test(clarSection)
);
check(
  'CLARIFICATION_PROMPT tem instrução: máximo 2 linhas (era 3)',
  /M.ximo 2 linhas/.test(clarSection)
);

// ─── BUG 1 + heurístico de categoria ──────────────────────────────────────────
console.log("\n─── BUG 1: Heurístico de categoria — oferta → presentes ───");

const presMatch = appJs.match(/slug: "presentes"[\s\S]*?keywords: \[([\s\S]*?)\]/);
if (presMatch) {
  const presKws = presMatch[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  check('"oferta" nas keywords de presentes', presKws.includes("oferta"));
  check('"dízimo" nas keywords de presentes', presKws.includes("dízimo") || presKws.includes("dizimo"));
} else {
  fail++;
  console.log("❌ Não encontrou CATEGORY_DEFINITIONS presentes");
}

// ─── SESSÃO 19 — 3 camadas defensivas contra "gostaria de registrar?" loops ───
console.log("\n─── SESSÃO 19: 3 camadas defensivas ───");

// Camada 1 — Safety net no switch default
const switchDefault = appJs.slice(
  appJs.lastIndexOf("    default: {"),
  appJs.indexOf("\n}", appJs.lastIndexOf("    default: {")) + 2
);
check(
  "Camada 1: switch default tem [SAFETY-NET] log",
  /\[SAFETY-NET\]/.test(switchDefault)
);
check(
  "Camada 1: safety net testa off_topic/unknown + amount + length >= 8",
  /off_topic.*unknown[\s\S]*safetyAmt > 0[\s\S]*trimmed\.length >= 8/.test(switchDefault) ||
  /off_topic.*unknown[\s\S]*safetyAmt/.test(switchDefault)
);
check(
  "Camada 1: safety net chama registerEntry no override",
  /SAFETY-NET[\s\S]*?registerEntry/.test(switchDefault)
);
check(
  "Camada 1: tem log [NLU-DECISION] para diagnóstico",
  /\[NLU-DECISION\]/.test(switchDefault)
);
check(
  "Camada 1: safety net exige !nluDef.entries?.length (guard extra)",
  /!nluDef\.entries\?\.length/.test(switchDefault)
);

// Camada 2 — FINPLANNER_CAPABILITIES_PROMPT proíbe sim/não
const capStart = appJs.indexOf("const FINPLANNER_CAPABILITIES_PROMPT");
const capEnd = appJs.indexOf("`.trim();", capStart) + 9;
const capSection = appJs.slice(capStart, capEnd);
check(
  'Camada 2: CAPABILITIES_PROMPT proíbe "quer X?" / "gostaria de Y?"',
  /NUNCA pergunte[\s\S]*quer X[\s\S]*gostaria de Y/.test(capSection)
);
check(
  'Camada 2: CAPABILITIES_PROMPT exige exemplo concreto pra copiar',
  /CONCRETO PRA COPIAR|concreto.*copiar/i.test(capSection)
);
check(
  "Camada 2: CAPABILITIES_PROMPT reduzido para máx 2 linhas",
  /máximo 2 linhas/i.test(capSection)
);

// Camada 3 — NLU bias para register
check(
  "Camada 3: NLU tem regra BIAS PRO REGISTER",
  /BIAS PRO REGISTER/.test(nluSection)
);
check(
  "Camada 3: NLU lista substantivos financeiros (oferta, cobrança, dízimo)",
  /oferta.*cobrança.*dízimo|oferta, cobrança/i.test(nluSection)
);
check(
  "Camada 3: NLU explicita exclusão de 'pessoas no estádio'",
  /50 mil pessoas no est[áa]dio/i.test(nluSection)
);

// ─── Resultado ─────────────────────────────────────────────────────────────────
const total = pass + fail;
console.log(`\n${fail === 0 ? "✅ PASSED" : "❌ FAILED"}: ${pass}/${total} verificações`);
process.exit(fail === 0 ? 0 : 1);
