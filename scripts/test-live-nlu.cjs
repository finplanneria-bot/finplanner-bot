#!/usr/bin/env node
/**
 * test-live-nlu.cjs — verificação ao vivo das 3 correções de bugs usando Claude Haiku
 *
 * Usa o mesmo sistema de prompt do buildNLUPrompt() e do FINPLANNER_CLARIFICATION_PROMPT
 * para verificar que os 3 bugs do teste de 2026-05-20 estão corrigidos.
 *
 * Uso: node scripts/test-live-nlu.cjs
 */

const fs = require("fs");
const https = require("https");
const path = require("path");

const appJs = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const TOKEN = fs.readFileSync(process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE, "utf8").trim();
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const MODEL = "claude-haiku-4-5-20251001";

// ─── Extract NLU system prompt from app.js ────────────────────────────────────
const extractNLUPrompt = () => {
  const fnStart = appJs.indexOf("const buildNLUPrompt = (text) => {");
  const fnEnd = appJs.indexOf("\n};\n", fnStart) + 4;
  const fn = appJs.slice(fnStart, fnEnd);
  const sysStart = fn.indexOf("text: `") + 7;
  const sysEnd = fn.lastIndexOf("`,\n      }]\n    },");
  const raw = fn.slice(sysStart, sysEnd);
  const today = new Date().toISOString().slice(0, 10);
  return raw.replace("${today}", today).replace("${today.slice(0,8)}20", today.slice(0, 8) + "20");
};

// ─── Extract CLARIFICATION_PROMPT from app.js ─────────────────────────────────
const extractClarificationPrompt = () => {
  const start = appJs.indexOf("const FINPLANNER_CLARIFICATION_PROMPT = `") + 41;
  const end = appJs.indexOf("`.trim();", start);
  const raw = appJs.slice(start, end);
  // Fill in template literals
  return raw
    .replace(/\$\{CAPABILITIES_MANIFEST\.nome\}/g, "FinPlanner IA")
    .replace(/\$\{CAPABILITIES_MANIFEST\.descricao\}/g, "assistente financeiro pessoal")
    .replace(/\$\{buildCapabilitiesText\(\)\}/g, "[capabilities text]")
    .replace(/\$\{CAPABILITIES_MANIFEST\.suporte\.whatsapp\}/g, "https://wa.me/5579991249561")
    .replace(/\$\{CAPABILITIES_MANIFEST\.suporte\.email\}/g, "finplanneria@gmail.com");
};

// ─── HTTP client for Anthropic API ───────────────────────────────────────────
const callAnthropic = (systemPrompt, userMessage, maxTokens = 500) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    const parsed = new URL(ANTHROPIC_BASE_URL);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "authorization": `Bearer ${TOKEN}`,
        "content-length": Buffer.byteLength(body),
      },
    };
    const req = (parsed.protocol === "https:" ? https : require("http")).request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed2 = JSON.parse(data);
          resolve(parsed2.content?.[0]?.text || "");
        } catch (e) {
          reject(new Error("Parse error: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const nluPrompt = extractNLUPrompt();
  const clarPrompt = extractClarificationPrompt();

  let pass = 0;
  let fail = 0;
  const check = (label, cond, got) => {
    if (cond) {
      pass++;
      console.log(`✅ ${label}`);
    } else {
      fail++;
      console.log(`❌ ${label}`);
      if (got) console.log(`   → resposta: ${got.slice(0, 200)}`);
    }
  };

  // ── BUG 1: "Oferta da igreja pastor raposo 20" → deve ser register/presentes ──
  console.log("\n─── BUG 1: Oferta da igreja pastor raposo 20 → register/presentes ───");
  {
    const raw = await callAnthropic(nluPrompt, "Oferta da igreja pastor raposo 20");
    console.log(`   NLU respondeu: ${raw.slice(0, 200)}`);
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
    } catch {
      parsed = {};
    }
    check(
      '"Oferta da igreja pastor raposo 20" → intent=register',
      parsed.intent === "register",
      raw
    );
    check(
      '"Oferta da igreja pastor raposo 20" → category=presentes',
      parsed.entries?.[0]?.category === "presentes",
      raw
    );
    check(
      '"Oferta da igreja pastor raposo 20" → amount=20',
      parsed.entries?.[0]?.amount === 20,
      raw
    );
    check(
      '"Oferta da igreja pastor raposo 20" → NÃO é off_topic',
      parsed.intent !== "off_topic",
      raw
    );
  }

  // ── BUG 1b: Variação "Oferta da igreja pastos 20" ─────────────────────────
  console.log("\n─── BUG 1b: Variação com typo ───");
  {
    const raw = await callAnthropic(nluPrompt, "Oferta da igreja pastos 20");
    console.log(`   NLU respondeu: ${raw.slice(0, 200)}`);
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
    } catch {
      parsed = {};
    }
    check(
      '"Oferta da igreja pastos 20" → intent=register (não off_topic)',
      parsed.intent === "register",
      raw
    );
    check(
      '"Oferta da igreja pastos 20" → category=presentes',
      parsed.entries?.[0]?.category === "presentes",
      raw
    );
  }

  // ── BUG 3: inline edit — "Sim o valor é 20" NÃO deve casar regex de edição ─
  console.log("\n─── BUG 3: Inline edit regex — NFD false positive corrigido ───");
  {
    const normalizeDiacritics = (s) =>
      s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const valorEditRegex =
      /\b(?:muda|altera|atualiza|corrige|corrigi|coloca|poe|p[oõ]e)r?\s+(?:o\s+)?valor\s+(?:pra|para|pro|p|:)?\s*([\d,\.]+)/;

    const inputs = [
      { text: "Sim o valor é 20",    shouldMatch: false },
      { text: "valor é 20",          shouldMatch: false },
      { text: "muda o valor pra 20", shouldMatch: true  },
      { text: "Oferta da igreja 20", shouldMatch: false },
    ];
    for (const tc of inputs) {
      const m = valorEditRegex.test(normalizeDiacritics(tc.text));
      check(
        `"${tc.text}" → ${tc.shouldMatch ? "MATCH (edit)" : "sem match (não edit)"}`,
        m === tc.shouldMatch
      );
    }
  }

  // ── BUG 2: Clarification prompt NÃO gera perguntas sim/não ──────────────────
  console.log("\n─── BUG 2: Clarificação AI — sem dead-end sim/não ───");
  {
    const raw = await callAnthropic(clarPrompt, 'Usuário disse: "Oferta da igreja pastos 20"', 150);
    console.log(`   Clarificação respondeu: ${raw.slice(0, 300)}`);
    const lower = raw.toLowerCase();
    const hasYesNoQ = /gostaria|quer registrar\?|você quer\?|deseja\?|confirmar o valor\?/i.test(raw);
    const hasCommand = /me manda|tenta|oferta|mande|registrar.*20|20.*oferta/i.test(raw);
    check(
      'Resposta NÃO faz pergunta sim/não ("gostaria de confirmar?")',
      !hasYesNoQ,
      raw
    );
    check(
      'Resposta sugere um comando concreto para copiar',
      hasCommand,
      raw
    );
  }

  // ── Resultado ──────────────────────────────────────────────────────────────
  const total = pass + fail;
  console.log(`\n${fail === 0 ? "✅ PASSED" : "❌ FAILED"}: ${pass}/${total} verificações ao vivo`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Erro:", e.message);
  process.exit(1);
});
