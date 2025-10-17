// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-17.5)
// ============================
// Correção: autenticação Google Sheets (sem erro “No key or keyFile set”)
// Inclui: reconhecimento natural de frases, botões interativos Pix/Boleto/Confirmar, mensagens visuais.

// ----------------------------
// Importação de bibliotecas
// ----------------------------
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import OpenAI from "openai";
import cron from "node-cron";
import crypto from "crypto";

// ----------------------------
// Carrega variáveis de ambiente
// ----------------------------
dotenv.config();

const app = express();
app.use(bodyParser.json());

// ----------------------------
// Config - WhatsApp Cloud API
// ----------------------------
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;

// ----------------------------
// Config - OpenAI (intenção opcional)
// ----------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_OPENAI = (process.env.USE_OPENAI || "false").toLowerCase() === "true";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ----------------------------
// Config - Google Sheets (modo seguro e universal)
// ----------------------------
const SHEETS_ID = process.env.SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

// Corrige chaves com \n literais
let GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}

// Cria autenticação segura (modo compatível universal)
let doc;
try {
  const jwt = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  // google-spreadsheet v4
  doc = new GoogleSpreadsheet(SHEETS_ID, jwt);
} catch (e) {
  console.warn("Tentando fallback v3:", e.message);
  // google-spreadsheet v3
  doc = new GoogleSpreadsheet(SHEETS_ID);
}

// Autenticação segura para ambos os modos
async function ensureAuth() {
  try {
    if (doc && typeof doc.useServiceAccountAuth === "function") {
      await doc.useServiceAccountAuth({
        client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: GOOGLE_SERVICE_ACCOUNT_KEY,
      });
    }
    await doc.loadInfo();
    console.log("✅ Autenticado com sucesso no Google Sheets!");
  } catch (e) {
    console.error("❌ Erro ao autenticar Google Sheets:", e.message);
  }
}

// ----------------------------
// Utilitários
// ----------------------------
function formatBRDate(date) {
  if (!date) return "—";
  const d = new Date(date);
  return d.toLocaleDateString("pt-BR");
}

function toISODate(date) {
  if (!date) return "";
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function formatCurrencyBR(v) {
  try {
    return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  } catch {
    return `R$ ${Number(v).toFixed(2)}`;
  }
}

function parseCurrencyBR(text) {
  const t = text.replace(/\s+/g, " ").toLowerCase();
  const match = t.match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?\s*(reais|real|rs|r\$)?/i);
  if (!match) return null;
  const inteiro = match[1].replace(/\./g, "");
  const centavos = match[2] || "00";
  return parseFloat(`${inteiro}.${centavos}`);
}

function detectBarcode(text) {
  const m = text.replace(/\n/g, " ").match(/[0-9\.\s]{30,}/);
  return m ? m[0].trim().replace(/\s+/g, " ") : null;
}

function detectPixKey(text) {
  const hasPix = /\bpix\b/i.test(text);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone = text.match(/\+?\d{10,14}/);
  const cpf = text.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
  const cnpj = text.match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/);
  const chave = text.match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);
  const candidate = email?.[0] || phone?.[0] || cpf?.[0] || cnpj?.[0] || chave?.[0];
  return hasPix && candidate ? candidate : null;
}

function parseDueDate(text) {
  const now = new Date();
  const dmY = text.match(/(\b\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dmY) {
    let [_, d, m, y] = dmY;
    const year = y ? (y.length === 2 ? 2000 + parseInt(y) : parseInt(y)) : now.getFullYear();
    return new Date(year, parseInt(m) - 1, parseInt(d));
  }
  if (/\bamanh[aã]\b/i.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (/\bhoje\b/i.test(text)) return now;
  return null;
}

function guessBillName(text) {
  const labels = ["energia", "luz", "água", "agua", "internet", "aluguel", "telefone", "cartão", "cartao"];
  const lower = text.toLowerCase();
  for (const l of labels) if (lower.includes(l)) return l.charAt(0).toUpperCase() + l.slice(1);
  const who = text.match(/\b(?:pra|para|ao|a|à)\s+([\wÁÉÍÓÚÂÊÔÃÕÇ]+)/i);
  if (who) return who[1];
  return lower.split(/\s+/).slice(0, 3).join(" ");
}

function uuidShort() {
  return crypto.randomBytes(6).toString("hex");
}

// ----------------------------
// WhatsApp - envio
// ----------------------------
async function sendWA(payload) {
  try {
    await axios.post(WA_API, payload, {
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Erro ao enviar mensagem WA:", e.response?.data || e.message);
  }
}

async function sendText(to, text) {
  return sendWA({ messaging_product: "whatsapp", to, type: "text", text: { body: text } });
}

async function sendCopyButton(to, title, copyText, buttonTitle) {
  return sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: title },
      action: { buttons: [{ type: "copy_code", copy_code: copyText, title: buttonTitle }] },
    },
  });
}

async function sendConfirmButton(to, rowId) {
  return sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Quando pagar, toque abaixo para confirmar:" },
      action: {
        buttons: [{ type: "reply", reply: { id: `CONFIRMAR:${rowId}`, title: "✅ Confirmar pagamento" } }],
      },
    },
  });
}

// ----------------------------
// Google Sheets
// ----------------------------
async function ensureSheet() {
  await ensureAuth();
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle["finplanner"];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: "finplanner",
      headerValues: ["row_id", "timestamp", "user", "tipo", "conta", "valor", "vencimento_iso", "vencimento_br", "tipo_pagamento", "codigo_pagamento", "status"],
    });
  }
  return sheet;
}

async function addBillRow({ user, conta, valor, vencimento, tipo_pagamento, codigo_pagamento, natureza }) {
  const sheet = await ensureSheet();
  const id = uuidShort();
  await sheet.addRow({
    row_id: id,
    timestamp: new Date().toISOString(),
    user,
    tipo: natureza,
    conta,
    valor,
    vencimento_iso: toISODate(vencimento),
    vencimento_br: formatBRDate(vencimento),
    tipo_pagamento,
    codigo_pagamento,
    status: "pendente",
  });
  return id;
}

async function findRowById(rowId) {
  const sheet = await ensureSheet();
  const rows = await sheet.getRows();
  return rows.find(r => r.get("row_id") === rowId) || null;
}

// ----------------------------
// Processamento principal
// ----------------------------
function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(oi|olá|ola|opa|bom dia|boa tarde|boa noite)\b/.test(lower)) return "boas_vindas";
  if (/\b(pagar|vou pagar|transferir|enviar)\b/.test(lower)) return "nova_conta";
  if (/\b(receber|recebimento|cobrar)\b/.test(lower)) return "novo_recebimento";
  if (/\bconfirm(ar)? pagamento|paguei|pago\b/.test(lower)) return "confirmar_pagamento";
  return "desconhecido";
}

function extractEntities(text) {
  const conta = guessBillName(text);
  const valor = parseCurrencyBR(text);
  const vencimento = parseDueDate(text);
  const pix = detectPixKey(text);
  const boleto = pix ? null : detectBarcode(text);
  let tipo_pagamento = "", codigo_pagamento = "";
  if (pix) { tipo_pagamento = "pix"; codigo_pagamento = pix; }
  else if (boleto) { tipo_pagamento = "boleto"; codigo_pagamento = boleto; }
  return { conta, valor, vencimento, tipo_pagamento, codigo_pagamento };
}

async function handleUserText(from, text) {
  const intent = detectIntent(text);

  if (intent === "boas_vindas") {
    await sendText(from, "👋 *Bem-vindo(a) à FinPlanner IA!*\nEnvie algo como:\n💡 Pagar água 80 reais amanhã\n💸 Receber 150 de João na sexta");
    return;
  }

  if (intent === "nova_conta" || intent === "novo_recebimento") {
    const { conta, valor, vencimento, tipo_pagamento, codigo_pagamento } = extractEntities(text);
    const natureza = intent === "novo_recebimento" ? "conta_receber" : "conta_pagar";
    const rowId = await addBillRow({ user: from, conta, valor, vencimento, tipo_pagamento, codigo_pagamento, natureza });
    await sendText(from, `✅ ${natureza === "conta_pagar" ? "Conta" : "Recebimento"} salvo!\n💡 ${conta}\n💰 ${formatCurrencyBR(valor)}\n📅 ${formatBRDate(vencimento)}`);
    if (tipo_pagamento === "pix") await sendCopyButton(from, "💳 Chave Pix:", codigo_pagamento, "Copiar chave Pix");
    if (tipo_pagamento === "boleto") await sendCopyButton(from, "🧾 Código de barras:", codigo_pagamento, "Copiar código");
    if (natureza === "conta_pagar") await sendConfirmButton(from, rowId);
    return;
  }

  if (intent === "confirmar_pagamento") {
    const sheet = await ensureSheet();
    const rows = await sheet.getRows();
    const row = rows.find(r => r.get("user") === from && r.get("status") !== "pago");
    if (row) {
      row.set("status", "pago");
      await row.save();
      await sendText(from, "✅ Pagamento confirmado! Tudo certo.");
    } else await sendText(from, "👍 Nenhuma conta pendente encontrada.");
    return;
  }

  await sendText(from, "🤔 *Não consegui entender seu comando.*\n\nTente algo como:\n💰 Pagar R$150 ao Álvaro no dia 30/10\n📅 Meus pagamentos\n💸 Pix chave 123e456...");
}

// ----------------------------
// Webhook
// ----------------------------
app.get("/webhook", (req, res) => {
  const token = process.env.WEBHOOK_VERIFY_TOKEN || "verify_token";
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === token)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.object && body.entry)
      for (const entry of body.entry)
        for (const change of entry.changes || [])
          for (const msg of change.value?.messages || []) {
            const from = msg.from;
            if (msg.type === "text") await handleUserText(from, msg.text.body);
            if (msg.type === "interactive") {
              const id = msg.interactive?.button_reply?.id;
              if (id?.startsWith("CONFIRMAR:")) {
                const rowId = id.split("CONFIRMAR:")[1];
                const row = await findRowById(rowId);
                if (row) {
                  row.set("status", "pago");
                  await row.save();
                  await sendText(from, "✅ Pagamento confirmado!");
                }
              }
            }
          };
    res.sendStatus(200);
  } catch (e) {
    console.error("Erro no webhook:", e.message);
    res.sendStatus(200);
  }
});

// ----------------------------
// Inicialização
// ----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FinPlanner IA rodando na porta ${PORT}`));
