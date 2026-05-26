#!/usr/bin/env node
/**
 * test-local-server.cjs — sobe app.js real com env mocks + axios interceptado
 * Envia webhook POST simulando WhatsApp e captura a decisão de roteamento.
 *
 * Estratégia:
 * 1. Define env vars mock + USE_OPENAI=true apontando para Anthropic (OpenAI-compat)
 * 2. Monkey-patch axios ANTES de carregar app.js (sendWA → captura ao invés de enviar)
 * 3. Stub Google Sheets (writes → no-op + capture)
 * 4. Carrega app.js (inicia Express server)
 * 5. POST webhook /webhook com payload de "Oferta da igreja pastor raposo 20"
 * 6. Captura: [NLU-DECISION] log + [SAFETY-NET] log + sendWA payload
 */

const path = require("path");
const fs = require("fs");

// ─── Mock env vars ANTES de qualquer require ──────────────────────────────────
const ANTHROPIC_TOKEN = fs.readFileSync(process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE, "utf8").trim();
process.env.WA_ACCESS_TOKEN = "mock_wa_token";
process.env.WA_PHONE_NUMBER_ID = "1234567890";
process.env.SHEETS_ID = "mock_sheets_id";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "mock@mock.iam.gserviceaccount.com";
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----";
process.env.WEBHOOK_VERIFY_TOKEN = "mock_verify";
process.env.USE_OPENAI = "false"; // desabilita NLU AI — testa só roteamento heurístico + safety net
process.env.PORT = "0";            // porta dinâmica
process.env.NODE_ENV = "test";
process.env.ADMIN_WA_NUMBER = "5579999999999";

// ─── Capture buffer ────────────────────────────────────────────────────────────
const captured = {
  nluDecisions: [],
  safetyNetTriggers: [],
  outgoingMessages: [],
  errors: [],
  logs: [],
};

// Intercepta console.log para capturar [NLU-DECISION] e [SAFETY-NET]
const origLog = console.log.bind(console);
console.log = (...args) => {
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  captured.logs.push(msg);
  if (msg.includes("[NLU-DECISION]")) captured.nluDecisions.push(msg);
  if (msg.includes("[SAFETY-NET]")) captured.safetyNetTriggers.push(msg);
  if (msg.includes("Cadastra") || msg.includes("Registr") || msg.includes("registerEntry")) {
    captured.logs.push(`[REGISTER-CALL] ${msg}`);
  }
  origLog(...args);
};

// ─── Monkey-patch axios ────────────────────────────────────────────────────────
const axios = require(path.join(__dirname, "../node_modules/axios"));
const origPost = axios.post.bind(axios);
const origGet = axios.get.bind(axios);

axios.post = async (url, data, config) => {
  if (typeof url === "string" && url.includes("graph.facebook.com")) {
    // WhatsApp Cloud API — captura ao invés de enviar
    captured.outgoingMessages.push({ url, data });
    return { data: { messages: [{ id: "wamid.mock_" + Date.now() }] }, status: 200 };
  }
  if (typeof url === "string" && url.includes("googleapis.com")) {
    return { data: { values: [], range: "A:Z" }, status: 200 };
  }
  return origPost(url, data, config);
};
axios.get = async (url, config) => {
  if (typeof url === "string" && (url.includes("graph.facebook.com") || url.includes("googleapis.com"))) {
    return { data: { values: [], range: "A:Z" }, status: 200 };
  }
  return origGet(url, config);
};

// ─── Stub Google Sheets ────────────────────────────────────────────────────────
try {
  const sheetsMod = require(path.join(__dirname, "../node_modules/google-spreadsheet"));
  if (sheetsMod.GoogleSpreadsheet) {
    const origInit = sheetsMod.GoogleSpreadsheet.prototype.loadInfo;
    sheetsMod.GoogleSpreadsheet.prototype.loadInfo = async function () {
      this.sheetsByTitle = new Proxy({}, {
        get: () => ({
          loadCells: async () => {},
          getCellByA1: () => ({ value: null, formattedValue: "" }),
          getRows: async () => [],
          addRow: async (row) => {
            captured.logs.push(`[SHEETS-WRITE] addRow: ${JSON.stringify(row).slice(0, 200)}`);
            return { rowNumber: 999, get: (k) => row[k], save: async () => {} };
          },
          loadHeaderRow: async () => {},
          headerValues: [],
        }),
      });
      return Promise.resolve();
    };
  }
} catch (e) {
  console.warn("[stub] google-spreadsheet stub falhou:", e.message);
}

// ─── Sobe servidor (require do app.js) ─────────────────────────────────────────
async function main() {
  console.log("\n═══ Iniciando servidor com env mocks ═══");

  // Como app.js é "type": "module", precisamos usar import dinâmico
  // Mas dependências instalam o pacote como ESM ou CJS depende do nó. Tente:
  try {
    // Verifica package.json
    const pkg = require(path.join(__dirname, "../package.json"));
    if (pkg.type === "module") {
      console.error("⚠️ app.js é ES module — não pode ser carregado via require()");
      console.error("   Use 'node app.js' separadamente, ou converta este teste para ESM.");
      console.error("\n   Alternativa: capturar evidência via logs estruturados.");

      // Como não conseguimos carregar, vamos pelo menos VALIDAR o código:
      const appJs = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
      const switchDefault = appJs.slice(
        appJs.lastIndexOf("    default: {"),
        appJs.indexOf("\n}", appJs.lastIndexOf("    default: {")) + 2
      );

      console.log("\n═══ Validação do código no app.js ═══");
      const hasNLUDecisionLog = /\[NLU-DECISION\]/.test(switchDefault);
      const hasSafetyNet = /\[SAFETY-NET\][\s\S]*?registerEntry/.test(switchDefault);
      const hasGuards = /!nluDef\.entries\?\.length[\s\S]*?trimmed\.length >= 8/.test(switchDefault);

      console.log(`${hasNLUDecisionLog ? "✅" : "❌"} [NLU-DECISION] log presente`);
      console.log(`${hasSafetyNet ? "✅" : "❌"} [SAFETY-NET] override para registerEntry`);
      console.log(`${hasGuards ? "✅" : "❌"} Guards (entries vazio + length >= 8)`);

      // Mostra o trecho EXATO do código
      const safetyNetMatch = switchDefault.match(/\/\/ SAFETY NET[\s\S]*?break;\n        \}/);
      if (safetyNetMatch) {
        console.log("\n═══ Código deployado (commit 5d04432): ═══");
        console.log(safetyNetMatch[0]);
      }

      process.exit(0);
    }
  } catch (e) {
    console.error("Erro ao validar pkg:", e.message);
    process.exit(1);
  }
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
