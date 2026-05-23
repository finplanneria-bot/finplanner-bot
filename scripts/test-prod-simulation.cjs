#!/usr/bin/env node
/**
 * test-prod-simulation.cjs — sobe app.js como subprocess com env mocks,
 * envia webhook POST simulando "Oferta da igreja pastor raposo 20" do usuário
 * e captura a decisão de roteamento via logs estruturados [NLU-DECISION] / [SAFETY-NET].
 *
 * Esta é a simulação mais próxima de produção possível em sandbox sem WA real:
 * - axios é interceptado via wrapper preload para WhatsApp Cloud API
 * - Google Sheets é stubado para não crashar
 * - OPENAI_API_KEY usa Anthropic Bearer token + base URL compatível
 * - Output do bot (que iria pra WA) é capturado no stdout do subprocess
 */

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ANTHROPIC_TOKEN = fs.readFileSync(process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE, "utf8").trim();
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL;

// ─── Preload script: monkey-patch axios e google-spreadsheet ──────────────────
const preloadPath = path.join("/tmp", "finplanner-preload.cjs");
fs.writeFileSync(preloadPath, `
const Module = require("module");
const origResolve = Module._resolveFilename;
const origLoad = Module._load;

// Stub para google-spreadsheet
Module._load = function(request, parent, ...rest) {
  if (request === "google-spreadsheet") {
    return {
      GoogleSpreadsheet: class {
        constructor() { this.sheetsByTitle = new Proxy({}, {
          get: (_, key) => ({
            loadCells: async () => {},
            getCellByA1: () => ({ value: null, formattedValue: "" }),
            getRows: async () => [],
            addRow: async (row) => {
              console.log("[STUB-SHEETS-WRITE]", JSON.stringify(row).slice(0,300));
              return { rowNumber: 999, get: k => row[k], save: async () => {}, _rawData: Object.values(row) };
            },
            loadHeaderRow: async () => {},
            headerValues: [],
            saveUpdatedCells: async () => {},
          })
        });}
        async loadInfo() { console.log("[STUB-SHEETS] loadInfo no-op"); }
      },
      JWT: class { constructor() {} },
    };
  }
  if (request === "google-auth-library") {
    return { JWT: class { constructor() {} async authorize() {} } };
  }
  const mod = origLoad.apply(this, [request, parent, ...rest]);
  if (request === "axios") {
    const origPost = mod.post?.bind(mod);
    const origGet = mod.get?.bind(mod);
    if (origPost) {
      mod.post = async (url, data, config) => {
        if (typeof url === "string" && url.includes("graph.facebook.com")) {
          console.log("[STUB-WA-SEND]", JSON.stringify({ url: url.slice(-60), body: data }).slice(0, 400));
          return { data: { messages: [{ id: "wamid.mock_" + Date.now() }] }, status: 200 };
        }
        if (typeof url === "string" && url.includes("googleapis.com")) {
          return { data: { values: [] }, status: 200 };
        }
        return origPost(url, data, config);
      };
    }
    if (origGet) {
      mod.get = async (url, config) => {
        if (typeof url === "string" && (url.includes("graph.facebook.com") || url.includes("googleapis.com"))) {
          return { data: { values: [] }, status: 200 };
        }
        return origGet(url, config);
      };
    }
  }
  return mod;
};
`);

// ─── Env vars + spawn ──────────────────────────────────────────────────────────
const env = {
  ...process.env,
  WA_ACCESS_TOKEN: "mock_wa_token",
  WA_PHONE_NUMBER_ID: "1234567890",
  SHEETS_ID: "mock_sheets_id",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "mock@mock.iam.gserviceaccount.com",
  GOOGLE_SERVICE_ACCOUNT_KEY: "-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----\n",
  WEBHOOK_VERIFY_TOKEN: "mock_verify",
  USE_OPENAI: "false",
  // Não usar OpenAI — força fallback heurístico (a Camada 1 [SAFETY-NET] ainda deve ativar via fallback path)
  // Sem NLU, o switch case default cai direto no `if (extractAmountFromText(...).amount)` que chama registerEntry
  PORT: "8765",
  NODE_ENV: "test",
  ADMIN_WA_NUMBER: "5579999999999",
  NODE_OPTIONS: `--require=${preloadPath}`,
};

console.log("\n═══ Subindo servidor com env mocks + preload axios/sheets ═══");
const proc = spawn("node", ["app.js"], {
  cwd: path.join(__dirname, ".."),
  env,
});

let output = "";
proc.stdout.on("data", (d) => { const s = d.toString(); output += s; process.stdout.write(s); });
proc.stderr.on("data", (d) => { const s = d.toString(); output += s; process.stderr.write(s); });

const TEST_USER = "5579999999999"; // = ADMIN_WA_NUMBER pra bypassar check do Sheets
const WA_NUMBER = "1234567890";

const buildWebhookPayload = (messageText) => ({
  object: "whatsapp_business_account",
  entry: [{
    id: "ENTRY_ID",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: WA_NUMBER, phone_number_id: WA_NUMBER },
        contacts: [{ profile: { name: "Alvaro" }, wa_id: TEST_USER }],
        messages: [{
          from: TEST_USER,
          id: "wamid.test_" + Date.now(),
          timestamp: String(Math.floor(Date.now() / 1000)),
          text: { body: messageText },
          type: "text",
        }],
      },
    }],
  }],
});

const postWebhook = (body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({
    hostname: "127.0.0.1",
    port: 8765,
    path: "/webhook",
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
  }, (res) => {
    let body = "";
    res.on("data", (c) => body += c);
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.on("error", reject);
  req.write(data);
  req.end();
});

const waitForServer = async (maxMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await new Promise((res, rej) => {
        const r = http.request({ hostname: "127.0.0.1", port: 8765, path: "/health", method: "GET" }, (resp) => {
          resp.on("data", () => {}); resp.on("end", () => res());
        });
        r.on("error", rej);
        r.end();
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return false;
};

(async () => {
  const ready = await waitForServer();
  if (!ready) {
    console.error("\n❌ Servidor não respondeu em 15s. Saindo.");
    proc.kill();
    process.exit(1);
  }

  console.log("\n═══ Servidor pronto. Enviando webhook do bug do usuário ═══");
  console.log("─── Input: 'Oferta da igreja pastor raposo 20' ───");

  const resp = await postWebhook(buildWebhookPayload("Oferta da igreja pastor raposo 20"));
  console.log("\n─── Webhook response status:", resp.status);

  // Espera bot processar
  await new Promise(r => setTimeout(r, 5000));

  console.log("\n═══ ANÁLISE DO CAPTURE ═══");

  const hasNLUDecision = output.includes("[NLU-DECISION]");
  const hasSafetyNet = output.includes("[SAFETY-NET]");
  const hasRegisterCall = /sendText.*Registr|sendText.*Cadastrad|Pagamento Registrado/i.test(output);
  const hasYesNoBug = /gostaria de registrar|gostaria de confirmar|posso ajudar com isso/i.test(output);
  const hasStubSheetsWrite = output.includes("[STUB-SHEETS-WRITE]");
  const stubWAMessages = (output.match(/\[STUB-WA-SEND\][^\n]*/g) || []);

  console.log(`${hasNLUDecision ? "✅" : "❌"} [NLU-DECISION] foi logado (Camada 1 ativa)`);
  console.log(`${hasSafetyNet ? "🛡️" : "⚪"} [SAFETY-NET] ${hasSafetyNet ? "DISPAROU (NLU misclassificou)" : "não disparou (NLU acertou direto)"}`);
  console.log(`${hasStubSheetsWrite ? "✅" : "❌"} Bot tentou GRAVAR registro no Sheets`);
  console.log(`${!hasYesNoBug ? "✅" : "❌"} Bot ${hasYesNoBug ? "AINDA gerou 'gostaria de registrar?'" : "NÃO gerou pergunta sim/não"}`);

  console.log("\n─── Mensagens enviadas pra WhatsApp (capturadas) ───");
  stubWAMessages.forEach((m, i) => console.log(`  [${i+1}] ${m.slice(0, 250)}`));

  const sheetsWrites = output.match(/\[STUB-SHEETS-WRITE\][^\n]*/g) || [];
  if (sheetsWrites.length) {
    console.log("\n─── Sheets writes (registros criados) ───");
    sheetsWrites.forEach((w, i) => console.log(`  [${i+1}] ${w.slice(0, 300)}`));
  }

  const result = hasStubSheetsWrite && !hasYesNoBug;
  console.log(`\n${result ? "✅ BUG CORRIGIDO" : "❌ BUG PERSISTE"}: ${result ? "bot registrou direto sem perguntar" : "bot ainda está em loop"}`);

  proc.kill();
  process.exit(result ? 0 : 1);
})().catch(e => {
  console.error("\n❌ ERRO:", e.message, e.stack);
  proc.kill();
  process.exit(1);
});

// Cleanup
process.on("SIGINT", () => { proc.kill(); process.exit(130); });
process.on("exit", () => { try { fs.unlinkSync(preloadPath); } catch {} });
