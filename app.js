/ ============================
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
const normalizeUser = (num) => (num || "").replace(/\D/g, "");
const NUMBER_WORDS = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  três: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  catorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
  cem: 100,
  cento: 100,
  duzentos: 200,
  trezentos: 300,
  quatrocentos: 400,
  quinhentos: 500,
  seiscentos: 600,
  setecentos: 700,
  oitocentos: 800,
  novecentos: 900,
};

const NUMBER_CONNECTORS = new Set([
  "e",
  "de",
  "da",
  "do",
  "das",
  "dos",
  "reais",
  "real",
  "centavos",
  "centavo",
  "r$",
]);

const normalizeDiacritics = (text) =>
  (text || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const escapeRegex = (value) => (value || "").replace(/([.*+?^${}()|\[\]\\])/g, "\\$1");

const parseNumberWordsTokens = (tokens) => {
  let total = 0;
  let current = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (NUMBER_CONNECTORS.has(token)) continue;
    if (token === "mil") {
      total += (current || 1) * 1000;
      current = 0;
      continue;
    }
    const value = NUMBER_WORDS[token];
    if (typeof value === "number") {
      current += value;
    } else {
      return null;
    }
  }
  return total + current || null;
};

const extractNumberWords = (text) => {
  const normalized = normalizeDiacritics(text).toLowerCase();
  const tokens = normalized.split(/[^a-z$]+/).filter(Boolean);
  let sequence = [];
  for (const token of tokens) {
    if (NUMBER_CONNECTORS.has(token) || NUMBER_WORDS[token] !== undefined || token === "mil") {
      sequence.push(token);
    } else if (sequence.length) {
      break;
    }
  }
  if (!sequence.length) return null;
  const parsed = parseNumberWordsTokens(sequence);
  if (!parsed) return null;
  return { amount: parsed, raw: sequence.join(" ") };
};

const parseNumericToken = (rawToken) => {
  if (rawToken === undefined || rawToken === null) return null;
  let token = rawToken.toString().trim().toLowerCase();
  if (!token) return null;

  token = token.replace(/^r\$/i, "");

  if (token.endsWith("mil")) {
    const baseToken = token.slice(0, -3).trim();
    const baseValue = baseToken ? parseNumericToken(baseToken) : 1;
    return baseValue ? baseValue * 1000 : null;
  }

  let multiplier = 1;
  if (token.endsWith("k")) {
    multiplier = 1000;
    token = token.slice(0, -1);
  }

  token = token.replace(/^r\$/i, "").replace(/\s+/g, "");
  token = token.replace(/[^0-9.,-]/g, "");
  if (!token) return null;

  if (token.includes(".") && token.includes(",")) {
    const lastDot = token.lastIndexOf(".");
    const lastComma = token.lastIndexOf(",");
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandsSep = decimalSep === "." ? "," : ".";
    const thousandsRegex = new RegExp(`\\${thousandsSep}`, "g");
    token = token.replace(thousandsRegex, "");
    const decimalRegex = new RegExp(`\\${decimalSep}`, "g");
    token = token.replace(decimalRegex, ".");
  } else if (token.includes(",")) {
    const lastComma = token.lastIndexOf(",");
    const decimals = token.length - lastComma - 1;
    if (decimals === 3 && token.replace(/[^0-9]/g, "").length > 3) {
      token = token.replace(/,/g, "");
    } else {
      token = token.replace(/,/g, ".");
    }
  } else if (token.includes(".")) {
    const lastDot = token.lastIndexOf(".");
    const decimals = token.length - lastDot - 1;
    if (decimals === 3 && token.replace(/[^0-9]/g, "").length > 3) {
      token = token.replace(/\./g, "");
    }
  }

  const parsed = parseFloat(token);
  if (!Number.isFinite(parsed)) return null;
  return parsed * multiplier;
};

const extractAmountFromText = (text) => {
  if (!text) return { amount: 0 };
  const numericPattern = /(?:r\$\s*)?([0-9]+(?:[.,\s][0-9]+)*(?:k)?|[0-9]+\s?mil)/gi;
  let match;
  while ((match = numericPattern.exec(text)) !== null) {
    const raw = match[0];
    const value = parseNumericToken(raw);
    if (value) return { amount: value, raw };
  }

  const words = extractNumberWords(text);
  if (words) return words;

  const fallbackMatch = text.toString().match(/\d+/);
  if (fallbackMatch) {
    const value = parseNumericToken(fallbackMatch[0]);
    if (value) return { amount: value, raw: fallbackMatch[0] };
  }

  return { amount: 0 };
};

const toNumber = (value) => {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return value;
  const result = extractAmountFromText(String(value));
  return Number.isFinite(result.amount) ? result.amount : 0;
};
const formatCurrencyBR = (value) => {
  const num = Number(value || 0);
  return `R$${Math.abs(num).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};
const statusIconLabel = (status) => {
  const normalized = (status || "").toString().toLowerCase();
  if (normalized === "pago") return "✅ Pago";
  if (normalized === "recebido") return "✅ Recebido";
  return "⏳ Pendente";
};

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
  if (lower === "ontem") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
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
  const parts = raw.split(/[_-]+/).filter(Boolean);
  const friendly =
    parts.length === 0
      ? raw
      : parts
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(" / ");
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
const formatEntryBlock = (row, options = {}) => {
  const { index, headerLabel, dateText } = options;
  const descricao = (getVal(row, "descricao") || getVal(row, "conta") || "Lançamento").toString().trim();
  const categoriaLabel = formatCategoryLabel(getVal(row, "categoria"), getVal(row, "categoria_emoji"));
  const valor = formatCurrencyBR(toNumber(getVal(row, "valor")));
  const data = dateText || formatBRDate(getEffectiveDate(row)) || "—";
  const statusRaw = (getVal(row, "status") || "pendente").toString().toLowerCase();
  const statusLabel = statusRaw === "recebido" ? "✅ Recebido" : statusRaw === "pago" ? "✅ Pago" : "⏳ Pendente";
  const tipoRaw = (getVal(row, "tipo") || "conta_pagar").toString();
  const tipoLabel = tipoRaw === "conta_receber" ? "💵 Receita" : "💸 Despesa";
  const fields = [
    `📝 Descrição: ${descricao}`,
    `📂 Categoria: ${categoriaLabel}`,
    `💰 Valor: ${valor}`,
    `📅 Data: ${data}`,
    `🏷 Status: ${statusLabel}`,
    `🔁 Tipo: ${tipoLabel}`,
  ];
  if (headerLabel) {
    return `${headerLabel}\n\n${fields.join("\n")}`;
  }
  if (typeof index === "number") {
    const [first, ...rest] = fields;
    const prefix = `${numberToKeycapEmojis(index)} ${first}`;
    return [prefix, ...rest].join("\n");
  }
  return `📘 Lançamento\n\n${fields.join("\n")}`;
};

const formatEntrySummary = (row, options = {}) =>
  formatEntryBlock(row, { ...options, headerLabel: options.headerLabel || "📘 *Resumo do lançamento*" });

const renderReportList = (title, rows) => {
  let message = `📊 *${title}*\n\n`;
  if (!rows.length) {
    return `${message}✅ Nenhum lançamento encontrado para o período selecionado.`;
  }
  const blocks = rows.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  message += blocks.join("\n\n");
  message += `\n\n💰 *Total:* ${formatCurrencyBR(sumValues(rows))}`;
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
  return `\n\n💰 *Total de Recebimentos:* ${formatCurrencyBR(totalRec)}\n💸 *Total de Pagamentos:* ${formatCurrencyBR(totalPag)}\n${saldoLine}`;
};

// ============================
// Menus interativos
// ============================
const MAIN_MENU_SECTIONS = [
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
];

const sendMainMenu = (to, { greeting = false } = {}) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: {
        text: greeting
          ? `👋 Olá! Eu sou a FinPlanner IA.\n\n💡 Organizo seus pagamentos, ganhos e gastos de forma simples e automática.\n\nToque em *Abrir menu* ou digite o que deseja fazer.`
          : "Toque em *Abrir menu* ou digite o que deseja fazer.",
      },
      action: {
        button: "Abrir menu",
        sections: MAIN_MENU_SECTIONS,
      },
    },
  });

const sendWelcomeList = (to) => sendMainMenu(to, { greeting: true });

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
          { type: "reply", reply: { id: "CFIX:LIST", title: "Listar contas fixas" } },
          { type: "reply", reply: { id: "CFIX:DEL", title: "Excluir contas fixas" } },
        ],
      },
    },
  });

const sendCadastrarContaFixaMessage = (to) =>
  sendText(
    to,
    `♻ Cadastro de conta fixa\n\nUse este formato para registrar contas que se repetem todo mês automaticamente:\n\n📝 Descrição: Nome da conta\n(ex: Internet, Academia, Aluguel)\n\n💰 Valor: Valor fixo da conta\n(ex: 120,00)\n\n📅 Dia de vencimento: Data que vence todo mês\n(ex: todo dia 05)\n\n💡 Exemplo pronto:\n➡ Conta fixa internet 120,00 todo dia 05\n\n🔔 A FinPlanner IA lançará esta conta automaticamente todo mês e te avisará no dia do vencimento.`
  );

const sendListarContasFixasMessage = async (to, userNorm) => {
  const fixed = await getFixedAccounts(userNorm);
  if (!fixed.length) {
    await sendText(to, "Você ainda não possui contas fixas cadastradas.");
    return;
  }
  const list = buildFixedAccountList(fixed);
  await sendText(to, `♻️ *Contas fixas cadastradas*\n\n${list}`);
};

const buildFixedAccountList = (rows) =>
  rows
    .map((row, index) => {
      const dia = Number(getVal(row, "vencimento_dia"));
      const dateText = Number.isFinite(dia) && dia > 0 ? `Dia ${String(dia).padStart(2, "0")}` : undefined;
      return formatEntryBlock(row, {
        index: index + 1,
        dateText,
      });
    })
    .join("\n\n");

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
  const message = `🗑 Excluir conta fixa\n\nPara remover uma conta recorrente, digite o número de qual deseja excluir:\n\n${list}\n\nEnvie o número da conta fixa que deseja excluir.`;
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
  const original = (text || "").toString();
  const normalized = normalizeDiacritics(original).toLowerCase();
  const isReceber = /\b(receb|receita|entrada|venda|vendi|ganhei)\b/.test(normalized);
  const tipo = isReceber ? "conta_receber" : "conta_pagar";

  let status = "pendente";
  if (/\b(recebid[oa]?|recebi|recebemos|creditad[oa]|caiu|confirmad[oa])\b/.test(normalized)) {
    status = "recebido";
  } else if (/\b(pag[ouei]|paguei|quitad[oa]|liquidad[oa]|transferi|transferido)\b/.test(normalized)) {
    status = "pago";
  } else if (/\b(pendente|a pagar|a receber|aguardando|em aberto)\b/.test(normalized)) {
    status = "pendente";
  }
  if (tipo === "conta_receber" && status === "pago") status = "recebido";
  if (tipo === "conta_pagar" && status === "recebido") status = "pago";

  const amountInfo = extractAmountFromText(original);
  const valor = amountInfo.amount || 0;

  let data = null;
  const dateMatch = original.match(/(hoje|amanh[ãa]|ontem|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);
  if (dateMatch) data = parseDateToken(dateMatch[1]);

  let descricao = original;
  if (amountInfo.raw) {
    const rawEscaped = escapeRegex(amountInfo.raw);
    descricao = descricao.replace(new RegExp(rawEscaped, "i"), "");
  }
  descricao = descricao
    .replace(/(hoje|amanh[ãa]|ontem)/gi, "")
    .replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/gi, "")
    .replace(/\b(recebimento|receber|recebido|recebi|pagamento|pagar|pago|paguei|pendente|quitad[oa]|liquidad[oa]|entrada|receita)\b/gi, "")
    .replace(/\b(valor|lançamento|lancamento|novo)\b/gi, "")
    .replace(/r\$/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (descricao) {
    const tokens = descricao.split(/\s+/);
    const filtered = tokens.filter((token) => {
      const normalizedToken = normalizeDiacritics(token).toLowerCase();
      if (NUMBER_CONNECTORS.has(normalizedToken)) return false;
      if (NUMBER_WORDS[normalizedToken] !== undefined) return false;
      if (normalizedToken === "mil") return false;
      return true;
    });
    descricao = filtered.join(" ");
  }

  descricao = descricao.trim();
  if (!descricao) descricao = tipo === "conta_receber" ? "Recebimento" : "Pagamento";

  let tipoPagamento = "";
  if (/\bpix\b/.test(normalized)) tipoPagamento = "pix";
  else if (/\bboleto\b/.test(normalized)) tipoPagamento = "boleto";
  else if (/\b(cart[aã]o\s*de\s*cr[eé]dito|cart[aã]o\s*cr[eé]dito|cr[eé]dito\s*no?\s*cart[aã]o|credito\b.*cartao)\b/.test(normalized))
    tipoPagamento = "cartao_credito";
  else if (/\b(cart[aã]o\s*de\s*d[eé]bito|cart[aã]o\s*d[eé]bito|d[eé]bito\s*no?\s*cart[aã]o|debito\b.*cartao)\b/.test(normalized))
    tipoPagamento = "cartao_debito";
  else if (/\bdinheiro\b/.test(normalized)) tipoPagamento = "dinheiro";
  else if (/\btransfer/i.test(normalized)) tipoPagamento = "transferencia";

  return {
    tipo,
    valor,
    data: data || new Date(),
    status,
    descricao,
    tipoPagamento,
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
  const blocks = filtered.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  const message = `🧾 *Meus lançamentos*\n\n${blocks.join("\n\n")}`;
  await sendText(fromRaw, message);
}

async function listPendingPayments(fromRaw, userNorm) {
  const rows = await allRowsForUser(userNorm);
  const pending = rows.filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") !== "pago");
  if (!pending.length) {
    await sendText(fromRaw, "🎉 Você não possui contas pendentes no momento!");
    return;
  }
  const blocks = pending.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  const message = `📅 *Contas a pagar pendentes*\n\n${blocks.join("\n\n")}`;
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
  const blocks = sorted.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  if (mode === "edit") {
    const message = `✏️ Selecione o lançamento que deseja editar:\n\n${blocks.join("\n\n")}\n\nEnvie o número correspondente (1-${sorted.length}).`;
    sessionEdit.set(userNorm, { awaiting: "index", rows: sorted, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    await sendText(fromRaw, message);
  } else {
    const message =
      "📋 Selecione o lançamento que deseja excluir:\n\n" +
      `${blocks.join("\n\n")}\n\n📋 Selecione os lançamentos que deseja excluir:\n\nEnvie os números separados por vírgula ou espaço.\nExemplo: 1, 3, 5 ou 2 4 6`;
    sessionDelete.set(userNorm, { awaiting: "index", rows: sorted, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    await sendText(fromRaw, message);
  }
}

const SESSION_TIMEOUT_MS = 2 * 60 * 1000;

const selectionStopWords = new Set(
  [
    "excluir",
    "exclua",
    "remover",
    "remova",
    "apagar",
    "apague",
    "deletar",
    "delete",
    "editar",
    "edita",
    "lancamento",
    "lancamentos",
    "numero",
    "numeros",
    "número",
    "números",
    "item",
    "itens",
    "selecionar",
    "selecione",
    "selecao",
    "escolher",
    "escolha",
    "quero",
    "para",
    "pra",
    "de",
    "do",
    "da",
    "dos",
    "das",
    "o",
    "a",
    "os",
    "as",
    "um",
    "uma",
  ].map((word) => normalizeDiacritics(word))
);

const cleanSelectionTerms = (normalizedText) =>
  normalizedText
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !selectionStopWords.has(token))
    .join(" ");

const parseSelectionIndexes = (text, max) => {
  const normalized = normalizeDiacritics(text).toLowerCase();
  const indexes = new Set();
  const rangeRegex = /(\d+)\s*(?:a|ate|até|ate|ao|à|\-|–|—)\s*(\d+)/g;
  let rangeMatch;
  while ((rangeMatch = rangeRegex.exec(normalized))) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    for (let i = from; i <= to; i += 1) {
      indexes.add(i);
    }
  }
  const numberRegex = /\b\d+\b/g;
  let match;
  while ((match = numberRegex.exec(normalized))) {
    indexes.add(Number(match[0]));
  }
  const filtered = [...indexes].filter((idx) => Number.isFinite(idx) && idx >= 1 && idx <= max);
  filtered.sort((a, b) => a - b);
  return filtered;
};

const parseSelectionByDescription = (text, rows) => {
  const normalized = normalizeDiacritics(text).toLowerCase();
  const cleaned = cleanSelectionTerms(normalized).replace(/\d+/g, " ").trim();
  if (!cleaned) return [];
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = [];
  rows.forEach((row, idx) => {
    const base = normalizeDiacritics(
      `${getVal(row, "descricao") || ""} ${getVal(row, "conta") || ""}`
    )
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (words.every((word) => base.includes(word))) {
      matches.push(idx + 1);
    }
  });
  return matches;
};

const resolveSelectionIndexes = (text, rows) => {
  const indexes = parseSelectionIndexes(text, rows.length);
  if (indexes.length) return indexes;
  const byDescription = parseSelectionByDescription(text, rows);
  return byDescription;
};

const uniqueSelections = (selections) => {
  const seen = new Set();
  const list = [];
  for (const item of selections) {
    if (!item || !item.row) continue;
    const rowId = getVal(item.row, "row_id") || getVal(item.row, "timestamp") || `${item.displayIndex}-${Math.random()}`;
    if (seen.has(rowId)) continue;
    seen.add(rowId);
    list.push(item);
  }
  return list;
};

const setDeleteState = (userNorm, state) => {
  const current = sessionDelete.get(userNorm) || {};
  sessionDelete.set(userNorm, { ...current, ...state });
};

const resetDeleteTimeout = (state) => ({ ...state, expiresAt: Date.now() + SESSION_TIMEOUT_MS });

const deleteStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

async function promptNextDeleteConfirmation(to, userNorm) {
  const state = sessionDelete.get(userNorm);
  if (!state || !Array.isArray(state.queue) || !state.queue.length) return;
  const currentIndex = state.currentIndex || 0;
  const currentItem = state.queue[currentIndex];
  if (!currentItem || !currentItem.row) {
    sessionDelete.delete(userNorm);
    return;
  }
  const summary = formatEntrySummary(currentItem.row, { headerLabel: "🧾 Lançamento selecionado:" });
  const body = `⚠ Confirmar exclusão do lançamento:\n\n${summary}\n\nDeseja realmente excluir este lançamento?`;
  const nextState = resetDeleteTimeout({ ...state, awaiting: "confirm", currentIndex });
  sessionDelete.set(userNorm, nextState);
  await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: "DEL:CONFIRM:YES", title: "✅ Sim, excluir" } },
          { type: "reply", reply: { id: "DEL:CONFIRM:NO", title: "❌ Cancelar" } },
        ],
      },
    },
  });
}

async function confirmDeleteRows(fromRaw, userNorm, selections) {
  const validSelections = uniqueSelections(selections || []);
  if (!validSelections.length) return;
  setDeleteState(userNorm, {
    awaiting: "confirm",
    queue: validSelections,
    currentIndex: 0,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await promptNextDeleteConfirmation(fromRaw, userNorm);
}

async function finalizeDeleteConfirmation(fromRaw, userNorm, confirmed) {
  const state = sessionDelete.get(userNorm);
  if (!state || state.awaiting !== "confirm") return false;
  if (deleteStateExpired(state)) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  if (!confirmed) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada.");
    return true;
  }
  const currentIndex = state.currentIndex || 0;
  const currentItem = state.queue?.[currentIndex];
  if (!currentItem || !currentItem.row) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Nenhum lançamento selecionado para excluir.");
    return true;
  }
  await deleteRow(currentItem.row);
  await sendText(
    fromRaw,
    "🗑 Lançamento excluído com sucesso!\n\n💡 Dica: envie *Meus lançamentos* para visualizar sua lista atualizada."
  );
  const nextIndex = currentIndex + 1;
  if (!state.queue || nextIndex >= state.queue.length) {
    sessionDelete.delete(userNorm);
    return true;
  }
  setDeleteState(userNorm, {
    queue: state.queue,
    currentIndex: nextIndex,
    awaiting: "confirm",
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await promptNextDeleteConfirmation(fromRaw, userNorm);
  return true;
}

async function handleDeleteConfirmation(fromRaw, userNorm, text) {
  const normalized = normalizeDiacritics(text).toLowerCase().trim();
  if (!normalized) return false;
  if (/^(s|sim)(\b|\s)/.test(normalized) || /excluir/.test(normalized) || /confirm/.test(normalized)) {
    return finalizeDeleteConfirmation(fromRaw, userNorm, true);
  }
  if (/^(nao|não|n)(\b|\s)/.test(normalized) || /cancel/.test(normalized) || /parar/.test(normalized)) {
    return finalizeDeleteConfirmation(fromRaw, userNorm, false);
  }
  return false;
}

async function handleEditFlow(fromRaw, userNorm, text) {
  const state = sessionEdit.get(userNorm);
  if (!state) return false;
  if (state.expiresAt && Date.now() > state.expiresAt) {
    sessionEdit.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  if (state.awaiting === "index") {
    const indexes = resolveSelectionIndexes(text, state.rows || []);
    if (!indexes.length) {
      await sendText(fromRaw, "Não entendi qual lançamento deseja editar. Informe o número ou o nome.");
      return true;
    }
    const selections = indexes
      .map((idx) => ({ row: state.rows[idx - 1], displayIndex: idx }))
      .filter((item) => item.row);
    if (!selections.length) {
      await sendText(fromRaw, "Não encontrei os lançamentos informados. Tente novamente.");
      return true;
    }
    const first = selections[0];
    sessionEdit.set(userNorm, {
      awaiting: "field",
      rows: state.rows,
      queue: selections,
      currentIndex: 0,
      row: first.row,
      displayIndex: first.displayIndex,
      expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    });
    const summary = formatEntrySummary(first.row, { headerLabel: "🧾 Lançamento selecionado:" });
    await sendText(
      fromRaw,
      `${summary}\n\n✏ Editar lançamento\n\nEscolha o que deseja alterar:\n\n🏷 Conta\n📝 Descrição\n💰 Valor\n📅 Data\n📌 Status\n📂 Categoria\n\n💡 Dica: Digite exatamente o nome do item que deseja editar.\n(ex: valor, data, categoria...)`
    );
    return true;
  }
  if (state.awaiting === "field") {
    const field = text.trim().toLowerCase();
    if (/^cancelar/.test(field)) {
      sessionEdit.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      return true;
    }
    const valid = ["conta", "descricao", "valor", "data", "status", "categoria"];
    if (!valid.includes(field)) {
      await sendText(fromRaw, "Campo inválido. Tente novamente.");
      return true;
    }
    sessionEdit.set(userNorm, {
      ...state,
      awaiting: "value",
      field,
      expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    });
    await sendText(fromRaw, `Digite o novo valor para *${field}*.`);
    return true;
  }
  if (state.awaiting === "value") {
    if (/^cancelar/i.test(text.trim())) {
      sessionEdit.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      return true;
    }
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
    await sendText(fromRaw, "✅ Lançamento atualizado com sucesso!");
    const queue = state.queue || [];
    const nextIndex = (state.currentIndex || 0) + 1;
    if (queue.length && nextIndex < queue.length) {
      const next = queue[nextIndex];
      sessionEdit.set(userNorm, {
        ...state,
        awaiting: "field",
        currentIndex: nextIndex,
        row: next.row,
        displayIndex: next.displayIndex,
        field: undefined,
        expiresAt: Date.now() + SESSION_TIMEOUT_MS,
      });
      const summary = formatEntrySummary(next.row, { headerLabel: "🧾 Lançamento selecionado:" });
      await sendText(
        fromRaw,
        `${summary}\n\n✏ Editar lançamento\n\nEscolha o que deseja alterar:\n\n🏷 Conta\n📝 Descrição\n💰 Valor\n📅 Data\n📌 Status\n📂 Categoria\n\n💡 Dica: Digite exatamente o nome do item que deseja editar.\n(ex: valor, data, categoria...)`
      );
    } else {
      sessionEdit.delete(userNorm);
    }
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
  await confirmDeleteRows(fromRaw, userNorm, [{ row, displayIndex: idx }]);
  return true;
}

async function handleDeleteFlow(fromRaw, userNorm, text) {
  const state = sessionDelete.get(userNorm);
  if (!state) return false;
  if (deleteStateExpired(state)) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  if (state.awaiting === "index") {
    const indexes = resolveSelectionIndexes(text, state.rows || []);
    if (!indexes.length) {
      await sendText(fromRaw, "Não entendi quais lançamentos você deseja excluir. Informe os números ou o nome.");
      return true;
    }
    const selections = indexes
      .map((idx) => ({ row: state.rows[idx - 1], displayIndex: idx }))
      .filter((item) => item.row);
    if (!selections.length) {
      await sendText(fromRaw, "Não encontrei os lançamentos informados. Tente novamente.");
      return true;
    }
    await confirmDeleteRows(fromRaw, userNorm, selections);
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
    await sendText(fromRaw, "Não consegui identificar o valor. Informe algo como 150, R$150,00 ou \"cem reais\".");
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
    tipo_pagamento: parsed.tipoPagamento || "",
    codigo_pagamento: "",
    status: parsed.status || "pendente",
    fixa: "nao",
    fix_parent_id: "",
    vencimento_dia: data.getDate(),
    categoria: categoria.slug,
    categoria_emoji: categoria.emoji,
    descricao: parsed.descricao,
  };
  await createRow(payload);
  const resumo = formatEntrySummary(payload);
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
  await sendMainMenu(fromRaw);
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
    if (id === "DEL:CONFIRM:YES") {
      const handled = await finalizeDeleteConfirmation(from, userNorm, true);
      if (!handled) {
        await sendText(from, "Nenhum lançamento selecionado para excluir.");
      }
      return;
    }
    if (id === "DEL:CONFIRM:NO") {
      await finalizeDeleteConfirmation(from, userNorm, false);
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
      await confirmDeleteRows(from, userNorm, [{ row: last, displayIndex: 1 }]);
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
    if (id === "CFIX:LIST") {
      await sendListarContasFixasMessage(from, userNorm);
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
      if (extractAmountFromText(trimmed).amount) {
        await registerEntry(fromRaw, userNorm, text);
      } else {
        await sendMainMenu(fromRaw);
      }
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
