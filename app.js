// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-17.3)
// ============================
// Correção: Autenticação do Google Sheets com useServiceAccountAuth()
// Inclui: reconhecimento natural, botões Pix/Boleto/Confirmar, mensagens visuais.

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
// Config - OpenAI (apenas intenção)
// ----------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_OPENAI = (process.env.USE_OPENAI || "false").toLowerCase() === "true";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ----------------------------
// Config - Google Sheets (com autenticação correta)
// ----------------------------
const SHEETS_ID = process.env.SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_SERVICE_ACCOUNT_KEY = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n");

const jwt = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: GOOGLE_SERVICE_ACCOUNT_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SHEETS_ID);

// Função de autenticação explícita
async function ensureAuth() {
  if (!doc.authMode) {
    await doc.useServiceAccountAuth({
      client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: GOOGLE_SERVICE_ACCOUNT_KEY,
    });
  }
}

// ----------------------------
// Utilitários
// ----------------------------
const BR_TZ = "America/Maceio";

function brNow() {
  return new Date();
}

function formatBRDate(date) {
  if (!date) return "—";
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
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
  const realWord = t.match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?\s*(reais|real|rs|r\$)?/i);
  if (!realWord) return null;
  const inteiro = realWord[1]?.replace(/\./g, "");
  const centavos = realWord[2] || "00";
  const num = parseFloat(`${inteiro}.${centavos}`);
  return isNaN(num) ? null : num;
}

function detectBarcode(text) {
  const clean = text.replace(/\n/g, " ");
  const m = clean.match(/[0-9\.\s]{30,}/);
  return m ? m[0].trim().replace(/\s+/g, " ") : null;
}

function detectPixKey(text) {
  const hasPixWord = /\bpix\b/i.test(text);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone = text.match(/\+?\d{10,14}/);
  const cpf = text.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
  const cnpj = text.match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/);
  const chaveAleatoria = text.match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);
  const candidate = email?.[0] || phone?.[0] || cpf?.[0] || cnpj?.[0] || chaveAleatoria?.[0];
  return hasPixWord && candidate ? candidate : null;
}

function parseRelativeDate(text) {
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const now = brNow();
  if (/\bhoje\b/.test(lower)) return new Date(now.setHours(0,0,0,0));
  if (/\bamanha\b/.test(lower) || /\bamanhã\b/.test(text.toLowerCase())) {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(0,0,0,0); return d;
  }
  const weekdays = ["domingo","segunda","terca","terça","quarta","quinta","sexta","sabado","sábado"];
  for (let i=0; i<weekdays.length; i++) {
    if (lower.includes(weekdays[i])) {
      const day = i % 7;
      const d = new Date(now);
      const add = (day - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + add);
      d.setHours(0,0,0,0);
      return d;
    }
  }
  return null;
}

function parseDueDate(text) {
  const dmY = text.match(/(\b\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dmY) {
    let [_, d, m, y] = dmY;
    d = parseInt(d, 10); m = parseInt(m, 10) - 1;
    const now = brNow();
    const year = y ? (y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10)) : now.getFullYear();
    return new Date(year, m, d, 0, 0, 0, 0);
  }
  const rel = parseRelativeDate(text);
  if (rel) return rel;
  const venceDia = text.match(/vencimento\s*(\d{1,2})/i);
  if (venceDia) {
    const d = parseInt(venceDia[1], 10);
    const now = brNow();
    return new Date(now.getFullYear(), now.getMonth(), d, 0, 0, 0, 0);
  }
  return null;
}

function guessBillName(text) {
  const labels = ["energia", "luz", "água", "agua", "internet", "aluguel", "telefone", "cartão", "cartao", "iptu", "condominio"];
  const lower = text.toLowerCase();
  for (const l of labels) if (lower.includes(l)) return l.charAt(0).toUpperCase() + l.slice(1);
  const who = text.match(/\b(?:pra|para|ao|a|à)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇ]+)/i);
  if (who) return who[1];
  return lower.split(/\s+/).slice(0, 4).join(" ");
}

function uuidShort() {
  return crypto.randomBytes(6).toString("hex");
}

// ----------------------------
// WhatsApp - envio de mensagens
// ----------------------------
async function sendWA(payload) {
  try {
    await axios.post(WA_API, payload, {
      headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Erro ao enviar mensagem WA:", err?.response?.data || err.message);
  }
}

async function sendText(to, text) {
  return sendWA({ messaging_product: "whatsapp", to, type: "text", text: { body: text } });
}

async function sendInteractiveCopyButton({ to, title, copyText, buttonTitle }) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: title },
      action: { buttons: [{ type: "copy_code", copy_code: copyText, title: buttonTitle }] },
    },
  };
  return sendWA(payload);
}

async function sendConfirmButton({ to, rowId }) {
  const payload = {
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
  };
  return sendWA(payload);
}

// ----------------------------
// Google Sheets - acesso
// ----------------------------
async function ensureSheet() {
  await ensureAuth();
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle["finplanner"];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: "finplanner",
      headerValues: ["row_id","timestamp","user","tipo","conta","valor","vencimento_iso","vencimento_br","tipo_pagamento","codigo_pagamento","status"],
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
    vencimento_iso: vencimento ? toISODate(vencimento) : "",
    vencimento_br: vencimento ? formatBRDate(vencimento) : "",
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
// Mensagens padrão
// ----------------------------
const msgDesconhecido = () =>
  "🤔 *Não consegui entender seu comando.*\n\nTente algo como:\n💰 Pagar R$150 ao Álvaro no dia 30/10\n📅 Meus pagamentos\n💸 Pix chave 123e456...";

// ----------------------------
// Interpretação e fluxo principal
// ----------------------------
function detectIntentHeuristics(text) {
  const lower = text.toLowerCase();
  if (/\b(oi|olá|ola|opa|bom dia|boa tarde|boa noite)\b/.test(lower)) return { type: "boas_vindas" };
  if (/\b(receber|recebimento|cobrar)\b/.test(lower)) return { type: "novo_recebimento" };
  if (/\b(pagar|vou pagar|transferir|enviar)\b/.test(lower)) return { type: "nova_conta" };
  if (/\bconfirm(ar)? pagamento|paguei|pago\b/.test(lower)) return { type: "confirmar_pagamento" };
  if (/\b(meus|listar|mostrar) pagamentos\b/.test(lower)) return { type: "listar_contas" };
  return { type: "desconhecido" };
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
  const intent = detectIntentHeuristics(text);

  if (intent.type === "boas_vindas") {
    await sendText(from, "👋 *Bem-vindo(a) à FinPlanner IA!* Envie algo como:\n💡 Energia R$120 vence amanhã\nou\n💸 Receber de João 200 na sexta");
    return;
  }

  if (intent.type === "nova_conta" || intent.type === "novo_recebimento") {
    const { conta, valor, vencimento, tipo_pagamento, codigo_pagamento } = extractEntities(text);
    const natureza = intent.type === "novo_recebimento" ? "conta_receber" : "conta_pagar";
    const rowId = await addBillRow({ user: from, conta, valor, vencimento, tipo_pagamento, codigo_pagamento, natureza });

    await sendText(from, `✅ ${natureza === "conta_pagar" ? "Conta" : "Recebimento"} salvo!\n\n💡 ${conta}\n💰 ${formatCurrencyBR(valor)}\n📅 ${formatBRDate(vencimento)}`);

    if (tipo_pagamento === "pix" && codigo_pagamento)
      await sendInteractiveCopyButton({ to: from, title: "💳 Chave Pix:", copyText: codigo_pagamento, buttonTitle: "Copiar chave Pix" });
    if (tipo_pagamento === "boleto" && codigo_pagamento)
      await sendInteractiveCopyButton({ to: from, title: "🧾 Código de barras:", copyText: codigo_pagamento, buttonTitle: "Copiar código" });

    if (natureza === "conta_pagar")
      await sendConfirmButton({ to: from, rowId });
    return;
  }

  if (intent.type === "confirmar_pagamento") {
    const sheet = await ensureSheet();
    const rows = await sheet.getRows();
    const row = rows.find(r => r.get("user") === from && r.get("status") !== "pago");
    if (row) {
      row.set("status", "pago"); await row.save();
      await sendText(from, "✅ Pagamento confirmado! Obrigado por manter tudo em dia.");
    } else await sendText(from, "👍 Nenhuma conta pendente encontrada.");
    return;
  }

  await sendText(from, msgDesconhecido());
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
                  row.set("status", "pago"); await row.save();
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
