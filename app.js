// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-17.2)
// ============================
// Mantém: WhatsApp Cloud API + Google Sheets + OpenAI (apenas intenção)
// Novidades desta versão:
// 1) Reconhecimento natural de frases livres (ex: “pagar água 80 reais amanhã”,
//    “enviar 150 pra Álvaro dia 30/10”, “receber de João 200 na sexta”).
// 2) Botões interativos: Copiar Pix, Copiar Código de Barras e ✅ Confirmar pagamento.
// 3) Mensagem de “não entendi” mais visual e organizada.
// 4) Detecção de intenções aprimorada (ex.: “vou pagar”, “manda lembrar”, “tenho que pagar”…).

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
const WA_TOKEN = process.env.WA_TOKEN; // Token do WhatsApp Cloud
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID; // Phone Number ID
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;

// ----------------------------
// Config - OpenAI (apenas intenção)
// ----------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_OPENAI = (process.env.USE_OPENAI || "false").toLowerCase() === "true";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ----------------------------
// Config - Google Sheets
// ----------------------------
const SHEETS_ID = process.env.SHEETS_ID; // ID da planilha
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_SERVICE_ACCOUNT_KEY = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n");

const jwt = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: GOOGLE_SERVICE_ACCOUNT_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SHEETS_ID, jwt);
let sheet; // será inicializado em ensureSheet()

// ----------------------------
// Utilitários
// ----------------------------
const BR_TZ = "America/Maceio";

function brNow() {
  // Em ambientes serverless a TZ pode variar; usamos Date nativo + lógica ao formatar
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

function parseCurrencyBR(text) {
  // Suporta padrões "R$ 1.234,56", "123,45", "80 reais", "150,00"
  const t = text.replace(/\s+/g, " ").toLowerCase();
  const realWord = t.match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?\s*(reais|real|rs|r\$)?/i);
  if (!realWord) return null;
  const inteiro = realWord[1]?.replace(/\./g, "");
  const centavos = realWord[2] || "00";
  const num = parseFloat(`${inteiro}.${centavos}`);
  if (isNaN(num)) return null;
  return num;
}

function detectBarcode(text) {
  // Muito permissivo: sequências longas de dígitos e pontos/espaços
  const clean = text.replace(/\n/g, " ");
  const m = clean.match(/[0-9\.\s]{30,}/);
  return m ? m[0].trim().replace(/\s+/g, " ") : null;
}

function detectPixKey(text) {
  // Heurística: e-mail, telefone com DDI/DDD, CPF/CNPJ, chave aleatória (GUID-like), com palavra pix próxima
  const hasPixWord = /\bpix\b/i.test(text);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone = text.match(/\+?\d{10,14}/);
  const cpf = text.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
  const cnpj = text.match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/);
  const chaveAleatoria = text.match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);

  const candidate = email?.[0] || phone?.[0] || cpf?.[0] || cnpj?.[0] || chaveAleatoria?.[0];
  return hasPixWord && candidate ? candidate : null;
}

function weekdayIndex(pt) {
  const map = {
    "domingo": 0, "segunda": 1, "segunda-feira": 1, "terca": 2, "terça": 2, "terça-feira": 2,
    "quarta": 3, "quarta-feira": 3, "quinta": 4, "quinta-feira": 4, "sexta": 5, "sexta-feira": 5, "sabado": 6, "sábado": 6
  };
  return map[pt] ?? null;
}

function nextWeekday(targetIndex, base = brNow()) {
  const d = new Date(base);
  const today = d.getDay();
  let add = (targetIndex - today + 7) % 7;
  if (add === 0) add = 7; // próxima ocorrência
  d.setDate(d.getDate() + add);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseRelativeDate(text) {
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const now = brNow();

  if (/\bhoje\b/.test(lower)) {
    const d = new Date(now); d.setHours(0,0,0,0); return d;
  }
  if (/\bamanha\b/.test(lower) || /\bamanhã\b/.test(text.toLowerCase())) {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(0,0,0,0); return d;
  }
  // nomes de semana (segunda, terça, ... sexta)
  const wd = lower.match(/\b(domingo|segunda(?:-feira)?|terca(?:-feira)?|terça(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sabado|sábado)\b/);
  if (wd) {
    const idx = weekdayIndex(wd[1]);
    if (idx != null) return nextWeekday(idx, now);
  }
  return null;
}

function parseDueDate(text) {
  // 1) dd/mm[/aaaa]
  const dmY = text.match(/(\b\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dmY) {
    let [_, d, m, y] = dmY;
    d = parseInt(d, 10);
    m = parseInt(m, 10) - 1;
    const now = brNow();
    let year = y ? (y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10)) : now.getFullYear();
    const dt = new Date(year, m, d, 0, 0, 0, 0);
    return dt;
  }
  // 2) palavras relativas ("amanhã", "sexta", "hoje")
  const rel = parseRelativeDate(text);
  if (rel) return rel;

  // 3) “vence dia 20”
  const venceDia = text.match(/vence(?:r|\b|\s|\w)*\bdia\b\s*(\d{1,2})/i) || text.match(/vencimento\s*(\d{1,2})/i);
  if (venceDia) {
    const d = parseInt(venceDia[1], 10);
    const now = brNow();
    return new Date(now.getFullYear(), now.getMonth(), d, 0, 0, 0, 0);
  }
  return null;
}

function guessBillName(text) {
  // Tenta extrair uma "label" simples: energia, água, internet, aluguel etc., ou um nome próprio / destinatário
  const labels = ["energia", "luz", "água", "agua", "internet", "aluguel", "telefone", "cartão", "cartao", "iptu", "condomínio", "condominio", "conta", "fatura"];
  const lower = text.toLowerCase();
  for (const l of labels) {
    if (lower.includes(l)) return l.charAt(0).toUpperCase() + l.slice(1);
  }
  // tenta capturar destinatário após "pra|para|ao|à|ao"
  const who = text.match(/\b(?:pra|para|ao|a|à)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇ]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇ]+)*)/i);
  if (who) return who[1].trim();
  // fallback: primeiras 4 palavras
  return lower.split(/\s+/).slice(0, 4).join(" ") || "Conta";
}

function uuidShort() {
  // id curto e único para atrelar ao botão de confirmação
  return crypto.randomBytes(6).toString("hex");
}

// ----------------------------
// WhatsApp - envio de mensagens
// ----------------------------
async function sendWA(payload) {
  try {
    const { data } = await axios.post(WA_API, payload, {
      headers: {
        "Authorization": `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    return data;
  } catch (err) {
    console.error("Erro ao enviar mensagem WA:", err?.response?.data || err.message);
    return null;
  }
}

export async function sendText(to, text) {
  return sendWA({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}

export async function sendInteractiveCopyButton({ to, title = "Copiar", copyText = "", buttonTitle = "Copiar" }) {
  // Botão interativo de copiar (copy_code)
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: title },
      action: {
        buttons: [
          {
            type: "copy_code",
            copy_code: copyText,
            title: buttonTitle,
          },
        ],
      },
    },
  };
  return sendWA(payload);
}

export async function sendConfirmButton({ to, rowId, label = "Confirmar pagamento" }) {
  // Botão interativo de resposta (reply) para confirmar pagamento de um lançamento específico
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Quando pagar, toque abaixo para confirmar:" },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: `CONFIRMAR:${rowId}`,
              title: `✅ ${label}`,
            },
          },
        ],
      },
    },
  };
  return sendWA(payload);
}

// ----------------------------
// Google Sheets - inicialização e escrita
// ----------------------------
async function ensureSheet() {
  await doc.loadInfo();
  sheet = doc.sheetsByTitle["finplanner"];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: "finplanner",
      headerValues: [
        "row_id", "timestamp", "user", "tipo", "conta", "valor", "vencimento_iso", "vencimento_br",
        "tipo_pagamento", "codigo_pagamento", "status"
      ]
    });
  } else {
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues || [];
    const need = ["row_id","timestamp","user","tipo","conta","valor","vencimento_iso","vencimento_br","tipo_pagamento","codigo_pagamento","status"];
    let changed = false;
    for (const h of need) {
      if (!headers.includes(h)) { headers.push(h); changed = true; }
    }
    if (changed) await sheet.setHeaderRow(headers);
  }
}

async function addBillRow({ user, conta, valor, vencimento, tipo_pagamento, codigo_pagamento, natureza = "conta_pagar" }) {
  await ensureSheet();
  const id = uuidShort();
  const row = {
    row_id: id,
    timestamp: new Date().toISOString(),
    user,
    tipo: natureza, // "conta_pagar" ou "conta_receber"
    conta,
    valor: valor ?? "",
    vencimento_iso: vencimento ? toISODate(vencimento) : "",
    vencimento_br: vencimento ? formatBRDate(vencimento) : "",
    tipo_pagamento: tipo_pagamento || "",
    codigo_pagamento: codigo_pagamento || "",
    status: "pendente",
  };
  await sheet.addRow(row);
  return row;
}

async function listDueToday() {
  await ensureSheet();
  const rows = await sheet.getRows();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return rows.filter(r =>
    r.get("tipo") === "conta_pagar" &&
    r.get("status") !== "pago" &&
    r.get("vencimento_iso") &&
    (new Date(r.get("vencimento_iso")).getTime() === today.getTime())
  );
}

async function findRowById(rowId) {
  await ensureSheet();
  const rows = await sheet.getRows();
  return rows.find(r => r.get("row_id") === rowId) || null;
}

// ----------------------------
// Mensagens padronizadas
// ----------------------------
function msgBoasVindas() {
  return (
    "👋 *Bem-vindo(a) à FinPlanner IA!*\n\n" +
    "Eu organizo seus *pagamentos e recebimentos* de forma simples.\n\n" +
    "Você pode me enviar, por exemplo:\n" +
    "• `Energia R$ 250 vence 20/10 chave pix email@dominio.com`\n" +
    "• `Internet 99,90 vence 05/11 boleto 34191.79001 01043...`\n\n" +
    "Eu salvo automaticamente e te aviso no dia do vencimento."
  );
}

function msgContaSalva({ conta, valor, vencimento, tipoPagamento, natureza }) {
  const valorFmt = valor != null ? formatBRDate ? formatCurrencyBR(valor) : "—" : "—";
  const dataFmt = vencimento ? formatBRDate(vencimento) : "—";
  const tipo = tipoPagamento === "pix" ? "💳 Pagamento via Pix" : (tipoPagamento === "boleto" ? "🧾 Pagamento via Boleto" : "");
  const titulo = natureza === "conta_receber" ? "📥 *Recebimento registrado!*" : "🧾 *Conta salva com sucesso!*";
  return (
    `${titulo}\n\n` +
    `💡 Descrição: ${conta}\n` +
    `💰 Valor: ${valorFmt}\n` +
    `📅 Vencimento: ${dataFmt}\n` +
    (tipo ? `${tipo}\n\n` : "\n") +
    (natureza === "conta_receber"
      ? "🔔 Avisarei no dia combinado para você cobrar/confirmar o recebimento."
      : "🔔 Te lembrarei no dia do vencimento!")
  );
}

function msgDesconhecido() {
  return (
    "🤔 *Não consegui entender seu comando.*\n\n" +
    "Tente algo como:\n" +
    "💰 *Pagar* R$150 *ao Álvaro* *no dia 30/10*\n" +
    "📅 *Meus pagamentos*\n" +
    "💸 *Pix* chave 123e456...\n"
  );
}

function msgLembrete({ conta, valor, vencimento }) {
  const valorFmt = valor != null ? formatCurrencyBR(valor) : "—";
  const dataFmt = vencimento ? formatBRDate(vencimento) : "—";
  return (
    "⚠️ *Lembrete de pagamento!*\n\n" +
    `💡 Conta: ${conta}\n` +
    `💰 Valor: ${valorFmt}\n` +
    `📅 Vence hoje (${dataFmt})\n\n` +
    "Se preferir, toque em um botão abaixo para copiar e pagar, ou confirmar."
  );
}

function msgListaCabecalho() {
  return "📋 *Seus próximos pagamentos:*";
}

function msgLinhaLista({ conta, valor, vencimento }) {
  const valorFmt = valor != null ? formatCurrencyBR(valor) : "—";
  const dataFmt = vencimento ? formatBRDate(vencimento) : "—";
  return `• ${dataFmt} — ${conta} (${valorFmt})`;
}

function formatCurrencyBR(v) {
  try {
    return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  } catch {
    return `R$ ${Number(v).toFixed(2)}`;
  }
}

// ----------------------------
// Interpretação de intenção (aprimorada)
// ----------------------------
function detectIntentHeuristics(text) {
  const lower = text.toLowerCase();

  // Saudações
  if (/\b(oi|olá|ola|opa|bom dia|boa tarde|boa noite)\b/.test(lower)) return { type: "boas_vindas" };

  // Listagens / relatórios
  if (/\b(meus|listar|mostrar)\s+(pagamentos|contas|a pagar)\b/.test(lower)) return { type: "listar_contas" };
  if (/\brelat(orio|ório)\b/.test(lower)) return { type: "relatorio" };

  // Confirmação direta
  if (/\bconfirm(ar)? pagamento\b/.test(lower) || /\bpaguei\b/.test(lower) || /\bpago\b/.test(lower)) {
    return { type: "confirmar_pagamento" };
  }

  // Pagamentos – frases naturais
  if (/\b(pagar|vou pagar|preciso pagar|tenho que pagar|manda lembrar|enviar|transferir)\b/.test(lower)) {
    return { type: "nova_conta" };
  }

  // Recebimentos – frases naturais
  if (/\b(receber|vou receber|tenho que receber|cobrar|me pagaram|entrar|recebimento)\b/.test(lower)) {
    return { type: "novo_recebimento" };
  }

  // Se contiver valor + data, assume nova conta por padrão
  const hasMoney = /r\$|\d+[\.,]\d{2}\b|\breais\b|\breal\b/i.test(lower);
  const hasDue = /\bvence|vencimento|dia\b/.test(lower) || /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(lower) || /\bamanh[aã]|hoje|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado\b/.test(lower);
  if (hasMoney && hasDue) return { type: "nova_conta" };

  return { type: "desconhecido" };
}

async function detectIntent(text) {
  // Heurística local primeiro (rápida e offline)
  const h = detectIntentHeuristics(text);
  if (h.type !== "desconhecido") return h;

  // OpenAI (opcional) apenas para classificar rótulo
  if (USE_OPENAI && openai) {
    try {
      const prompt = `Classifique a intenção da mensagem do usuário em UMA de: boas_vindas, nova_conta, novo_recebimento, listar_contas, relatorio, confirmar_pagamento, desconhecido.
Mensagem: "${text}"
Resposta apenas com o rótulo.`;
      const r = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: prompt,
      });
      const label = (r.output_text || "").trim().toLowerCase();
      return { type: ["boas_vindas","nova_conta","novo_recebimento","listar_contas","relatorio","confirmar_pagamento"].includes(label) ? label : "desconhecido" };
    } catch (e) {
      console.error("OpenAI intent error:", e.message);
    }
  }

  return { type: "desconhecido" };
}

// ----------------------------
// Extração de entidades (frases livres)
// ----------------------------
function extractEntities(text) {
  const conta = guessBillName(text);
  const valor = parseCurrencyBR(text);
  const vencimento = parseDueDate(text);
  const pix = detectPixKey(text);
  const boleto = pix ? null : detectBarcode(text); // se detectou Pix, prioriza Pix

  let tipo_pagamento = "";
  let codigo_pagamento = "";
  if (pix) { tipo_pagamento = "pix"; codigo_pagamento = pix; }
  else if (boleto) { tipo_pagamento = "boleto"; codigo_pagamento = boleto; }

  return { conta, valor, vencimento, tipo_pagamento, codigo_pagamento };
}

// ----------------------------
// Processamento de mensagem do usuário
// ----------------------------
async function handleUserText(from, text) {
  const intent = await detectIntent(text);

  // Boas-vindas
  if (intent.type === "boas_vindas") {
    await sendText(from, msgBoasVindas());
    return;
  }

  // Nova conta (pagar/enviar/transferir)
  if (intent.type === "nova_conta") {
    const { conta, valor, vencimento, tipo_pagamento, codigo_pagamento } = extractEntities(text);

    const row = await addBillRow({
      user: from,
      conta,
      valor,
      vencimento,
      tipo_pagamento,
      codigo_pagamento,
      natureza: "conta_pagar",
    });

    await sendText(from, msgContaSalva({
      conta,
      valor,
      vencimento,
      tipoPagamento: tipo_pagamento,
      natureza: "conta_pagar"
    }));

    // Botões de copiar (Pix/Boleto)
    if (tipo_pagamento === "pix" && codigo_pagamento) {
      await sendInteractiveCopyButton({
        to: from,
        title: "💳 Chave Pix disponível:",
        copyText: codigo_pagamento,
        buttonTitle: "Copiar chave Pix",
      });
    } else if (tipo_pagamento === "boleto" && codigo_pagamento) {
      await sendInteractiveCopyButton({
        to: from,
        title: "🧾 Código de barras do boleto:",
        copyText: codigo_pagamento,
        buttonTitle: "Copiar código de barras",
      });
    }

    // Botão Confirmar Pagamento
    await sendConfirmButton({ to: from, rowId: row.row_id, label: "Confirmar pagamento" });

    return;
  }

  // Novo recebimento (receber/cobrar)
  if (intent.type === "novo_recebimento") {
    const { conta, valor, vencimento, tipo_pagamento, codigo_pagamento } = extractEntities(text);

    const row = await addBillRow({
      user: from,
      conta,
      valor,
      vencimento,
      tipo_pagamento,
      codigo_pagamento,
      natureza: "conta_receber",
    });

    await sendText(from, msgContaSalva({
      conta,
      valor,
      vencimento,
      tipoPagamento: tipo_pagamento,
      natureza: "conta_receber"
    }));

    // Para recebimentos, não mostramos "Confirmar pagamento", mas podemos manter o fluxo simples
    return;
  }

  // Listar contas pendentes do usuário
  if (intent.type === "listar_contas") {
    await ensureSheet();
    const rows = await sheet.getRows();
    const proximos = rows
      .filter(r => r.get("tipo") === "conta_pagar" && r.get("user") === from && r.get("status") !== "pago")
      .map(r => ({
        conta: r.get("conta"),
        valor: parseFloat(r.get("valor") || "0"),
        vencimento: r.get("vencimento_iso") ? new Date(r.get("vencimento_iso")) : null,
      }))
      .sort((a,b) => (a.vencimento?.getTime()||0) - (b.vencimento?.getTime()||0))
      .slice(0, 10);

    if (!proximos.length) {
      await sendText(from, "✅ Você não tem contas pendentes registradas.");
      return;
    }

    let msg = msgListaCabecalho() + "\n\n";
    for (const item of proximos) msg += msgLinhaLista(item) + "\n";
    await sendText(from, msg.trim());
    return;
  }

  // Relatório rápido
  if (intent.type === "relatorio") {
    await ensureSheet();
    const rows = await sheet.getRows();
    const totalPendente = rows
      .filter(r => r.get("tipo") === "conta_pagar" && r.get("status") !== "pago")
      .reduce((acc, r) => acc + parseFloat(r.get("valor") || "0"), 0);

    const msg = (
      "📊 *Resumo rápido*\n\n" +
      `Pendente total: ${formatCurrencyBR(totalPendente)}\n` +
      "Use `Meus pagamentos` para ver as próximas datas."
    );
    await sendText(from, msg);
    return;
  }

  // Confirmar pagamento (texto)
  if (intent.type === "confirmar_pagamento") {
    await ensureSheet();
    const rows = await sheet.getRows();
    // Estratégia simples: marca a última conta do usuário com vencimento mais próximo como paga
    const pendentes = rows
      .filter(r => r.get("tipo") === "conta_pagar" && r.get("user") === from && r.get("status") !== "pago")
      .sort((a,b) => new Date(a.get("vencimento_iso")||0) - new Date(b.get("vencimento_iso")||0));

    if (!pendentes.length) {
      await sendText(from, "👍 Não encontrei contas pendentes para confirmar.");
      return;
    }

    pendentes[0].set("status", "pago");
    await pendentes[0].save();

    await sendText(from, "✅ Pagamento confirmado! Obrigado por manter tudo em dia.");
    return;
  }

  // Fallback
  await sendText(from, msgDesconhecido());
}

// ----------------------------
// Webhook - verificação (GET)
// ----------------------------
app.get("/webhook", (req, res) => {
  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || "verify_token";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === verifyToken) {
    console.log("Webhook verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ----------------------------
// Webhook - recepção (POST)
// ----------------------------
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.object && body.entry) {
      for (const entry of body.entry) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const messages = change.value?.messages || [];
          for (const msg of messages) {
            const from = msg.from; // número do cliente

            // Texto comum
            if (msg.type === "text") {
              const text = msg.text?.body || "";
              await handleUserText(from, text);
            }

            // Interativo (botão)
            if (msg.type === "interactive") {
              const interactive = msg.interactive || {};
              // Botão de reply (Confirmar pagamento)
              if (interactive.type === "button" && interactive.button_reply) {
                const replyId = interactive.button_reply.id || "";
                if (replyId.startsWith("CONFIRMAR:")) {
                  const rowId = replyId.split("CONFIRMAR:")[1];
                  const row = await findRowById(rowId);
                  if (row && row.get("status") !== "pago") {
                    row.set("status", "pago");
                    await row.save();
                    await sendText(from, "✅ Pagamento confirmado! Obrigado por manter tudo em dia.");
                  } else {
                    await sendText(from, "ℹ️ Esse lançamento já está confirmado ou não foi encontrado.");
                  }
                }
              }
              // Botão copy_code (Pix/Boleto) é handle pelo próprio WhatsApp; não há evento extra para nós
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("Erro no webhook:", e.message);
    res.sendStatus(200);
  }
});

// ----------------------------
// CRON - lembretes de pagamentos (a cada 30 minutos)
// ----------------------------
cron.schedule("*/30 * * * *", async () => {
  try {
    const due = await listDueToday();
    for (const r of due) {
      const to = r.get("user");
      const conta = r.get("conta");
      const valor = parseFloat(r.get("valor") || "0");
      const vencimento = r.get("vencimento_iso") ? new Date(r.get("vencimento_iso")) : null;
      const tipo = r.get("tipo_pagamento");
      const codigo = r.get("codigo_pagamento");

      await sendText(to, msgLembrete({ conta, valor, vencimento }));

      if (tipo === "pix" && codigo) {
        await sendInteractiveCopyButton({
          to,
          title: "💳 Chave Pix:",
          copyText: codigo,
          buttonTitle: "Copiar chave Pix",
        });
      } else if (tipo === "boleto" && codigo) {
        await sendInteractiveCopyButton({
          to,
          title: "🧾 Código de barras:",
          copyText: codigo,
          buttonTitle: "Copiar código de barras",
        });
      }

      // Envia botão de confirmar amarrado ao row_id
      const rowId = r.get("row_id");
      if (rowId) {
        await sendConfirmButton({ to, rowId, label: "Confirmar pagamento" });
      }
    }
  } catch (e) {
    console.error("Erro no CRON:", e.message);
  }
});

// ----------------------------
// Inicialização do servidor
// ----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FinPlanner IA rodando na porta ${PORT}`);
});
