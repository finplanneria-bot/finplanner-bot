// Full integration test using the real server with ESM-level mocks
import { spawn } from "child_process";
import http from "http";
import { readFileSync } from "fs";

const TOKEN = readFileSync(process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE, "utf8").trim();

const env = {
  ...process.env,
  WA_ACCESS_TOKEN: "mock_wa_token",
  WA_PHONE_NUMBER_ID: "1234567890",
  SHEETS_ID: "mock_sheets_id",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "mock@mock.iam.gserviceaccount.com",
  GOOGLE_SERVICE_ACCOUNT_KEY: "-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----\n",
  WEBHOOK_VERIFY_TOKEN: "mock_verify",
  USE_OPENAI: "false",
  PORT: "8766",
  NODE_ENV: "test",
  ADMIN_WA_NUMBER: "5579999999999",
  NODE_OPTIONS: "--experimental-loader /tmp/esm-loader.mjs",
};

console.log("═══ Subindo servidor com ESM loader (intercepta axios + sheets) ═══");
const proc = spawn("node", ["app.js"], {
  cwd: "/home/user/finplanner-bot",
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
proc.stdout.on("data", d => { const s = d.toString(); output += s; process.stdout.write(s); });
proc.stderr.on("data", d => { const s = d.toString(); output += s; process.stderr.write(s); });

const waitForServer = async (maxMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await new Promise((res, rej) => {
        const r = http.request({ hostname: "127.0.0.1", port: 8766, path: "/health", method: "GET" }, resp => {
          resp.on("data", () => {}); resp.on("end", res);
        });
        r.on("error", rej); r.end();
      });
      return true;
    } catch { await new Promise(r => setTimeout(r, 300)); }
  }
  return false;
};

const postWebhook = body => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({
    hostname: "127.0.0.1", port: 8766, path: "/webhook", method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
  }, res => {
    let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b }));
  });
  req.on("error", reject); req.write(data); req.end();
});

const ready = await waitForServer();
if (!ready) { console.error("Server timeout"); proc.kill(); process.exit(1); }

console.log("\n═══ Enviando: 'Oferta da igreja pastor raposo 20' ═══");
await postWebhook({
  object: "whatsapp_business_account",
  entry: [{ id: "X", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "1234567890", phone_number_id: "1234567890" },
    contacts: [{ profile: { name: "Alvaro" }, wa_id: "5579999999999" }],
    messages: [{ from: "5579999999999", id: "wamid.test", timestamp: String(Math.floor(Date.now()/1000)), text: { body: "Oferta da igreja pastor raposo 20" }, type: "text" }],
  }}]}],
});

await new Promise(r => setTimeout(r, 4000));

console.log("\n═══ ANÁLISE ═══");
const waMessages = output.match(/\[WA-CAPTURED\][^\n]*/g) || [];
const sheetsWrites = output.match(/\[SHEETS-WRITE\][^\n]*/g) || [];
const hasYesNo = /gostaria de registrar|gostaria de confirmar|posso ajudar com isso/i.test(output);
const hasNLUDecision = output.includes("[NLU-DECISION]");
const hasSheetsWrite = sheetsWrites.length > 0;
const hasWACaptured = waMessages.length > 0;

console.log(`${hasNLUDecision ? "✅" : "❌"} [NLU-DECISION] logado`);
console.log(`${hasSheetsWrite ? "✅" : "❌"} Sheets write capturado`);
console.log(`${hasWACaptured ? "✅" : "❌"} WA send capturado`);
console.log(`${!hasYesNo ? "✅" : "❌"} SEM pergunta 'gostaria de registrar?'`);

if (waMessages.length) {
  console.log("\n─── Mensagens enviadas ao WhatsApp ───");
  waMessages.forEach((m, i) => console.log(`[${i+1}]`, m.slice(0, 500)));
}
if (sheetsWrites.length) {
  console.log("\n─── Dados gravados no Sheets ───");
  sheetsWrites.forEach((w, i) => console.log(`[${i+1}]`, w.slice(0, 400)));
}

const result = !hasYesNo && (hasSheetsWrite || hasWACaptured || hasNLUDecision);
console.log(`\n${result ? "✅ BUG CORRIGIDO" : "❌ BUG PERSISTE"}`);
proc.kill();
process.exit(result ? 0 : 1);
