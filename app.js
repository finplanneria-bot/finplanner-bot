// ============================
// FinPlanner IA - WhatsApp Bot
// Versão: app.js v2025-10-23.1
// ============================

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import cron from "node-cron";

dotenv.config();

// ============================
// ENV
// ============================
const {
  PORT,
  SHEETS_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_KEY: RAW_KEY = "",
  WA_TOKEN,
  WA_PHONE_NUMBER_ID,
  ADMIN_WA_NUMBER,
  WEBHOOK_VERIFY_TOKEN,
  USE_OPENAI: USE_OPENAI_RAW,
  DEBUG_SHEETS: DEBUG_SHEETS_RAW,
} = process.env;

const USE_OPENAI = (USE_OPENAI_RAW || "false").toLowerCase() === "true";
const DEBUG_SHEETS = (DEBUG_SHEETS_RAW || "false").toLowerCase() === "true";

// ============================
// Google Auth fix (supports literal \n)
// ============================
let GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}

// ============================
// APP
// ============================
const app = express();
app.use(bodyParser.json());

app.get("/", (_req, res) => {
  res.send("FinPlanner IA ativo! 🚀");
});

// ============================
// Utils
// ============================
const SEP = "────────────────";

const normalizeUser = (num) => (num || "").replace(/\D/g, "");
const toNumber = (value) => {
  if (!value) return 0;
  const normalized = String(value).replace(/[^0-9,-.]/g, "").replace(/,/g, ".");
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};
const formatCurrencyBR = (value) => {
  const num = Number(value || 0);
  return `R$${Math.abs(num).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};
const statusIconLabel = (status) =>
  status === "pago" || status === "recebido" ? "✅ Pago" : "⏳ Pendente";

const startOfDay = (d) => {
  const tmp = new Date(d);
  tmp.setHours(0, 0, 0, 0);
  return tmp;
};
const endOfDay = (d) => {
  const tmp = new Date(d);
  tmp.setHours(23, 59, 59, 999);
  return tmp;
};
const startOfMonth = (y, m) => new Date(y, m, 1, 0, 0, 0, 0);
const endOfMonth = (y, m) => new Date(y, m + 1, 0, 23, 59, 59, 999);

const formatBRDate = (d) => {
  if (!d) return "";
  try {
    return new Date(d).toLocaleDateString("pt-BR");
  } catch (e) {
    return "";
  }
};

const numberToKeycapEmojis = (n) => {
  const map = {
    0: "0️⃣",
    1: "1️⃣",
    2: "2️⃣",
    3: "3️⃣",
    4: "4️⃣",
    5: "5️⃣",
    6: "6️⃣",
    7: "7️⃣",
    8: "8️⃣",
    9: "9️⃣",
  };
  return String(n)
    .split("")
    .map((d) => map[d] || d)
    .join("");
};

const withinRange = (dt, start, end) => {
  if (!dt) return false;
  const time = new Date(dt).getTime();
  return time >= start.getTime() && time <= end.getTime();
};

const parseDateToken = (token) => {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (lower === "hoje") return new Date();
  if (lower === "amanha" || lower === "amanhã") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  }
  const match = token.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    const d = new Date(year, month, day);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
};

const detectCategory = (description, tipo) => {
  const text = (description || "").toLowerCase();
  const rules = [
    { slug: "utilidades", emoji: "🔌", kws: ["luz", "energia", "água", "agua", "gás", "gas"] },
    { slug: "internet_telefonia", emoji: "🌐", kws: ["internet", "fibra", "vivo", "claro", "tim", "oi"] },
    { slug: "moradia", emoji: "🏠", kws: ["aluguel", "condomínio", "condominio", "iptu"] },
    { slug: "mercado", emoji: "🛒", kws: ["mercado", "supermercado", "ifood", "padaria", "almoço", "jantar", "restaurante"] },
    { slug: "transporte", emoji: "🚗", kws: ["uber", "99", "gasolina", "combustível", "combustivel", "passagem", "ônibus", "onibus"] },
    { slug: "saude", emoji: "💊", kws: ["academia", "plano", "consulta", "dentista", "farmácia", "farmacia"] },
    { slug: "educacao", emoji: "🎓", kws: ["curso", "faculdade", "escola", "mensalidade"] },
    { slug: "lazer", emoji: "🎭", kws: ["netflix", "spotify", "cinema", "show", "lazer", "entretenimento"] },
    { slug: "impostos_taxas", emoji: "🧾", kws: ["multa", "taxa", "imposto", "receita"] },
    { slug: "salario_trabalho", emoji: "💼", kws: ["salário", "salario", "pagamento", "freela", "freelance", "contrato"] },
    { slug: "vendas_receitas", emoji: "💵", kws: ["venda", "recebimento", "pix recebido", "cliente", "boleto recebido"] },
  ];
  for (const rule of rules) {
    if (rule.kws.some((kw) => text.includes(kw))) {
      return { slug: rule.slug, emoji: rule.emoji };
    }
  }
  if (tipo === "conta_receber") return { slug: "vendas_receitas", emoji: "💵" };
  return { slug: "outros", emoji: "🧩" };
};

const formatCategoryLabel = (slug, emoji) => {
  const raw = (slug || "").toString().trim();
  if (!raw) return emoji ? `${emoji} —` : "—";
  const normalized = raw.replace(/[_-]+/g, " ");
  const words = normalized.split(/\s+/).filter(Boolean);
  const friendly =
    words.length === 0
      ? raw
      : words
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(" ");
  return emoji ? `${emoji} ${friendly}` : friendly;
};

// ============================
// WhatsApp helpers
// ============================
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;

async function sendWA(payload) {
  try {
    await axios.post(WA_API, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Erro WA:", error.response?.data || error.message);
  }
}

const sendText = (to, body) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });

const sendCopyButton = (to, title, code, btnTitle) => {
  if (!code) return;
  const safeTitle = btnTitle.length > 20 ? `${btnTitle.slice(0, 17)}...` : btnTitle;
  return sendWA({
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
            copy_code: code,
            title: safeTitle,
          },
        ],
      },
    },
  });
};

// ============================
// Google Sheets helpers
// ============================
const SHEET_HEADERS = [
  "row_id",
  "timestamp",
  "user",
  "user_raw",
  "tipo",
  "conta",
  "valor",
  "vencimento_iso",
  "vencimento_br",
  "tipo_pagamento",
  "codigo_pagamento",
  "status",
  "fixa",
  "fix_parent_id",
  "vencimento_dia",
  "categoria",
  "categoria_emoji",
  "descricao",
];

let doc;

async function ensureAuth() {
  if (doc) return doc;
  const auth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  doc = new GoogleSpreadsheet(SHEETS_ID, auth);
  await doc.loadInfo();
  return doc;
}

async function ensureSheet() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["finplanner"];
  if (!sheet) {
    sheet = await doc.addSheet({ title: "finplanner", headerValues: SHEET_HEADERS });
  } else {
    await sheet.loadHeaderRow();
    const current = sheet.headerValues || [];
    const missing = SHEET_HEADERS.filter((header) => !current.includes(header));
    if (missing.length) {
      await sheet.setHeaderRow([...current, ...missing]);
    }
  }
  return sheet;
}

const getVal = (row, key) => {
  if (!row) return undefined;
  if (typeof row.get === "function") return row.get(key);
  if (key in row) return row[key];
  if (row._rawData && row._sheet?.headerValues) {
    const index = row._sheet.headerValues.indexOf(key);
    if (index >= 0) return row._rawData[index];
  }
  return undefined;
};

const setVal = (row, key, value) => {
  if (!row) return;
  if (typeof row.set === "function") row.set(key, value);
  else row[key] = value;
};

const saveRow = (row) => (typeof row.save === "function" ? row.save() : Promise.resolve());

const getEffectiveDate = (row) => {
  const iso = getVal(row, "vencimento_iso");
  const ts = getVal(row, "timestamp");
  if (iso) return new Date(iso);
  if (ts) return new Date(ts);
  return null;
};

async function allRowsForUser(userNorm) {
  const sheet = await ensureSheet();
  const rows = await sheet.getRows();
  return rows.filter((row) => normalizeUser(getVal(row, "user")) === userNorm);
}

const withinPeriod = (rows, start, end) => rows.filter((row) => withinRange(getEffectiveDate(row), start, end));
const sumValues = (rows) => rows.reduce((acc, row) => acc + toNumber(getVal(row, "valor")), 0);

// ============================
// Rendering helpers
// ============================
const formatEntrySummary = (row) => {
  const descricao = getVal(row, "descricao") || getVal(row, "conta") || "Lançamento";
  const valor = formatCurrencyBR(getVal(row, "valor"));
  const data = formatBRDate(getEffectiveDate(row)) || "—";
  const status = (getVal(row, "status") || "pendente").toString();
  const categoriaLabel = formatCategoryLabel(getVal(row, "categoria"), getVal(row, "categoria_emoji"));
  return `📝 Descrição: ${descricao}\n💰 Valor: ${valor}\n📅 Data: ${data}\n🏷 Status: ${status}\n📂 Categoria: ${categoriaLabel}`;
};

const renderItem = (row, idx) => {
  const idxEmoji = numberToKeycapEmojis(idx);
  const conta = getVal(row, "conta") || "Lançamento";
  const valor = formatCurrencyBR(getVal(row, "valor"));
  const data = formatBRDate(getEffectiveDate(row));
  const status = statusIconLabel(getVal(row, "status"));
  const categoriaEmoji = getVal(row, "categoria_emoji") || "";
  const categoria = getVal(row, "categoria") || "—";
  const descricao = getVal(row, "descricao") || conta;
  return `${idxEmoji} ${conta}\n📝 ${descricao}\n💰 ${valor}\n📅 ${data}\n🏷️ ${status}\n📂 ${categoriaEmoji} ${categoria}\n${SEP}\n`;
};

const renderReportList = (title, rows) => {
  let message = `📊 *${title}*\n\n`;
  if (!rows.length) {
    return `${message}✅ Nenhum lançamento encontrado para o período selecionado.`;
  }
  rows.forEach((row, index) => {
    message += renderItem(row, index + 1);
  });
  message += `\n💰 *Total:* ${formatCurrencyBR(sumValues(rows))}`;
  return message;
};

const renderSaldoFooter = (rowsAll, start, end) => {
  const within = withinPeriod(rowsAll, start, end);
  const recebimentosPagos = within.filter(
    (row) => getVal(row, "tipo") === "conta_receber" && ["pago", "recebido"].includes((getVal(row, "status") || "").toLowerCase())
  );
  const pagamentosPagos = within.filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") === "pago");
  const totalRec = sumValues(recebimentosPagos);
  const totalPag = sumValues(pagamentosPagos);
  const saldo = totalRec - totalPag;
  const saldoStr = formatCurrencyBR(saldo);
  const saldoLine = saldo < 0 ? `🟥 🔹 *Saldo no período:* -${saldoStr}` : `🔹 *Saldo no período:* ${saldoStr}`;
  return `\n${SEP}\n💰 *Total de Recebimentos:* ${formatCurrencyBR(totalRec)}\n💸 *Total de Pagamentos:* ${formatCurrencyBR(totalPag)}\n${saldoLine}`;
};

// ============================
// Menus interativos
// ============================
const sendWelcomeList = (to) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: {
        text: `👋 Olá! Eu sou a FinPlanner IA.\n\n💡 Organizo seus pagamentos, ganhos e gastos de forma simples e automática.\n\nToque em *Abrir menu* ou digite o que deseja fazer.`,
      },
      action: {
        button: "Abrir menu",
        sections: [
          {
            title: "Lançamentos e Contas",
            rows: [
              { id: "MENU:registrar_pagamento", title: "💰 Registrar pagamento", description: "Adicionar um novo gasto." },
              { id: "MENU:registrar_recebimento", title: "💵 Registrar recebimento", description: "Adicionar uma entrada." },
              { id: "MENU:contas_pagar", title: "📅 Contas a pagar", description: "Ver e confirmar pagamentos pendentes." },
              { id: "MENU:contas_fixas", title: "♻️ Contas fixas", description: "Cadastrar ou excluir contas recorrentes." },
            ],
          },
          {
            title: "Relatórios e Histórico",
            rows: [
              { id: "MENU:relatorios", title: "📊 Relatórios", description: "Gerar por categoria e período." },
              { id: "MENU:lancamentos", title: "🧾 Meus lançamentos", description: "Ver por mês ou período personalizado." },
            ],
          },
          {
            title: "Ajustes e Ajuda",
            rows: [
              { id: "MENU:editar", title: "✏️ Editar lançamentos", description: "Alterar registros por número." },
              { id: "MENU:excluir", title: "🗑️ Excluir lançamento", description: "Excluir último ou escolher por número." },
              { id: "MENU:ajuda", title: "⚙️ Ajuda e exemplos", description: "Como usar a FinPlanner IA." },
            ],
          },
        ],
      },
    },
  });

const sendRelatoriosButtons = (to) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "📊 Qual relatório você deseja gerar?" },
      action: {
        button: "Abrir opções",
        sections: [
          {
            title: "Tipos de relatório",
            rows: [
              { id: "REL:CAT:cp", title: "Contas a pagar", description: "Pagamentos pendentes e quitados." },
              { id: "REL:CAT:rec", title: "Recebimentos", description: "Entradas registradas." },
              { id: "REL:CAT:pag", title: "Pagamentos", description: "Todos os gastos registrados." },
              { id: "REL:CAT:all", title: "Completo", description: "Visão geral de tudo." },
            ],
          },
        ],
      },
    },
  });

const sendPeriodoButtons = (to, prefix) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "🗓️ Escolha o período:" },
      action: {
        buttons: [
          { type: "reply", reply: { id: `${prefix}:mes_atual`, title: "Mês atual" } },
          { type: "reply", reply: { id: `${prefix}:todo_periodo`, title: "Todo período" } },
          { type: "reply", reply: { id: `${prefix}:personalizado`, title: "Data personalizada" } },
        ],
      },
    },
  });

const sendLancPeriodoButtons = (to) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "🧾 Escolha o período:" },
      action: {
        buttons: [
          { type: "reply", reply: { id: `LANC:PER:mes_atual`, title: "Mês atual" } },
          { type: "reply", reply: { id: `LANC:PER:personalizado`, title: "Data personalizada" } },
        ],
      },
    },
  });

const sendDeleteMenu = (to) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "🗑️ Como deseja excluir?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "DEL:LAST", title: "Último lançamento" } },
          { type: "reply", reply: { id: "DEL:LIST", title: "Listar lançamentos" } },
        ],
      },
    },
  });

const sendContasFixasMenu = (to) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Escolha uma opção:" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "CFIX:CAD", title: "Cadastrar conta fixa" } },
          { type: "reply", reply: { id: "CFIX:DEL", title: "Excluir contas" } },
        ],
      },
    },
  });

const sendCadastrarContaFixaMessage = (to) =>
  sendText(
    to,
    `♻ Cadastro de conta fixa\n\nUse este formato para registrar contas que se repetem todo mês automaticamente:\n\n📝 Descrição: Nome da conta\n(ex: Internet, Academia, Aluguel)\n\n💰 Valor: Valor fixo da conta\n(ex: 120,00)\n\n📅 Dia de vencimento: Data que vence todo mês\n(ex: todo dia 05)\n\n💡 Exemplo pronto:\n➡ Conta fixa internet 120,00 todo dia 05\n\n🔔 A FinPlanner IA lançará esta conta automaticamente todo mês e te avisará no dia do vencimento.`
  );

const buildFixedAccountList = (rows) =>
  rows
    .map((row, index) => {
      const conta = getVal(row, "conta") || getVal(row, "descricao") || "Conta fixa";
      const valor = formatCurrencyBR(getVal(row, "valor"));
      const dia = getVal(row, "vencimento_dia");
      const dueDate = dia ? `Dia ${String(dia).padStart(2, "0")}` : formatBRDate(getEffectiveDate(row)) || "—";
      return `${numberToKeycapEmojis(index + 1)} ${conta}\n💰 ${valor}\n📅 Vencimento: ${dueDate}\n${SEP}`;
    })
    .join("\n");

const isFixedAccount = (row) => String(getVal(row, "fixa") || "").toLowerCase() === "sim";

const getFixedAccounts = async (userNorm) => {
  const rows = await allRowsForUser(userNorm);
  return rows.filter((row) => isFixedAccount(row));
};

async function sendExcluirContaFixaMessage(to, userNorm) {
  const fixed = await getFixedAccounts(userNorm);
  if (!fixed.length) {
    sessionFixedDelete.delete(userNorm);
    await sendText(to, "Você ainda não possui contas fixas cadastradas.");
    return;
  }
  const sorted = fixed.slice().sort((a, b) => {
    const diaA = Number(getVal(a, "vencimento_dia")) || 0;
    const diaB = Number(getVal(b, "vencimento_dia")) || 0;
    if (diaA && diaB) return diaA - diaB;
    if (diaA) return -1;
    if (diaB) return 1;
    const contaA = (getVal(a, "conta") || "").toString().toLowerCase();
    const contaB = (getVal(b, "conta") || "").toString().toLowerCase();
    return contaA.localeCompare(contaB);
  });
  sessionFixedDelete.set(userNorm, { awaiting: "index", rows: sorted });
  const list = buildFixedAccountList(sorted);
  const message = `🗑 Excluir conta fixa\n\nPara remover uma conta recorrente, digite o número de qual deseja excluir:\n\n${list}\nEnvie o número da conta fixa que deseja excluir.`;
  await sendText(to, message);
}

// ============================
// Sessões (estado do usuário)
// ============================
const sessionPeriod = new Map();
const sessionEdit = new Map();
const sessionDelete = new Map();
const sessionRegister = new Map();
const sessionFixedDelete = new Map();

const startReportCategoryFlow = async (to, userNorm, category) => {
  sessionPeriod.set(userNorm, { mode: "report", category, awaiting: null });
  await sendPeriodoButtons(to, `REL:PER:${category}`);
};

const resetSession = (userNorm) => {
  sessionPeriod.delete(userNorm);
  sessionEdit.delete(userNorm);
  sessionDelete.delete(userNorm);
  sessionRegister.delete(userNorm);
  sessionFixedDelete.delete(userNorm);
};

// ============================
// Sheets operations
// ============================
const createRow = async (payload) => {
  const sheet = await ensureSheet();
  if (DEBUG_SHEETS) console.log("[Sheets] Adding row", payload);
  await sheet.addRow(payload);
};

const deleteRow = async (row) => {
  if (!row) return;
  if (DEBUG_SHEETS) console.log("[Sheets] Removing row", getVal(row, "row_id"));
  if (typeof row.delete === "function") await row.delete();
};

const generateRowId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ============================
// Parse de lançamento
// ============================
const parseRegisterText = (text) => {
  const lower = (text || "").toLowerCase();
  const tipo = /receb/i.test(lower) ? "conta_receber" : "conta_pagar";
  const status = /pendente|a pagar|a receber/.test(lower)
    ? tipo === "conta_receber"
      ? "pendente"
      : "pendente"
    : tipo === "conta_receber"
    ? /recebid[oa]/.test(lower)
      ? "recebido"
      : "pendente"
    : /pag[ou]/.test(lower)
    ? "pago"
    : "pendente";

  let valor = 0;
  const valorMatch = text.match(/(\d+[\.,]\d{2})/);
  if (valorMatch) valor = toNumber(valorMatch[1]);

  let data = null;
  const dateMatch = text.match(/(hoje|amanh[ãa]|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);
  if (dateMatch) data = parseDateToken(dateMatch[1]);

  const descricao = text
    .replace(/(hoje|amanh[ãa]|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/gi, "")
    .replace(/(recebimento|receber|recebido|pagamento|pagar|pago|pendente)/gi, "")
    .replace(/(r\$|valor|de)/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    tipo,
    valor,
    data: data || new Date(),
    status: status === "recebido" && tipo === "conta_pagar" ? "pago" : status,
    descricao: descricao || (tipo === "conta_receber" ? "Recebimento" : "Pagamento"),
  };
};

// ============================
// Fluxos de mensagens
// ============================
async function showReportByCategory(fromRaw, userNorm, category, range) {
  const rows = await allRowsForUser(userNorm);
  const { start, end } = range;
  const inRange = withinPeriod(rows, start, end);

  if (category === "cp") {
    const filtered = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") !== "pago");
    const message = renderReportList("Relatório • Contas a pagar", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, message);
    return;
  }
  if (category === "rec") {
    const filtered = inRange.filter((row) => getVal(row, "tipo") === "conta_receber");
    const message = renderReportList("Relatório • Recebimentos", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, message);
    return;
  }
  if (category === "pag") {
    const filtered = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar");
    const message = renderReportList("Relatório • Pagamentos", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, message);
    return;
  }
  if (category === "all") {
    const sorted = inRange.slice().sort((a, b) => getEffectiveDate(a) - getEffectiveDate(b));
    const message = renderReportList("Relatório • Completo", sorted) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, message);
  }
}

async function showLancamentos(fromRaw, userNorm, range) {
  const rows = await allRowsForUser(userNorm);
  const filtered = withinPeriod(rows, range.start, range.end)
    .filter((row) => toNumber(getVal(row, "valor")) > 0)
    .sort((a, b) => getEffectiveDate(a) - getEffectiveDate(b));
  if (!filtered.length) {
    await sendText(fromRaw, "✅ Nenhum lançamento encontrado para o período selecionado.");
    return;
  }
  let message = "🧾 *Meus lançamentos*\n\n";
  filtered.forEach((row, index) => {
    message += renderItem(row, index + 1);
  });
  await sendText(fromRaw, message);
}

async function listPendingPayments(fromRaw, userNorm) {
  const rows = await allRowsForUser(userNorm);
  const pending = rows.filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") !== "pago");
  if (!pending.length) {
    await sendText(fromRaw, "🎉 Você não possui contas pendentes no momento!");
    return;
  }
  let message = "📅 *Contas a pagar pendentes*\n\n";
  pending.forEach((row, index) => {
    message += renderItem(row, index + 1);
  });
  await sendText(fromRaw, message);
}

async function listRowsForSelection(fromRaw, userNorm, mode) {
  const rows = await allRowsForUser(userNorm);
  const sorted = rows
    .slice()
    .sort((a, b) => getEffectiveDate(b) - getEffectiveDate(a))
    .slice(0, 15);
  if (!sorted.length) {
    await sendText(fromRaw, "Não encontrei lançamentos recentes.");
    return;
  }
  let message = mode === "edit" ? "✏️ *Escolha o lançamento para editar*\n\n" : "🗑️ *Escolha o lançamento para excluir*\n\n";
  sorted.forEach((row, index) => {
    const idx = index + 1;
    const conta = getVal(row, "conta") || getVal(row, "descricao") || "Lançamento";
    message += `${numberToKeycapEmojis(idx)} ${conta} • ${formatCurrencyBR(getVal(row, "valor"))} • ${formatBRDate(
      getEffectiveDate(row)
    )}\n`;
  });
  message += `\nDigite o número (1-${sorted.length}).`;
  if (mode === "edit") {
    sessionEdit.set(userNorm, { awaiting: "index", rows: sorted });
  } else {
    sessionDelete.set(userNorm, { awaiting: "index", rows: sorted });
  }
  await sendText(fromRaw, message);
}

async function confirmDeleteRow(fromRaw, userNorm, row) {
  sessionDelete.set(userNorm, { awaiting: "confirm", row });
  const summary = formatEntrySummary(row);
  await sendWA({
    messaging_product: "whatsapp",
    to: fromRaw,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `${summary}\n\nDeseja excluir este lançamento?` },
      action: {
        buttons: [{ type: "reply", reply: { id: "DEL:CONFIRM", title: "Sim" } }],
      },
    },
  });
}

async function finalizeDeleteConfirmation(fromRaw, userNorm, confirmed) {
  const state = sessionDelete.get(userNorm);
  if (!state || state.awaiting !== "confirm") return false;
  if (confirmed) {
    await deleteRow(state.row);
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "✅ Lançamento excluído com sucesso!");
  } else {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada.");
  }
  return true;
}

async function handleDeleteConfirmation(fromRaw, userNorm, text) {
  const trimmed = text.trim().toLowerCase();
  return finalizeDeleteConfirmation(fromRaw, userNorm, trimmed === "sim");
}

async function handleEditFlow(fromRaw, userNorm, text) {
  const state = sessionEdit.get(userNorm);
  if (!state) return false;
  if (state.awaiting === "index") {
    const idx = Number(text.trim());
    if (!idx || idx < 1 || idx > state.rows.length) {
      await sendText(fromRaw, "Número inválido. Tente novamente.");
      return true;
    }
    const row = state.rows[idx - 1];
    sessionEdit.set(userNorm, { awaiting: "field", row });
    await sendText(
      fromRaw,
      `✏️ Editar lançamento\n\nEscolha o que deseja alterar:\n\n🏷 Conta\n📝 Descrição\n💰 Valor\n📅 Data\n📌 Status\n📂 Categoria\n\n💡 Dica: Digite exatamente o nome do item que deseja editar.\n(ex: valor, data, categoria...)`
    );
    return true;
  }
  if (state.awaiting === "field") {
    const field = text.trim().toLowerCase();
    const valid = ["conta", "descricao", "valor", "data", "status", "categoria"];
    if (!valid.includes(field)) {
      await sendText(fromRaw, "Campo inválido. Tente novamente.");
      return true;
    }
    sessionEdit.set(userNorm, { awaiting: "value", row: state.row, field });
    await sendText(fromRaw, `Digite o novo valor para *${field}*.`);
    return true;
  }
  if (state.awaiting === "value") {
    const { row, field } = state;
    if (field === "valor") {
      setVal(row, "valor", toNumber(text));
    } else if (field === "data") {
      const date = parseDateToken(text.trim());
      if (!date) {
        await sendText(fromRaw, "Data inválida. Use dd/mm/aaaa ou palavras como hoje/amanhã.");
        return true;
      }
      const iso = date.toISOString();
      setVal(row, "vencimento_iso", iso);
      setVal(row, "vencimento_br", formatBRDate(date));
      setVal(row, "timestamp", date.toISOString());
    } else if (field === "status") {
      const lower = text.trim().toLowerCase();
      const validStatus = ["pago", "pendente", "recebido"];
      if (!validStatus.includes(lower)) {
        await sendText(fromRaw, "Status inválido. Use pago, pendente ou recebido.");
        return true;
      }
      setVal(row, "status", lower);
    } else if (field === "categoria") {
      const categoria = text.trim();
      const detected = detectCategory(categoria, getVal(row, "tipo"));
      setVal(row, "categoria", categoria || detected.slug);
      setVal(row, "categoria_emoji", detected.emoji);
    } else {
      setVal(row, field === "conta" ? "conta" : "descricao", text.trim());
    }
    await saveRow(row);
    sessionEdit.delete(userNorm);
    await sendText(fromRaw, "✅ Lançamento atualizado com sucesso!");
    return true;
  }
  return false;
}

async function handleFixedDeleteFlow(fromRaw, userNorm, text) {
  const state = sessionFixedDelete.get(userNorm);
  if (!state || state.awaiting !== "index") return false;
  const idx = Number(text.trim());
  if (!idx || idx < 1 || idx > state.rows.length) {
    await sendText(fromRaw, "Número inválido. Tente novamente.");
    return true;
  }
  const row = state.rows[idx - 1];
  sessionFixedDelete.delete(userNorm);
  await confirmDeleteRow(fromRaw, userNorm, row);
  return true;
}

async function handleDeleteFlow(fromRaw, userNorm, text) {
  const state = sessionDelete.get(userNorm);
  if (!state) return false;
  if (state.awaiting === "index") {
    const idx = Number(text.trim());
    if (!idx || idx < 1 || idx > state.rows.length) {
      await sendText(fromRaw, "Número inválido. Tente novamente.");
      return true;
    }
    const row = state.rows[idx - 1];
    await confirmDeleteRow(fromRaw, userNorm, row);
    return true;
  }
  if (state.awaiting === "confirm") {
    return handleDeleteConfirmation(fromRaw, userNorm, text);
  }
  return false;
}

// ============================
// Registro de lançamentos
// ============================
async function registerEntry(fromRaw, userNorm, text, tipoPreferencial) {
  const parsed = parseRegisterText(text);
  if (tipoPreferencial) parsed.tipo = tipoPreferencial;
  if (!parsed.valor) {
    await sendText(fromRaw, "Não consegui identificar o valor. Informe algo como 150,00.");
    return;
  }
  const data = parsed.data || new Date();
  const iso = data.toISOString();
  const categoria = detectCategory(parsed.descricao, parsed.tipo);
  const payload = {
    row_id: generateRowId(),
    timestamp: new Date().toISOString(),
    user: userNorm,
    user_raw: fromRaw,
    tipo: parsed.tipo,
    conta: parsed.descricao,
    valor: parsed.valor,
    vencimento_iso: iso,
    vencimento_br: formatBRDate(data),
    tipo_pagamento: "",
    codigo_pagamento: "",
    status: parsed.status,
    fixa: "nao",
    fix_parent_id: "",
    vencimento_dia: data.getDate(),
    categoria: categoria.slug,
    categoria_emoji: categoria.emoji,
    descricao: parsed.descricao,
  };
  await createRow(payload);
  const categoriaLabel = formatCategoryLabel(payload.categoria, categoria.emoji);
  const valorFormatado = formatCurrencyBR(parsed.valor);
  const dataFormatada = formatBRDate(data);
  const statusFormatado = parsed.status || "pendente";
  const resumo = `📘 Resumo do lançamento:\n📝 Descrição: ${parsed.descricao}\n💰 Valor: ${valorFormatado}\n📅 Data: ${dataFormatada}\n🏷 Status: ${statusFormatado}\n📂 Categoria: ${categoriaLabel}`;
  if (payload.tipo === "conta_receber") {
    await sendText(
      fromRaw,
      `💵 Recebimento registrado com sucesso!\n\n${resumo}\n\n🎯 O saldo foi atualizado automaticamente, refletindo sua nova entrada.`
    );
  } else {
    await sendText(
      fromRaw,
      `✅ Pagamento registrado com sucesso!\n\n${resumo}\n\n💡 A FinPlanner IA já atualizou seu saldo e adicionou este pagamento ao relatório do período.`
    );
  }
  await sendWelcomeList(fromRaw);
}

// ============================
// Intent detection
// ============================
const detectIntent = (text) => {
  const lower = (text || "").toLowerCase();
  const normalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/(oi|ola|opa|bom dia|boa tarde|boa noite)/.test(normalized)) return "boas_vindas";
  if (/\brelat[óo]rios?\b/.test(lower)) return "relatorios_menu";
  if (/\brelat[óo]rio\s+completo\b/.test(lower) || /\bcompleto\b/.test(lower)) return "relatorio_completo";
  if (/\blan[cç]amentos\b|extrato/.test(lower)) return "listar_lancamentos";
  if (/contas?\s+a\s+pagar|pendentes|a pagar/.test(lower)) return "listar_pendentes";
  if (/editar lan[cç]amentos?/.test(lower)) return "editar";
  if (/excluir lan[cç]amentos?/.test(lower)) return "excluir";
  if (/registrar recebimento|recebimento/.test(lower)) return "registrar_recebimento";
  if (/registrar pagamento|pagamento/.test(lower)) return "registrar_pagamento";
  return "desconhecido";
};

// ============================
// Webhook
// ============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

async function handleInteractiveMessage(from, payload) {
  const { type } = payload;
  const userNorm = normalizeUser(from);
  if (type === "button_reply") {
    const id = payload.button_reply.id;
    if (id === "DEL:CONFIRM") {
      const handled = await finalizeDeleteConfirmation(from, userNorm, true);
      if (!handled) {
        await sendText(from, "Nenhum lançamento selecionado para excluir.");
      }
      return;
    }
    if (id.startsWith("REL:CAT:")) {
      const [, , cat] = id.split(":");
      await startReportCategoryFlow(from, userNorm, cat);
      return;
    }
    if (id.startsWith("REL:PER:")) {
      const [, , cat, opt] = id.split(":");
      const now = new Date();
      if (opt === "mes_atual") {
        const range = {
          start: startOfMonth(now.getFullYear(), now.getMonth()),
          end: endOfMonth(now.getFullYear(), now.getMonth()),
        };
        await showReportByCategory(from, userNorm, cat, range);
        sessionPeriod.delete(userNorm);
      }
      if (opt === "todo_periodo") {
        const rows = await allRowsForUser(userNorm);
        let min = null;
        rows.forEach((row) => {
          const dt = getEffectiveDate(row);
          if (dt && (!min || dt < min)) min = dt;
        });
        const start = min ? startOfDay(min) : startOfDay(new Date());
        const end = endOfDay(new Date());
        await showReportByCategory(from, userNorm, cat, { start, end });
        sessionPeriod.delete(userNorm);
      }
      if (opt === "personalizado") {
        sessionPeriod.set(userNorm, { mode: "report", category: cat, awaiting: "range" });
        await sendText(
          from,
          `🗓️ *Selecione um período personalizado*\n\nEnvie no formato:\n01/10/2025 a 31/10/2025\n\n💡 Dica: você pode usar "a", "-", "até".`
        );
      }
      return;
    }
    if (id.startsWith("LANC:PER:")) {
      const [, , opt] = id.split(":");
      const now = new Date();
      if (opt === "mes_atual") {
        const range = {
          start: startOfMonth(now.getFullYear(), now.getMonth()),
          end: endOfMonth(now.getFullYear(), now.getMonth()),
        };
        await showLancamentos(from, userNorm, range);
      } else if (opt === "personalizado") {
        sessionPeriod.set(userNorm, { mode: "lanc", awaiting: "range" });
        await sendText(
          from,
          `🗓️ *Selecione um período personalizado*\n\nEnvie no formato:\n01/10/2025 a 31/10/2025\n\n💡 Dica: você pode usar "a", "-", "até".`
        );
      }
      return;
    }
    if (id === "DEL:LAST") {
      const rows = await allRowsForUser(userNorm);
      const sorted = rows.sort((a, b) => new Date(getVal(b, "timestamp")) - new Date(getVal(a, "timestamp")));
      const last = sorted[0];
      if (!last) {
        await sendText(from, "Não há lançamentos para excluir.");
        return;
      }
      await confirmDeleteRow(from, userNorm, last);
      return;
    }
    if (id === "DEL:LIST") {
      await listRowsForSelection(from, userNorm, "delete");
      return;
    }
    if (id === "CFIX:CAD") {
      await sendCadastrarContaFixaMessage(from);
      return;
    }
    if (id === "CFIX:DEL") {
      await sendExcluirContaFixaMessage(from, userNorm);
      return;
    }
  }

  if (type === "list_reply") {
    const id = payload.list_reply.id;
    if (id.startsWith("REL:CAT:")) {
      const [, , cat] = id.split(":");
      await startReportCategoryFlow(from, userNorm, cat);
      return;
    }
    if (id === "MENU:registrar_pagamento") {
      sessionRegister.set(userNorm, { tipo: "conta_pagar" });
      await sendText(
        from,
        `💰 Novo lançamento de pagamento ou gasto\n\nInforme os detalhes abaixo para registrar corretamente:\n\n📝 Descrição: O que foi pago?\n(ex: Conta de luz, Internet, Academia)\n\n💰 Valor: Quanto custou?\n(ex: 120,00)\n\n📅 Data: Quando foi pago ou deve ser pago?\n(ex: hoje, amanhã ou 25/10/2025)\n\n🏷 Status: Já foi pago ou ainda está pendente?\n(ex: pago / pendente)\n\n📂 Categoria: (opcional)\nA FinPlanner identifica automaticamente, mas você pode informar (ex: Internet, Energia, Alimentação).\n\n💡 Dica: Você também pode escrever tudo em uma linha!\nExemplo:\n➡ Pagar internet 120 amanhã\n➡ Academia 80,00 pago hoje`
      );
      return;
    }
    if (id === "MENU:registrar_recebimento") {
      sessionRegister.set(userNorm, { tipo: "conta_receber" });
      await sendText(
        from,
        `💵 Novo lançamento de recebimento\n\nInforme os detalhes abaixo para registrar sua entrada de dinheiro:\n\n📝 Descrição: O que você recebeu?\n(ex: Venda de peças, Salário, Reembolso)\n\n💰 Valor: Quanto foi recebido?\n(ex: 300,00)\n\n📅 Data: Quando foi ou será recebido?\n(ex: hoje, amanhã ou 30/10/2025)\n\n🏷 Status: Já recebeu ou ainda está pendente?\n(ex: recebido / pendente)\n\n📂 Categoria: (opcional)\nA FinPlanner identifica automaticamente (ex: Venda, Salário, Transferência).\n\n💡 Dica: Você pode enviar tudo de uma vez!\nExemplo:\n➡ Receber venda 300 amanhã\n➡ Pix recebido cliente 150 hoje`
      );
      return;
    }
    if (id === "MENU:contas_pagar") {
      await listPendingPayments(from, userNorm);
      return;
    }
    if (id === "MENU:contas_fixas") {
      await sendContasFixasMenu(from);
      return;
    }
    if (id === "MENU:relatorios") {
      await sendRelatoriosButtons(from);
      return;
    }
    if (id === "MENU:lancamentos") {
      await sendLancPeriodoButtons(from);
      return;
    }
    if (id === "MENU:editar") {
      await listRowsForSelection(from, userNorm, "edit");
      return;
    }
    if (id === "MENU:excluir") {
      await sendDeleteMenu(from);
      return;
    }
    if (id === "MENU:ajuda") {
      await sendText(
        from,
        `⚙️ *Ajuda & Exemplos*\n\n🧾 Registrar pagamento\nEx.: Internet 120 pago hoje\n\n💵 Registrar recebimento\nEx.: Venda curso 200 recebido hoje\n\n📊 Relatórios\nToque em Relatórios → escolha *Contas a pagar*, *Recebimentos* ou *Pagamentos* → selecione o período.\n\n🧾 Meus lançamentos\nToque em Meus lançamentos → escolha *Mês atual* ou *Data personalizada*.\n\n✏️ Editar lançamentos\nToque em Editar lançamentos → escolha pelo número → selecione o que deseja alterar.\n\n🗑️ Excluir lançamento\nToque em Excluir lançamento → Último lançamento ou Listar lançamentos.`
      );
      return;
    }
  }
}

function parseRangeMessage(text) {
  const match = text.match(/(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}).*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/);
  if (!match) return null;
  const start = parseDateToken(match[1]);
  const end = parseDateToken(match[2]);
  if (!start || !end) return null;
  return { start: startOfDay(start), end: endOfDay(end) };
}

async function handleUserText(fromRaw, text) {
  const userNorm = normalizeUser(fromRaw);
  const trimmed = (text || "").trim();

  if (await handleFixedDeleteFlow(fromRaw, userNorm, trimmed)) return;
  if (await handleEditFlow(fromRaw, userNorm, trimmed)) return;
  if (await handleDeleteFlow(fromRaw, userNorm, trimmed)) return;

  const regState = sessionRegister.get(userNorm);
  if (regState) {
    await registerEntry(fromRaw, userNorm, text, regState.tipo);
    sessionRegister.delete(userNorm);
    return;
  }

  const perState = sessionPeriod.get(userNorm);
  if (perState && perState.awaiting === "range") {
    const range = parseRangeMessage(trimmed.replace(/até/gi, "-").replace(/a/gi, "-"));
    if (!range) {
      await sendText(fromRaw, "Formato inválido. Use 01/10/2025 a 31/10/2025.");
      return;
    }
    if (perState.mode === "report") {
      await showReportByCategory(fromRaw, userNorm, perState.category, range);
    } else if (perState.mode === "lanc") {
      await showLancamentos(fromRaw, userNorm, range);
    }
    sessionPeriod.delete(userNorm);
    return;
  }

  const intent = detectIntent(trimmed);
  switch (intent) {
    case "boas_vindas":
      await sendWelcomeList(fromRaw);
      break;
    case "relatorios_menu":
      await sendRelatoriosButtons(fromRaw);
      break;
    case "relatorio_completo": {
      const now = new Date();
      const range = {
        start: startOfMonth(now.getFullYear(), now.getMonth()),
        end: endOfMonth(now.getFullYear(), now.getMonth()),
      };
      await showReportByCategory(fromRaw, userNorm, "all", range);
      break;
    }
    case "listar_lancamentos":
      await sendLancPeriodoButtons(fromRaw);
      break;
    case "listar_pendentes":
      await listPendingPayments(fromRaw, userNorm);
      break;
    case "editar":
      await listRowsForSelection(fromRaw, userNorm, "edit");
      break;
    case "excluir":
      await sendDeleteMenu(fromRaw);
      break;
    case "registrar_recebimento":
      await registerEntry(fromRaw, userNorm, text, "conta_receber");
      break;
    case "registrar_pagamento":
      await registerEntry(fromRaw, userNorm, text, "conta_pagar");
      break;
    default:
      await sendWelcomeList(fromRaw);
      break;
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body?.object === "whatsapp_business_account") {
      const entry = body.entry || [];
      for (const ent of entry) {
        const changes = ent.changes || [];
        for (const change of changes) {
          const value = change.value || {};
          const messages = value.messages || [];
          const statuses = value.statuses || [];

          for (const status of statuses) {
            if (status.status === "failed" && ADMIN_WA_NUMBER) {
              await sendText(
                ADMIN_WA_NUMBER,
                `⚠️ Falha ao entregar mensagem para ${status.recipient_id}: ${status.errors?.[0]?.title || ""}`
              );
            }
          }

          for (const message of messages) {
            const from = message.from;
            const type = message.type;
            if (type === "text") {
              await handleUserText(from, message.text?.body || "");
            } else if (type === "interactive") {
              await handleInteractiveMessage(from, message.interactive);
            } else if (type === "button") {
              await handleInteractiveMessage(from, { type: "button_reply", button_reply: message.button });
            } else {
              await sendText(from, "Ainda não entendi esse tipo de mensagem, envie texto ou use o menu.");
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error.message);
    res.sendStatus(200);
  }
});

// ============================
// CRON diário 08:00 (America/Maceio)
// ============================
cron.schedule(
  "0 8 * * *",
  async () => {
    try {
      const sheet = await ensureSheet();
      const rows = await sheet.getRows();
      const today = startOfDay(new Date()).getTime();

      const duePay = rows
        .filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") !== "pago" && getVal(row, "vencimento_iso"))
        .filter((row) => startOfDay(new Date(getVal(row, "vencimento_iso"))).getTime() === today);

      const dueRecv = rows
        .filter(
          (row) =>
            getVal(row, "tipo") === "conta_receber" &&
            !["pago", "recebido"].includes((getVal(row, "status") || "").toLowerCase()) &&
            getVal(row, "vencimento_iso")
        )
        .filter((row) => startOfDay(new Date(getVal(row, "vencimento_iso"))).getTime() === today);

      const notify = async (row, isReceber = false) => {
        const toRaw = getVal(row, "user_raw") || getVal(row, "user");
        const tipoTxt = isReceber ? "recebimento" : "pagamento";
        await sendText(
          toRaw,
          `⚠️ *Lembrete de ${tipoTxt}!*\n\n📘 ${getVal(row, "conta") || "Lançamento"}\n📝 ${getVal(row, "descricao") || getVal(row, "conta") || "—"}\n💰 ${formatCurrencyBR(
            getVal(row, "valor")
          )}\n📅 Para hoje (${formatBRDate(getVal(row, "vencimento_iso"))})`
        );
        if (getVal(row, "tipo_pagamento") === "pix")
          await sendCopyButton(toRaw, "💳 Chave Pix:", getVal(row, "codigo_pagamento"), "Copiar Pix");
        if (getVal(row, "tipo_pagamento") === "boleto")
          await sendCopyButton(toRaw, "🧾 Código de barras:", getVal(row, "codigo_pagamento"), "Copiar boleto");
      };

      for (const row of duePay) await notify(row, false);
      for (const row of dueRecv) await notify(row, true);
    } catch (error) {
      console.error("Erro no CRON:", error.message);
    }
  },
  { timezone: "America/Maceio" }
);

// ============================
// Server
// ============================
const port = PORT || 10000;
app.listen(port, () => {
  console.log(`FinPlanner IA (2025-10-23) rodando na porta ${port}`);
});
