// ============================
// FinPlanner IA - WhatsApp Bot
// Versão: app.js v2025-10-23.1
// ============================

import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import OpenAI from "openai";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import cron from "node-cron";

dotenv.config();

// ============================
// ENV
// ============================
// 🔧 Variáveis de ambiente principais
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USE_OPENAI_RAW = process.env.USE_OPENAI;
const DEBUG_SHEETS_RAW = process.env.DEBUG_SHEETS;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const {
  PORT,
  SHEETS_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_KEY: RAW_KEY = "",
  WA_TOKEN,
  WA_PHONE_NUMBER_ID,
  ADMIN_WA_NUMBER,
  WEBHOOK_VERIFY_TOKEN,
  STRIPE_WEBHOOK_SECRET,
} = process.env;

const USE_OPENAI = (USE_OPENAI_RAW || "false").toLowerCase() === "true";
const DEBUG_SHEETS = (DEBUG_SHEETS_RAW || "false").toLowerCase() === "true";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const openaiClient = USE_OPENAI && OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const OPENAI_INTENT_MODEL = process.env.OPENAI_INTENT_MODEL || "gpt-4o-mini";
const OPENAI_CATEGORY_MODEL = process.env.OPENAI_CATEGORY_MODEL || OPENAI_INTENT_MODEL;

if (USE_OPENAI && !openaiClient) {
  console.warn("OpenAI ativado, mas OPENAI_API_KEY não foi informado. Usando detecção heurística.");
}

const normalizePromptMessages = (input) => {
  if (!Array.isArray(input)) return [];
  return input.map((message) => {
    const parts = Array.isArray(message?.content) ? message.content : [message?.content];
    const text = parts
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return typeof part === "object" ? JSON.stringify(part) : "";
      })
      .filter(Boolean)
      .join("\n");
    return { role: message?.role || "user", content: text };
  });
};

const callOpenAI = async ({ model, input, temperature = 0, maxOutputTokens = 50 }) => {
  if (!openaiClient) return null;
  const messages = normalizePromptMessages(input);
  try {
    if (typeof openaiClient.responses?.create === "function") {
      const response = await openaiClient.responses.create({
        model,
        input,
        temperature,
        max_output_tokens: maxOutputTokens,
      });
      return response?.output_text?.trim() || null;
    }
    if (typeof openaiClient.chat?.completions?.create === "function") {
      const response = await openaiClient.chat.completions.create({
        model,
        messages: messages.length ? messages : [{ role: "user", content: typeof input === "string" ? input : JSON.stringify(input) }],
        temperature,
        max_tokens: maxOutputTokens,
      });
      return response?.choices?.[0]?.message?.content?.trim() || null;
    }
    if (typeof openaiClient.completions?.create === "function") {
      const prompt = (messages.length ? messages : [{ role: "user", content: typeof input === "string" ? input : JSON.stringify(input) }])
        .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
        .join("\n\n");
      const response = await openaiClient.completions.create({
        model,
        prompt,
        temperature,
        max_tokens: maxOutputTokens,
      });
      return response?.choices?.[0]?.text?.trim() || null;
    }
    console.warn("Cliente OpenAI inicializado, mas nenhum método compatível foi encontrado.");
  } catch (error) {
    throw error;
  }
  return null;
};

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

const jsonParser = bodyParser.json();
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/stripe/webhook")) {
    return next();
  }
  return jsonParser(req, res, next);
});

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

const formatSignedCurrencyBR = (value) => {
  const num = Number(value || 0);
  const formatted = formatCurrencyBR(Math.abs(num));
  return num < 0 ? `-${formatted}` : formatted;
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

const daysInMonth = (year, monthIndex) => new Date(year, monthIndex + 1, 0).getDate();
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const addDays = (date, days) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

const nextMonthlyDate = (day, referenceDate, { inclusive = false } = {}) => {
  const reference = startOfDay(referenceDate);
  let year = reference.getFullYear();
  let month = reference.getMonth();
  const buildDate = (y, m) => {
    const safeDay = clamp(Math.round(day), 1, daysInMonth(y, m));
    const instance = new Date(y, m, safeDay);
    instance.setHours(0, 0, 0, 0);
    return instance;
  };
  let candidate = buildDate(year, month);
  while (inclusive ? candidate < reference : candidate <= reference) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    candidate = buildDate(year, month);
  }
  return candidate;
};

const nextIntervalDate = (intervalDays, startDate, fromDate = new Date()) => {
  const interval = Math.max(Math.round(intervalDays), 1);
  const base = startOfDay(startDate);
  const from = startOfDay(fromDate);
  if (base.getTime() >= from.getTime()) return base;
  const diffMs = from.getTime() - base.getTime();
  const steps = Math.ceil(diffMs / (interval * 24 * 60 * 60 * 1000));
  const candidate = addDays(base, steps * interval);
  if (candidate.getTime() >= from.getTime()) return candidate;
  return addDays(candidate, interval);
};

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

const CATEGORY_DEFINITIONS = [
  {
    slug: "utilidades",
    label: "Utilidades",
    emoji: "🔌",
    keywords: ["luz", "energia", "água", "agua", "gás", "gas"],
  },
  {
    slug: "internet_telefonia",
    label: "Internet / Telefonia",
    emoji: "🌐",
    keywords: ["internet", "fibra", "vivo", "claro", "tim", "oi", "telefonia"],
  },
  {
    slug: "moradia",
    label: "Moradia",
    emoji: "🏠",
    keywords: ["aluguel", "condomínio", "condominio", "iptu", "alojamento"],
  },
  {
    slug: "mercado",
    label: "Alimentação",
    emoji: "🛒",
    keywords: [
      "mercado",
      "supermercado",
      "ifood",
      "padaria",
      "almoço",
      "almoco",
      "jantar",
      "restaurante",
      "lanche",
      "espetinho",
      "comida",
      "bebida",
    ],
    aliases: ["alimentacao"],
  },
  {
    slug: "transporte",
    label: "Transporte",
    emoji: "🚗",
    keywords: ["uber", "99", "gasolina", "combustível", "combustivel", "passagem", "ônibus", "onibus", "transporte"],
  },
  {
    slug: "saude",
    label: "Saúde",
    emoji: "💊",
    keywords: ["academia", "plano", "consulta", "dentista", "farmácia", "farmacia", "remédio", "remedio"],
  },
  {
    slug: "educacao",
    label: "Educação",
    emoji: "🎓",
    keywords: ["curso", "faculdade", "escola", "mensalidade", "aula", "material"],
  },
  {
    slug: "lazer",
    label: "Lazer",
    emoji: "🎭",
    keywords: ["netflix", "spotify", "cinema", "show", "lazer", "entretenimento", "viagem"],
  },
  {
    slug: "impostos_taxas",
    label: "Impostos e Taxas",
    emoji: "🧾",
    keywords: ["multa", "taxa", "imposto", "receita", "darf", "alvará", "alvara"],
  },
  {
    slug: "salario_trabalho",
    label: "Salário / Trabalho",
    emoji: "💼",
    keywords: ["salário", "salario", "pagamento", "freela", "freelance", "contrato", "folha"],
  },
  {
    slug: "vendas_receitas",
    label: "Vendas e Receitas",
    emoji: "💵",
    keywords: ["venda", "recebimento", "cliente", "boleto recebido", "serviço", "servico", "entrada"],
  },
  {
    slug: "investimentos",
    label: "Investimentos",
    emoji: "📈",
    keywords: ["investimento", "bolsa", "renda fixa", "tesouro", "ação", "acao"],
  },
  {
    slug: "outros",
    label: "Outros",
    emoji: "🧩",
    keywords: [],
  },
];

const CATEGORY_BY_SLUG = new Map();
CATEGORY_DEFINITIONS.forEach((category) => {
  CATEGORY_BY_SLUG.set(category.slug, category);
  (category.aliases || []).forEach((alias) => CATEGORY_BY_SLUG.set(alias, category));
});

const getCategoryDefinition = (slug) => {
  if (!slug) return null;
  return CATEGORY_BY_SLUG.get(slug.toLowerCase()) || null;
};

const humanizeCategorySlug = (value) => {
  const raw = (value || "").toString().trim();
  if (!raw) return "";
  const parts = raw.split(/[_-]+/).filter(Boolean);
  if (!parts.length) return raw;
  return parts.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" / ");
};

const detectCategoryHeuristic = (description, tipo) => {
  const normalized = normalizeDiacritics((description || "").toLowerCase());
  for (const category of CATEGORY_DEFINITIONS) {
    if (category.keywords?.some((kw) => normalized.includes(kw))) {
      return { slug: category.slug, emoji: category.emoji };
    }
  }
  if (tipo === "conta_receber") {
    const fallback = getCategoryDefinition("vendas_receitas") || getCategoryDefinition("outros");
    return { slug: fallback.slug, emoji: fallback.emoji };
  }
  const fallback = getCategoryDefinition("outros");
  return { slug: fallback.slug, emoji: fallback.emoji };
};

const formatCategoryLabel = (slug, emoji) => {
  const def = getCategoryDefinition(slug);
  const label = def?.label || humanizeCategorySlug(slug) || "—";
  const icon = emoji || def?.emoji;
  if (!label || label === "—") {
    return icon ? `${icon} —` : "—";
  }
  return icon ? `${icon} ${label}` : label;
};

const CATEGORY_PROMPT_HINT = CATEGORY_DEFINITIONS.map((category) => {
  const samples = (category.keywords || []).slice(0, 5);
  const sampleText = samples.length ? ` (exemplos: ${samples.join(", ")})` : "";
  return `${category.slug}: ${category.label}${sampleText}`;
}).join("\n");

const truncateForPrompt = (value, max = 200) => {
  if (!value) return "";
  const str = value.toString().trim();
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
};

const buildCategoryPrompt = (description, tipo) => [
  {
    role: "system",
    content: [
      {
        type: "text",
        text:
          "Você é um classificador de categorias financeiras. Responda apenas com um dos slugs informados, sem explicações.",
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "text",
        text: `Categorias disponíveis:\n${CATEGORY_PROMPT_HINT}\n\nDescrição do lançamento: "${truncateForPrompt(
          description,
        )}"\nTipo do lançamento: ${tipo === "conta_receber" ? "recebimento" : "pagamento"}\nResponda apenas com o slug mais adequado.`,
      },
    ],
  },
];

const resolveCategory = async (description, tipo) => {
  const fallback = detectCategoryHeuristic(description, tipo);
  if (!description || !description.toString().trim() || !openaiClient) return fallback;
  try {
    const output = await callOpenAI({
      model: OPENAI_CATEGORY_MODEL,
      input: buildCategoryPrompt(description, tipo),
      temperature: 0,
      maxOutputTokens: 50,
    });
    const predicted = output?.trim().toLowerCase();
    const sanitized = predicted ? predicted.replace(/[^a-z0-9_]/g, "") : "";
    const def = getCategoryDefinition(sanitized);
    if (def) return { slug: def.slug, emoji: def.emoji };
  } catch (error) {
    console.error("Falha ao consultar OpenAI para categoria:", error?.message || error);
  }
  return fallback;
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
  "recorrencia_tipo",
  "recorrencia_valor",
  "categoria",
  "categoria_emoji",
  "descricao",
];

const CLIENTES_HEADERS = [
  "user",
  "plano",
  "ativo",
  "data_inicio",
  "vencimento_plano",
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
    const normalized = current.map((header) => (header || "").trim());
    const hasDuplicate = new Set(normalized.filter(Boolean)).size !== normalized.filter(Boolean).length;
    const missing = SHEET_HEADERS.filter((header) => !normalized.includes(header));
    const orderMismatch = SHEET_HEADERS.some((header, index) => normalized[index] !== header);

    if (hasDuplicate || missing.length || orderMismatch || normalized.length !== SHEET_HEADERS.length) {
      await sheet.setHeaderRow(SHEET_HEADERS);
    }
  }
  return sheet;
}

async function ensureSheetClientes() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["clientes"];
  if (!sheet) {
    sheet = await doc.addSheet({ title: "clientes", headerValues: CLIENTES_HEADERS });
  } else {
    await sheet.loadHeaderRow();
    const current = (sheet.headerValues || []).map((header) => (header || "").trim());
    const filtered = current.filter(Boolean);
    const hasDuplicate = new Set(filtered).size !== filtered.length;
    const missing = CLIENTES_HEADERS.filter((header) => !current.includes(header));
    const orderMismatch = CLIENTES_HEADERS.some((header, index) => current[index] !== header);
    if (hasDuplicate || missing.length || orderMismatch || current.length !== CLIENTES_HEADERS.length) {
      await sheet.setHeaderRow(CLIENTES_HEADERS);
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

const getRowIdentifier = (row) => (getVal(row, "row_id") || getVal(row, "timestamp") || "").toString();

async function allRowsForUser(userNorm) {
  const sheet = await ensureSheet();
  const rows = await sheet.getRows();
  return rows.filter((row) => normalizeUser(getVal(row, "user")) === userNorm);
}

const findRowById = async (userNorm, rowId) => {
  if (!rowId) return null;
  const rows = await allRowsForUser(userNorm);
  const target = rowId.toString();
  return rows.find((row) => getRowIdentifier(row) === target);
};

const withinPeriod = (rows, start, end) => rows.filter((row) => withinRange(getEffectiveDate(row), start, end));
const sumValues = (rows) => rows.reduce((acc, row) => acc + toNumber(getVal(row, "valor")), 0);

// ============================
// Rendering helpers
// ============================
const isRowFixed = (row) => String(getVal(row, "fixa") || "").toLowerCase() === "sim";

const describeRecurrence = (row) => {
  if (!isRowFixed(row)) return "";
  const tipo = (getVal(row, "recorrencia_tipo") || "").toString().toLowerCase();
  const valorRaw = Number(getVal(row, "recorrencia_valor"));
  if (tipo === "monthly") {
    const reference = getVal(row, "vencimento_iso") || getVal(row, "timestamp");
    const baseDate = reference ? new Date(reference) : new Date();
    const day = Number.isFinite(valorRaw) && valorRaw > 0 ? valorRaw : baseDate.getDate();
    const safeDay = Math.min(Math.max(Math.round(day), 1), 31);
    return `Todo dia ${String(safeDay).padStart(2, "0")} do mês`;
  }
  if (tipo === "interval") {
    const days = Number.isFinite(valorRaw) && valorRaw > 0 ? Math.round(valorRaw) : 0;
    if (!days) return "";
    if (days === 7) return "Toda semana";
    if (days === 15) return "A cada 15 dias";
    if (days % 7 === 0) {
      const weeks = days / 7;
      return weeks === 1 ? "Toda semana" : `A cada ${weeks} semanas`;
    }
    return `A cada ${days} dias`;
  }
  return "";
};

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
  if (isRowFixed(row)) {
    const recurrenceLabel = describeRecurrence(row);
    if (recurrenceLabel) fields.push(`🔄 Recorrência: ${recurrenceLabel}`);
  }
  if (headerLabel) {
    return `${headerLabel}\n\n${fields.join("\n")}`;
  }
  if (typeof index === "number") {
    const numberLine = numberToKeycapEmojis(index);
    return [numberLine, "", ...fields].join("\n");
  }
  return `📘 Lançamento\n\n${fields.join("\n")}`;
};

const formatEntrySummary = (row, options = {}) =>
  formatEntryBlock(row, { ...options, headerLabel: options.headerLabel || "📘 Resumo do lançamento" });

const aggregateCategoryTotals = (rows) => {
  const totals = new Map();
  for (const row of rows) {
    const amount = toNumber(getVal(row, "valor"));
    if (!amount) continue;
    let slug = (getVal(row, "categoria") || "").toString();
    let emoji = getVal(row, "categoria_emoji");
    if (!slug) {
      const fallback = detectCategoryHeuristic(getVal(row, "descricao") || getVal(row, "conta"), getVal(row, "tipo"));
      slug = fallback.slug;
      emoji = emoji || fallback.emoji;
    }
    const def = getCategoryDefinition(slug) || getCategoryDefinition("outros");
    const key = def?.slug || slug || "outros";
    const label = formatCategoryLabel(key, emoji || def?.emoji);
    const entry = totals.get(key) || { key, label, total: 0 };
    entry.total += amount;
    entry.label = label;
    totals.set(key, entry);
  }
  return Array.from(totals.values()).sort((a, b) => b.total - a.total);
};

const formatCategoryLines = (rows) => {
  const aggregates = aggregateCategoryTotals(rows);
  if (!aggregates.length) return "✅ Nenhuma categoria encontrada no período.";
  return aggregates.map((item) => `• ${item.label}: ${formatCurrencyBR(item.total)}`).join("\n");
};

const formatSaldoLine = (recebido, pago) => {
  const saldo = recebido - pago;
  const saldoText = formatSignedCurrencyBR(saldo);
  return saldo < 0 ? `🟥 🔹 Saldo no período: ${saldoText}` : `🔹 Saldo no período: ${saldoText}`;
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
          { type: "reply", reply: { id: `LANC:PER:hoje`, title: "Hoje" } },
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
          { type: "reply", reply: { id: "CFIX:CAD", title: "Cadastrar fixa" } },
          { type: "reply", reply: { id: "CFIX:LIST", title: "Listar fixas" } },
          { type: "reply", reply: { id: "CFIX:DEL", title: "Excluir fixas" } },
        ],
      },
    },
  });

const sendCadastrarContaFixaMessage = (to) =>
  sendText(
    to,
    `♻ Cadastro de conta fixa\n\nEnvie tudo em uma única mensagem neste formato:\n\n📝 Descrição: Nome da conta\n(ex: Internet, Academia, Aluguel)\n\n💰 Valor: Valor fixo da conta\n(ex: 120,00)\n\n🔁 Recorrência: Informe o intervalo\n(ex: todo dia 05, a cada 15 dias, semanal, quinzenal)\n\n💡 Exemplos:\n➡ Internet 120 todo dia 05\n➡ Aluguel 150 a cada 15 dias\n➡ Academia 90 semanal\n\nDigite *cancelar* para sair.`
  );

const sendListarContasFixasMessage = async (to, userNorm) => {
  const fixed = await getFixedAccounts(userNorm);
  if (!fixed.length) {
    await sendText(to, "Você ainda não possui contas fixas cadastradas.");
    return;
  }
  const deduped = dedupeFixedAccounts(fixed);
  const pending = deduped
    .filter((row) => (getVal(row, "status") || "").toString().toLowerCase() !== "pago")
    .sort((a, b) => getEffectiveDate(a) - getEffectiveDate(b));
  if (!pending.length) {
    await sendText(to, "🎉 Todas as suas contas fixas estão em dia no momento!");
    return;
  }
  const list = buildFixedAccountList(pending);
  sessionPayConfirm.delete(userNorm);
  setPayState(userNorm, {
    awaiting: "index",
    rows: pending,
    queue: [],
    currentIndex: 0,
    currentRowId: null,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await sendText(
    to,
    `♻️ *Contas fixas pendentes*\n\n${list}\n\n✅ Para confirmar pagamento, envie o número da conta.\nExemplo: Confirmar 1 ou Confirmar 1,2,3.`
  );
};

const buildFixedAccountList = (rows) =>
  rows
    .map((row, index) => {
      return formatEntryBlock(row, {
        index: index + 1,
      });
    })
    .join("\n\n");

const isFixedAccount = (row) => isRowFixed(row);

const getFixedAccounts = async (userNorm) => {
  const rows = await allRowsForUser(userNorm);
  return rows.filter((row) => isFixedAccount(row));
};

const dedupeFixedAccounts = (rows) => {
  const byParent = new Map();
  const priority = (row) => {
    const status = (getVal(row, "status") || "").toString().toLowerCase();
    return status === "pago" || status === "recebido" ? 1 : 0;
  };
  rows.forEach((row) => {
    const parent = getVal(row, "fix_parent_id") || getVal(row, "row_id") || getRowIdentifier(row);
    if (!parent) return;
    const existing = byParent.get(parent);
    if (!existing) {
      byParent.set(parent, row);
      return;
    }
    const currentPriority = priority(row);
    const existingPriority = priority(existing);
    if (currentPriority < existingPriority) {
      byParent.set(parent, row);
      return;
    }
    if (currentPriority === existingPriority) {
      const existingDate = getEffectiveDate(existing);
      const candidateDate = getEffectiveDate(row);
      if (!existingDate || (candidateDate && candidateDate < existingDate)) {
        byParent.set(parent, row);
      }
    }
  });
  return [...byParent.values()];
};

async function sendExcluirContaFixaMessage(to, userNorm) {
  const fixed = dedupeFixedAccounts(await getFixedAccounts(userNorm));
  if (!fixed.length) {
    sessionFixedDelete.delete(userNorm);
    await sendText(to, "Você ainda não possui contas fixas cadastradas.");
    return;
  }
  const sorted = fixed
    .slice()
    .sort((a, b) => {
      const dateA = getEffectiveDate(a);
      const dateB = getEffectiveDate(b);
      if (dateA && dateB) return dateA - dateB;
      if (dateA) return -1;
      if (dateB) return 1;
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
const sessionFixedRegister = new Map();
const sessionFixedDelete = new Map();
const sessionStatusConfirm = new Map();
const sessionPaymentCode = new Map();
const sessionPayConfirm = new Map();

const processedMessages = new Map();
const MESSAGE_CACHE_TTL_MS = 10 * 60 * 1000;

const isDuplicateMessage = (id) => {
  if (!id) return false;
  const now = Date.now();
  for (const [storedId, ts] of processedMessages) {
    if (now - ts > MESSAGE_CACHE_TTL_MS) {
      processedMessages.delete(storedId);
    }
  }
  if (processedMessages.has(id)) {
    return true;
  }
  processedMessages.set(id, now);
  return false;
};

const startReportCategoryFlow = async (to, userNorm, category) => {
  sessionPeriod.set(userNorm, { mode: "report", category, awaiting: null });
  await sendPeriodoButtons(to, `REL:PER:${category}`);
};

const resetSession = (userNorm) => {
  sessionPeriod.delete(userNorm);
  sessionEdit.delete(userNorm);
  sessionDelete.delete(userNorm);
  sessionRegister.delete(userNorm);
  sessionFixedRegister.delete(userNorm);
  sessionFixedDelete.delete(userNorm);
  sessionStatusConfirm.delete(userNorm);
  sessionPaymentCode.delete(userNorm);
  sessionPayConfirm.delete(userNorm);
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
  let statusDetected = false;
  const receivedRegex = /\b(recebid[oa]?|recebi|recebemos|creditad[oa]|caiu|confirmad[oa])\b/;
  const pendingRegex = /\b(pendente|a pagar|pagar|a receber|aguardando|em aberto)\b/;
  const paidRegex = /\b(pag[ouei]|paguei|quitad[oa]|liquidad[oa]|transferi|transferido|pix)\b/;
  if (receivedRegex.test(normalized)) {
    status = "recebido";
    statusDetected = true;
  } else if (pendingRegex.test(normalized)) {
    status = "pendente";
    statusDetected = true;
  } else if (paidRegex.test(normalized)) {
    status = "pago";
    statusDetected = true;
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
    statusDetected,
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

  const statusOf = (row) => (getVal(row, "status") || "").toString().toLowerCase();
  const isPaid = (row) => statusOf(row) === "pago";
  const isReceived = (row) => {
    const status = statusOf(row);
    return status === "recebido" || status === "pago";
  };

  if (category === "cp") {
    const expenses = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar");
    const pending = expenses.filter((row) => !isPaid(row));
    const paid = expenses.filter(isPaid);
    const totalPending = sumValues(pending);
    const totalPaid = sumValues(paid);
    const totalExpenses = sumValues(expenses);
    let message = "📊 *Relatório • Contas a pagar*";
    if (!expenses.length) {
      message += "\n\n✅ Nenhuma conta encontrada para o período selecionado.";
    } else {
      if (pending.length) {
        message += `\n\n📂 Categorias pendentes:\n${formatCategoryLines(pending)}`;
      }
      if (paid.length) {
        message += `\n\n✅ Categorias pagas:\n${formatCategoryLines(paid)}`;
      }
      message += `\n\n🔸 Total pendente: ${formatCurrencyBR(totalPending)}`;
      message += `\n✅ Total pago: ${formatCurrencyBR(totalPaid)}`;
      message += `\n💰 Total geral: ${formatCurrencyBR(totalExpenses)}`;
    }
    await sendText(fromRaw, message);
    return;
  }

  if (category === "rec") {
    const receipts = inRange.filter((row) => getVal(row, "tipo") === "conta_receber");
    const confirmed = receipts.filter(isReceived);
    const pending = receipts.filter((row) => !isReceived(row));
    const totalReceived = sumValues(confirmed);
    const totalPending = sumValues(pending);
    const totalReceipts = sumValues(receipts);
    let message = "📊 *Relatório • Recebimentos*";
    if (!receipts.length) {
      message += "\n\n✅ Nenhum recebimento encontrado para o período selecionado.";
    } else {
      message += `\n\n📂 Categorias:\n${formatCategoryLines(receipts)}`;
      message += `\n\n💵 Total recebido: ${formatCurrencyBR(totalReceived)}`;
      message += `\n⏳ Total pendente: ${formatCurrencyBR(totalPending)}`;
      message += `\n💰 Total geral: ${formatCurrencyBR(totalReceipts)}`;
    }
    await sendText(fromRaw, message);
    return;
  }

  if (category === "pag") {
    const expenses = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar");
    const paid = expenses.filter(isPaid);
    const pending = expenses.filter((row) => !isPaid(row));
    const totalPaid = sumValues(paid);
    const totalPending = sumValues(pending);
    let message = "📊 *Relatório • Pagamentos*";
    if (!paid.length) {
      message += "\n\n✅ Nenhum pagamento confirmado no período.";
      if (pending.length) {
        message += `\n\n⏳ Contas pendentes: ${formatCurrencyBR(totalPending)}`;
      }
      await sendText(fromRaw, message);
      return;
    }
    message += `\n\n📂 Categorias pagas:\n${formatCategoryLines(paid)}`;
    message += `\n\n💸 Total pago: ${formatCurrencyBR(totalPaid)}`;
    if (pending.length) {
      message += `\n⏳ Contas pendentes: ${formatCurrencyBR(totalPending)}`;
    }
    message += `\n💰 Total geral: ${formatCurrencyBR(totalPaid)}`;
    await sendText(fromRaw, message);
    return;
  }

  if (category === "all") {
    const receipts = inRange.filter((row) => getVal(row, "tipo") === "conta_receber");
    const expenses = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar");
    const confirmedReceipts = receipts.filter(isReceived);
    const pendingReceipts = receipts.filter((row) => !isReceived(row));
    const paidExpenses = expenses.filter(isPaid);
    const pendingExpenses = expenses.filter((row) => !isPaid(row));
    const totalReceived = sumValues(confirmedReceipts);
    const totalReceipts = sumValues(receipts);
    const totalPaid = sumValues(paidExpenses);
    const totalPendingExpenses = sumValues(pendingExpenses);
    const totalPendingReceipts = sumValues(pendingReceipts);
    let message = "📊 *Relatório • Completo*";
    if (!receipts.length && !expenses.length) {
      message += "\n\n✅ Nenhum lançamento encontrado para o período selecionado.";
    } else {
      if (receipts.length) {
        message += `\n\n💵 Recebimentos:\n${formatCategoryLines(receipts)}`;
        message += `\n\n💵 Total recebido: ${formatCurrencyBR(totalReceived)}`;
        message += `\n⏳ Total pendente: ${formatCurrencyBR(totalPendingReceipts)}`;
        message += `\n💰 Total geral: ${formatCurrencyBR(totalReceipts)}`;
      }
      if (pendingExpenses.length) {
        message += `\n\n⏳ Contas a pagar:\n${formatCategoryLines(pendingExpenses)}`;
        message += `\n\n⏳ Total pendente: ${formatCurrencyBR(totalPendingExpenses)}`;
      }
      if (paidExpenses.length) {
        message += `\n\n✅ Contas pagas:\n${formatCategoryLines(paidExpenses)}`;
        message += `\n\n✅ Total pago: ${formatCurrencyBR(totalPaid)}`;
      }
      const saldo = formatSaldoLine(totalReceived, totalPaid);
      message += `\n\n${saldo}`;
    }
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
  const message =
    `📅 *Contas a pagar pendentes*\n\n${blocks.join("\n\n")}` +
    `\n\n✅ Para confirmar pagamento, envie o número da conta.\nExemplo: Confirmar 1 ou Confirmar 1,2,3.`;
  sessionPayConfirm.delete(userNorm);
  setPayState(userNorm, {
    awaiting: "index",
    rows: pending,
    queue: [],
    currentIndex: 0,
    currentRowId: null,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
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
    "confirmar",
    "confirm",
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
    if (field === "status") {
      await sendText(fromRaw, "Digite a nova situação para status.");
    } else {
      await sendText(fromRaw, `Digite o novo valor para *${field}*.`);
    }
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
      const detected = await resolveCategory(categoria, getVal(row, "tipo"));
      setVal(row, "categoria", detected.slug);
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
  const parentId = getVal(row, "fix_parent_id") || getVal(row, "row_id");
  const allRows = await allRowsForUser(userNorm);
  const related = allRows.filter(
    (candidate) =>
      isFixedAccount(candidate) && (getVal(candidate, "fix_parent_id") || getVal(candidate, "row_id")) === parentId
  );
  if (related.length > 1) {
    await sendText(fromRaw, "A exclusão removerá todas as recorrências desta conta fixa.");
  }
  const selections = related.map((item) => ({ row: item, displayIndex: idx }));
  await confirmDeleteRows(fromRaw, userNorm, selections);
  return true;
}

async function handleFixedRegisterFlow(fromRaw, userNorm, text) {
  const state = sessionFixedRegister.get(userNorm);
  if (!state) return false;
  if (state.expiresAt && Date.now() > state.expiresAt) {
    sessionFixedRegister.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  const trimmed = (text || "").trim();
  if (!trimmed) {
    await sendText(fromRaw, "Envie os detalhes da conta fixa ou escreva cancelar.");
    return true;
  }
  if (/^cancelar/i.test(trimmed)) {
    sessionFixedRegister.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada.");
    return true;
  }
  const parsed = parseFixedAccountCommand(text);
  if (!parsed) {
    await sendText(
      fromRaw,
      "Não consegui entender. Informe algo como \"Internet 120 todo dia 05\" ou \"Aluguel 150 a cada 15 dias\"."
    );
    sessionFixedRegister.set(userNorm, { expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    return true;
  }
  sessionFixedRegister.delete(userNorm);
  await registerFixedAccount(fromRaw, userNorm, parsed);
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
// Registro de lançamentos helpers
// ============================
const setStatusState = (userNorm, state) => {
  const current = sessionStatusConfirm.get(userNorm) || {};
  sessionStatusConfirm.set(userNorm, { ...current, ...state });
};

const statusStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

async function sendStatusConfirmationPrompt(to) {
  await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Esse lançamento já foi pago ou ainda está pendente?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "REG:STATUS:PAGO", title: "Pago" } },
          { type: "reply", reply: { id: "REG:STATUS:PENDENTE", title: "Pendente" } },
        ],
      },
    },
  });
}

const sendRegistrationEditPrompt = async (to, rowId, statusLabel) => {
  if (!rowId) return;
  await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `Status identificado automaticamente: ${statusLabel}.\n\nDeseja editar este lançamento?` },
      action: {
        buttons: [
          { type: "reply", reply: { id: `REG:EDIT:${rowId}`, title: "✏ Editar" } },
          { type: "reply", reply: { id: `REG:KEEP:${rowId}`, title: "✅ Manter" } },
        ],
      },
    },
  });
};

const setPaymentCodeState = (userNorm, state) => {
  const current = sessionPaymentCode.get(userNorm) || {};
  sessionPaymentCode.set(userNorm, { ...current, ...state });
};

const paymentCodeStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

const promptAttachPaymentCode = async (to, userNorm, entry, statusSource) => {
  const method = (entry.tipo_pagamento || "").toLowerCase();
  if (!["pix", "boleto"].includes(method)) return;
  setPaymentCodeState(userNorm, {
    awaiting: "choice",
    rowId: entry.row_id,
    metodo: method,
    statusSource,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "💳 Deseja anexar o código do Pix ou boleto para facilitar o pagamento?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: `PAYCODE:ADD:${entry.row_id}`, title: "🔗 Adicionar código" } },
          { type: "reply", reply: { id: `PAYCODE:SKIP:${entry.row_id}`, title: "🚫 Pular" } },
        ],
      },
    },
  });
};

async function scheduleNextFixedOccurrence(row) {
  if (!isRowFixed(row)) return;
  const recType = (getVal(row, "recorrencia_tipo") || "").toString().toLowerCase();
  if (!recType) return;
  const userRaw = getVal(row, "user_raw") || getVal(row, "user");
  const userNorm = normalizeUser(getVal(row, "user"));
  if (!userRaw || !userNorm) return;
  const currentDueIso = getVal(row, "vencimento_iso");
  const currentDue = currentDueIso ? new Date(currentDueIso) : new Date();
  let nextDue = null;
  if (recType === "monthly") {
    const storedDay = Number(getVal(row, "recorrencia_valor"));
    const day = Number.isFinite(storedDay) && storedDay > 0 ? storedDay : currentDue.getDate();
    nextDue = nextMonthlyDate(day, addDays(currentDue, 1), { inclusive: true });
  } else if (recType === "interval") {
    const stored = Number(getVal(row, "recorrencia_valor"));
    const days = Number.isFinite(stored) && stored > 0 ? Math.round(stored) : 0;
    if (days > 0) nextDue = addDays(startOfDay(currentDue), days);
  }
  if (!nextDue) return;

  let categoriaSlug = getVal(row, "categoria");
  let categoriaEmoji = getVal(row, "categoria_emoji");
  if (!categoriaSlug) {
    const detected = await resolveCategory(
      getVal(row, "descricao") || getVal(row, "conta"),
      getVal(row, "tipo") || "conta_pagar",
    );
    categoriaSlug = detected.slug;
    categoriaEmoji = detected.emoji;
  }

  const parentId = getVal(row, "fix_parent_id") || getVal(row, "row_id");
  const newRow = {
    row_id: generateRowId(),
    timestamp: new Date().toISOString(),
    user: getVal(row, "user"),
    user_raw: userRaw,
    tipo: getVal(row, "tipo") || "conta_pagar",
    conta: getVal(row, "conta"),
    valor: getVal(row, "valor"),
    vencimento_iso: nextDue.toISOString(),
    vencimento_br: formatBRDate(nextDue),
    tipo_pagamento: getVal(row, "tipo_pagamento") || "",
    codigo_pagamento: "",
    status: "pendente",
    fixa: "sim",
    fix_parent_id: parentId,
    vencimento_dia: nextDue.getDate(),
    categoria: categoriaSlug,
    categoria_emoji: categoriaEmoji,
    descricao: getVal(row, "descricao") || getVal(row, "conta") || "Conta fixa",
    recorrencia_tipo: recType,
    recorrencia_valor: getVal(row, "recorrencia_valor") || (recType === "monthly" ? String(nextDue.getDate()) : ""),
  };
  await createRow(newRow);
  const resumo = formatEntrySummary(newRow, { headerLabel: "📘 Próximo lançamento fixo:" });
  await sendText(userRaw, `♻ Próxima cobrança gerada automaticamente!\n\n${resumo}`);
  if (["pix", "boleto"].includes((newRow.tipo_pagamento || "").toLowerCase())) {
    await promptAttachPaymentCode(userRaw, userNorm, newRow, "fixed_cycle");
  }
}

const setPayState = (userNorm, state) => {
  const current = sessionPayConfirm.get(userNorm) || {};
  sessionPayConfirm.set(userNorm, { ...current, ...state });
};

const payStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

async function promptNextPaymentConfirmation(to, userNorm) {
  const state = sessionPayConfirm.get(userNorm);
  if (!state || !Array.isArray(state.queue) || !state.queue.length) return;
  const currentIndex = state.currentIndex || 0;
  const currentItem = state.queue[currentIndex];
  if (!currentItem || !currentItem.row) {
    sessionPayConfirm.delete(userNorm);
    return;
  }
  const summary = formatEntrySummary(currentItem.row, { headerLabel: "🧾 Lançamento selecionado:" });
  const rowId = getRowIdentifier(currentItem.row);
  const code = (getVal(currentItem.row, "codigo_pagamento") || "").toString().trim();
  const metodo = (getVal(currentItem.row, "tipo_pagamento") || "").toLowerCase();
  const buttons = [{ type: "reply", reply: { id: `PAY:MARK:${rowId}`, title: "✅ Pago" } }];
  if (code) {
    const copyTitle = metodo === "boleto" ? "📋 Copiar boleto" : "📋 Copiar Pix";
    buttons.push({ type: "reply", reply: { id: `PAY:COPY:${rowId}`, title: copyTitle } });
  }
  buttons.push({ type: "reply", reply: { id: "PAY:CANCEL", title: "❌ Cancelar" } });
  setPayState(userNorm, {
    ...state,
    awaiting: "confirm",
    currentIndex,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    currentRowId: rowId,
  });
  const body = `✅ Confirmar pagamento?\n\n${summary}\n\nDeseja marcar como pago agora?`;
  await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: { buttons },
    },
  });
}

async function finalizeRegisterEntry(fromRaw, userNorm, entry, options = {}) {
  const statusSource = options.statusSource || "auto";
  await createRow(entry);
  const resumo = formatEntrySummary(entry);
  const statusLabel = statusIconLabel(entry.status);
  if (entry.tipo === "conta_receber") {
    let message = `💵 Recebimento registrado com sucesso!\n\n${resumo}\n\n🎯 O saldo foi atualizado automaticamente, refletindo sua nova entrada.`;
    if (options.autoStatus) {
      message += `\n\nStatus identificado automaticamente: ${statusLabel}.`;
    }
    await sendText(fromRaw, message);
  } else {
    let message = `✅ Pagamento registrado com sucesso!\n\n${resumo}\n\n💡 A FinPlanner IA já atualizou seu saldo e adicionou este pagamento ao relatório do período.`;
    if (options.autoStatus) {
      message += `\n\nStatus identificado automaticamente: ${statusLabel}.`;
    }
    await sendText(fromRaw, message);
  }

  if (options.autoStatus) {
    await sendRegistrationEditPrompt(fromRaw, entry.row_id, statusLabel);
  }

  if (
    entry.tipo === "conta_pagar" &&
    entry.status === "pendente" &&
    ["pix", "boleto"].includes((entry.tipo_pagamento || "").toLowerCase()) &&
    (options.autoStatus || statusSource === "user_confirm")
  ) {
    await promptAttachPaymentCode(fromRaw, userNorm, entry, statusSource);
  }

  await sendMainMenu(fromRaw);
}

async function handleStatusSelection(fromRaw, userNorm, selectedStatus) {
  const state = sessionStatusConfirm.get(userNorm);
  if (!state) return;
  if (statusStateExpired(state)) {
    sessionStatusConfirm.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return;
  }
  const entry = { ...state.entry };
  if (!entry) {
    sessionStatusConfirm.delete(userNorm);
    return;
  }
  let status = selectedStatus;
  if (entry.tipo === "conta_receber" && status === "pago") status = "recebido";
  entry.status = status;
  entry.timestamp = new Date().toISOString();
  sessionStatusConfirm.delete(userNorm);
  await finalizeRegisterEntry(fromRaw, userNorm, entry, { statusSource: "user_confirm", autoStatus: false });
}

async function handleStatusConfirmationFlow(fromRaw, userNorm, text) {
  const state = sessionStatusConfirm.get(userNorm);
  if (!state) return false;
  if (statusStateExpired(state)) {
    sessionStatusConfirm.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  const normalized = normalizeDiacritics(text).toLowerCase().trim();
  if (!normalized) {
    await sendText(fromRaw, "Não entendi. Toque em Pago ou Pendente para continuar.");
    return true;
  }
  if (/\b(pago|pagou|paguei|pagamos|recebido|recebi|quitado|liquidado)\b/.test(normalized)) {
    await handleStatusSelection(fromRaw, userNorm, "pago");
    return true;
  }
  if (/\b(pendente|a pagar|pagar|em aberto)\b/.test(normalized)) {
    await handleStatusSelection(fromRaw, userNorm, "pendente");
    return true;
  }
  await sendText(fromRaw, "Por favor, informe se o lançamento está Pago ou Pendente.");
  return true;
}

async function handlePaymentCodeFlow(fromRaw, userNorm, text) {
  const state = sessionPaymentCode.get(userNorm);
  if (!state) return false;
  if (paymentCodeStateExpired(state)) {
    sessionPaymentCode.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  if (state.awaiting !== "input") return false;
  const code = text.trim();
  if (!code) {
    await sendText(fromRaw, "Não entendi o código. Envie novamente ou escreva cancelar.");
    return true;
  }
  if (/^cancelar/i.test(code)) {
    sessionPaymentCode.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada.");
    return true;
  }
  const row = await findRowById(userNorm, state.rowId);
  if (!row) {
    sessionPaymentCode.delete(userNorm);
    await sendText(fromRaw, "Não encontrei o lançamento para salvar o código.");
    return true;
  }
  setVal(row, "codigo_pagamento", code);
  await saveRow(row);
  sessionPaymentCode.delete(userNorm);
  const descricao = getVal(row, "descricao") || getVal(row, "conta") || "Lançamento";
  await sendText(
    fromRaw,
    `✅ Código anexado com sucesso!\n\nDescrição do lançamento\n\n📝 Descrição: ${descricao}\n📎 Código armazenado com segurança.`
  );
  return true;
}

async function handlePaymentConfirmFlow(fromRaw, userNorm, text) {
  const state = sessionPayConfirm.get(userNorm);
  if (!state) return false;
  if (payStateExpired(state)) {
    sessionPayConfirm.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  const normalizedText = normalizeDiacritics(text).toLowerCase().trim();
  if (state.awaiting === "index") {
    if (/cancel/.test(normalizedText)) {
      sessionPayConfirm.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      return true;
    }
    const indexes = resolveSelectionIndexes(text, state.rows || []);
    if (!indexes.length) {
      await sendText(fromRaw, "Não entendi quais contas deseja confirmar. Informe os números.");
      return true;
    }
    const selections = indexes
      .map((idx) => ({ row: state.rows[idx - 1], displayIndex: idx }))
      .filter((item) => item.row);
    if (!selections.length) {
      await sendText(fromRaw, "Não encontrei os lançamentos informados. Tente novamente.");
      return true;
    }
    setPayState(userNorm, {
      rows: state.rows,
      queue: selections,
      currentIndex: 0,
      awaiting: "confirm",
      expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    });
    await promptNextPaymentConfirmation(fromRaw, userNorm);
    return true;
  }
  if (state.awaiting === "confirm") {
    if (!normalizedText) {
      await sendText(fromRaw, "Responda com Pago ou Cancelar para continuar.");
      return true;
    }
    if (/pago|confirm/.test(normalizedText)) {
      const current = state.queue?.[state.currentIndex || 0];
      if (!current || !current.row) {
        sessionPayConfirm.delete(userNorm);
        return true;
      }
      await markPaymentAsPaid(fromRaw, userNorm, current.row);
      return true;
    }
    if (/cancel/.test(normalizedText)) {
      sessionPayConfirm.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      return true;
    }
    if (/copiar|codigo|boleto|pix/.test(normalizedText)) {
      const current = state.queue?.[state.currentIndex || 0];
      if (current?.row) {
        await sendPaymentCode(fromRaw, current.row);
        setPayState(userNorm, { ...state, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      }
      return true;
    }
    await sendText(fromRaw, "Responda com Pago ou escolha uma opção nos botões.");
    return true;
  }
  return false;
}

async function sendPaymentCode(to, row) {
  const code = (getVal(row, "codigo_pagamento") || "").toString().trim();
  if (!code) {
    await sendText(to, "Não há código salvo para este lançamento.");
    return;
  }
  const metodo = (getVal(row, "tipo_pagamento") || "").toLowerCase();
  const label = metodo === "boleto" ? "código de barras" : "chave Pix";
  await sendText(to, `📎 Aqui está o ${label}:\n${code}`);
}

async function markPaymentAsPaid(fromRaw, userNorm, row) {
  if (!row) return;
  setVal(row, "status", "pago");
  setVal(row, "timestamp", new Date().toISOString());
  await saveRow(row);
  await sendText(fromRaw, `✅ Pagamento confirmado com sucesso!\n\n${formatEntrySummary(row)}`);
  await scheduleNextFixedOccurrence(row);
  const state = sessionPayConfirm.get(userNorm);
  if (!state) {
    sessionPayConfirm.delete(userNorm);
    return;
  }
  const nextIndex = (state.currentIndex || 0) + 1;
  if (!state.queue || nextIndex >= state.queue.length) {
    sessionPayConfirm.delete(userNorm);
    return;
  }
  setPayState(userNorm, {
    ...state,
    currentIndex: nextIndex,
    awaiting: "confirm",
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await promptNextPaymentConfirmation(fromRaw, userNorm);
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
  let data = parsed.data instanceof Date ? parsed.data : null;
  if (!data || Number.isNaN(data.getTime())) data = new Date();
  const iso = data.toISOString();
  const categoria = await resolveCategory(parsed.descricao, parsed.tipo);
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
    recorrencia_tipo: "",
    recorrencia_valor: "",
    categoria: categoria.slug,
    categoria_emoji: categoria.emoji,
    descricao: parsed.descricao,
  };
  if (!parsed.statusDetected) {
    payload.status = "pendente";
    setStatusState(userNorm, { entry: { ...payload }, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    await sendStatusConfirmationPrompt(fromRaw);
    return;
  }

  await finalizeRegisterEntry(fromRaw, userNorm, payload, { autoStatus: true, statusSource: "auto" });
}

const computeInitialFixedDueDate = (recurrence, startDate) => {
  if (!recurrence) return null;
  const now = startOfDay(new Date());
  if (recurrence.type === "monthly") {
    const base =
      startDate instanceof Date && !Number.isNaN(startDate?.getTime()) && startOfDay(startDate).getTime() >= now.getTime()
        ? startDate
        : now;
    return nextMonthlyDate(recurrence.value, base, { inclusive: true });
  }
  if (recurrence.type === "interval") {
    if (startDate instanceof Date && !Number.isNaN(startDate?.getTime())) {
      return nextIntervalDate(recurrence.value, startDate, now);
    }
    return addDays(now, recurrence.value);
  }
  return null;
};

const parseFixedAccountCommand = (text) => {
  const original = (text || "").toString();
  if (!original.trim()) return null;
  const amountInfo = extractAmountFromText(original);
  if (!amountInfo.amount) return null;
  const normalized = normalizeDiacritics(original).toLowerCase();

  const removalPatterns = [];
  const addRemoval = (match) => {
    if (match && match[0]) removalPatterns.push(match[0]);
  };

  let recurrence = null;
  const dayMatch = normalized.match(/todo\s+dia\s+(\d{1,2})/);
  if (dayMatch) {
    recurrence = { type: "monthly", value: Number(dayMatch[1]) };
    addRemoval(dayMatch);
  }
  if (!recurrence) {
    const monthMatch = normalized.match(/(?:todo|cada)\s+(?:o\s+)?mes(?:\s+dia\s*(\d{1,2}))?/);
    if (monthMatch) {
      recurrence = { type: "monthly", value: monthMatch[1] ? Number(monthMatch[1]) : null };
      addRemoval(monthMatch);
    }
  }
  if (!recurrence && /\bmensal\b/.test(normalized)) {
    recurrence = { type: "monthly", value: null };
    removalPatterns.push("mensal");
  }
  if (!recurrence) {
    const eachDays = normalized.match(/a\s+cada\s+(\d+)\s+dias?/);
    if (eachDays) {
      recurrence = { type: "interval", value: Number(eachDays[1]) };
      addRemoval(eachDays);
    }
  }
  if (!recurrence) {
    const eachWeeks = normalized.match(/a\s+cada\s+(\d+)\s+semanas?/);
    if (eachWeeks) {
      recurrence = { type: "interval", value: Number(eachWeeks[1]) * 7 };
      addRemoval(eachWeeks);
    }
  }
  if (!recurrence && /\bsemanal\b/.test(normalized)) {
    recurrence = { type: "interval", value: 7 };
    removalPatterns.push("semanal");
  }
  if (!recurrence && /toda\s+semana/.test(normalized)) {
    recurrence = { type: "interval", value: 7 };
    removalPatterns.push("toda semana");
  }
  if (!recurrence && /\bquinzenal\b/.test(normalized)) {
    recurrence = { type: "interval", value: 15 };
    removalPatterns.push("quinzenal");
  }

  if (!recurrence) return null;

  const dateMatch = original.match(/(hoje|amanh[ãa]|ontem|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);
  const startDate = dateMatch ? parseDateToken(dateMatch[1]) : null;

  if (recurrence.type === "monthly") {
    let day = Number(recurrence.value);
    if (!Number.isFinite(day) || day <= 0) {
      if (startDate instanceof Date && !Number.isNaN(startDate?.getTime())) {
        day = startDate.getDate();
      } else {
        const extra = normalized.match(/dia\s+(\d{1,2})/);
        if (extra) day = Number(extra[1]);
      }
    }
    if (!Number.isFinite(day) || day <= 0) day = new Date().getDate();
    recurrence.value = clamp(Math.round(day), 1, 31);
  } else if (recurrence.type === "interval") {
    const days = Number(recurrence.value);
    if (!Number.isFinite(days) || days <= 0) return null;
    recurrence.value = Math.max(Math.round(days), 1);
  }

  const dueDate = computeInitialFixedDueDate(recurrence, startDate);
  if (!dueDate) return null;

  let descricao = original;
  if (amountInfo.raw) {
    const rawRegex = new RegExp(escapeRegex(amountInfo.raw), "i");
    descricao = descricao.replace(rawRegex, " ");
  }
  if (dateMatch && dateMatch[1]) {
    const dateRegex = new RegExp(escapeRegex(dateMatch[1]), "i");
    descricao = descricao.replace(dateRegex, " ");
  }
  removalPatterns.forEach((pattern) => {
    if (!pattern) return;
    const regex = new RegExp(escapeRegex(pattern), "gi");
    descricao = descricao.replace(regex, " ");
  });
  descricao = descricao
    .replace(/conta\s+fixa/gi, " ")
    .replace(/\bfixa\b/gi, " ")
    .replace(/\brecorrente\b/gi, " ")
    .replace(/a\s+cada\s+\d+\s+dias?/gi, " ")
    .replace(/a\s+cada\s+\d+\s+semanas?/gi, " ")
    .replace(/todo\s+dia\s+\d{1,2}/gi, " ")
    .replace(/toda\s+semana/gi, " ")
    .replace(/todo\s+mes/gi, " ")
    .replace(/\bmensal\b/gi, " ")
    .replace(/\bquinzenal\b/gi, " ")
    .replace(/\bpagar\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!descricao) descricao = "Conta fixa";

  let tipoPagamento = "";
  if (/\bpix\b/.test(normalized)) tipoPagamento = "pix";
  else if (/\bboleto\b/.test(normalized)) tipoPagamento = "boleto";
  else if (/\b(cart[aã]o\s*de\s*cr[eé]dito|cart[aã]o\s*cr[eé]dito|cr[eé]dito\s*no?\s*cart[aã]o)\b/.test(normalized))
    tipoPagamento = "cartao_credito";
  else if (/\b(cart[aã]o\s*de\s*d[eé]bito|cart[aã]o\s*d[eé]bito|d[eé]bito\s*no?\s*cart[aã]o)\b/.test(normalized))
    tipoPagamento = "cartao_debito";

  return {
    descricao,
    valor: amountInfo.amount,
    recurrence,
    dueDate,
    tipoPagamento,
  };
};

async function registerFixedAccount(fromRaw, userNorm, parsed) {
  if (!parsed) return;
  const categoria = await resolveCategory(parsed.descricao, "conta_pagar");
  const rowId = generateRowId();
  const due = parsed.dueDate instanceof Date ? parsed.dueDate : new Date();
  const payload = {
    row_id: rowId,
    timestamp: new Date().toISOString(),
    user: userNorm,
    user_raw: fromRaw,
    tipo: "conta_pagar",
    conta: parsed.descricao,
    valor: parsed.valor,
    vencimento_iso: due.toISOString(),
    vencimento_br: formatBRDate(due),
    tipo_pagamento: parsed.tipoPagamento || "",
    codigo_pagamento: "",
    status: "pendente",
    fixa: "sim",
    fix_parent_id: rowId,
    vencimento_dia: due.getDate(),
    categoria: categoria.slug,
    categoria_emoji: categoria.emoji,
    descricao: parsed.descricao,
    recorrencia_tipo: parsed.recurrence.type,
    recorrencia_valor: parsed.recurrence.value?.toString() || "",
  };
  await createRow(payload);
  const resumo = formatEntrySummary(payload);
  const recurrenceLabel = describeRecurrence(payload);
  let message = `♻ Conta fixa cadastrada com sucesso!\n\n${resumo}`;
  if (recurrenceLabel) message += `\n\n🔄 Recorrência: ${recurrenceLabel}`;
  message += `\n\n📅 Próximo vencimento: ${formatBRDate(due)}.`;
  message += `\n\n✅ Para confirmar pagamento depois, envie "Confirmar 1".`;
  await sendText(fromRaw, message);
  if (["pix", "boleto"].includes((parsed.tipoPagamento || "").toLowerCase())) {
    await promptAttachPaymentCode(fromRaw, userNorm, payload, "fixed_register");
  }
  await sendMainMenu(fromRaw);
}

// ============================
// Intent detection
// ============================
const KNOWN_INTENTS = new Set([
  "boas_vindas",
  "relatorios_menu",
  "relatorio_completo",
  "listar_lancamentos",
  "listar_pendentes",
  "editar",
  "excluir",
  "registrar_recebimento",
  "registrar_pagamento",
  "contas_fixas",
  "desconhecido",
]);

const detectIntentHeuristic = (text) => {
  const lower = (text || "").toLowerCase();
  const normalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/(oi|ola|opa|bom dia|boa tarde|boa noite)/.test(normalized)) return "boas_vindas";
  if (/\brelat[óo]rios?\b/.test(lower)) return "relatorios_menu";
  if (/\brelat[óo]rio\s+completo\b/.test(lower) || /\bcompleto\b/.test(lower)) return "relatorio_completo";
  if (/\blan[cç]amentos\b|extrato/.test(lower)) return "listar_lancamentos";
  if (/contas?\s+a\s+pagar|pendentes|a pagar/.test(lower)) return "listar_pendentes";
  if (/contas?\s+fixas?/.test(lower)) return "contas_fixas";
  if (/editar lan[cç]amentos?/.test(lower)) return "editar";
  if (/excluir lan[cç]amentos?/.test(lower)) return "excluir";
  if (/registrar recebimento|\brecebimento\b/.test(lower)) return "registrar_recebimento";
  if (/registrar pagamento|\bpagamento\b/.test(lower)) return "registrar_pagamento";
  return "desconhecido";
};

const normalizeIntent = (value) => {
  if (!value) return null;
  const formatted = value
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "");
  return KNOWN_INTENTS.has(formatted) ? formatted : null;
};

const buildIntentPrompt = (text) => {
  const options = Array.from(KNOWN_INTENTS).join(", ");
  return [
    {
      role: "system",
      content: [
        {
          type: "text",
          text:
            "Você é um classificador de intenções para um assistente financeiro no WhatsApp. Responda apenas com uma das intenções disponíveis, sem explicações.",
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Opções válidas: ${options}.\nMensagem: "${text}"\nResponda somente com uma das opções. Use "desconhecido" caso não tenha correspondência.`,
        },
      ],
    },
  ];
};

const detectIntent = async (text) => {
  const fallback = detectIntentHeuristic(text);
  if (!text || !openaiClient) return fallback;
  try {
    const output = await callOpenAI({
      model: OPENAI_INTENT_MODEL,
      input: buildIntentPrompt(text),
      temperature: 0,
      maxOutputTokens: 50,
    });
    const predicted = normalizeIntent(output);
    if (predicted) return predicted;
  } catch (error) {
    console.error("Falha ao consultar OpenAI para intenção:", error?.message || error);
  }
  return fallback;
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
    if (id === "REG:STATUS:PAGO") {
      await handleStatusSelection(from, userNorm, "pago");
      return;
    }
    if (id === "REG:STATUS:PENDENTE") {
      await handleStatusSelection(from, userNorm, "pendente");
      return;
    }
    if (id.startsWith("REG:EDIT:")) {
      const [, , rowId] = id.split(":");
      const row = await findRowById(userNorm, rowId);
      if (!row) {
        await sendText(from, "Não encontrei o lançamento para editar.");
        return;
      }
      sessionEdit.set(userNorm, {
        awaiting: "field",
        rows: [row],
        queue: [{ row, displayIndex: 1 }],
        currentIndex: 0,
        row,
        displayIndex: 1,
        expiresAt: Date.now() + SESSION_TIMEOUT_MS,
      });
      const summary = formatEntrySummary(row, { headerLabel: "🧾 Lançamento selecionado:" });
      await sendText(
        from,
        `${summary}\n\n✏ Editar lançamento\n\nEscolha o que deseja alterar:\n\n🏷 Conta\n📝 Descrição\n💰 Valor\n📅 Data\n📌 Status\n📂 Categoria\n\n💡 Dica: Digite exatamente o nome do item que deseja editar.\n(ex: valor, data, categoria...)`
      );
      return;
    }
    if (id.startsWith("REG:KEEP:")) {
      await sendText(from, "Perfeito! O lançamento foi mantido como está.");
      return;
    }
    if (id.startsWith("PAYCODE:ADD:")) {
      const [, , rowId] = id.split(":");
      const state = sessionPaymentCode.get(userNorm);
      if (state && state.rowId === rowId) {
        setPaymentCodeState(userNorm, { awaiting: "input", rowId, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      } else {
        setPaymentCodeState(userNorm, { awaiting: "input", rowId, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      }
      await sendText(from, "🔗 Envie o código do Pix (cópia e cola ou chave Pix) ou o código de barras do boleto.");
      return;
    }
    if (id.startsWith("PAYCODE:SKIP:")) {
      sessionPaymentCode.delete(userNorm);
      await sendText(from, "Tudo bem! Se precisar anexar depois, é só me avisar.");
      return;
    }
    if (id.startsWith("PAY:MARK:")) {
      const [, , rowId] = id.split(":");
      const state = sessionPayConfirm.get(userNorm);
      const current = state?.queue?.[state.currentIndex || 0];
      if (current?.row && getRowIdentifier(current.row) === rowId) {
        await markPaymentAsPaid(from, userNorm, current.row);
      } else {
        await sendText(from, "Não encontrei o lançamento selecionado para confirmar.");
      }
      return;
    }
    if (id === "PAY:CANCEL") {
      sessionPayConfirm.delete(userNorm);
      await sendText(from, "Operação cancelada.");
      return;
    }
    if (id.startsWith("PAY:COPY:")) {
      const [, , rowId] = id.split(":");
      const row = await findRowById(userNorm, rowId);
      if (row) {
        await sendPaymentCode(from, row);
      } else {
        await sendText(from, "Não encontrei um código salvo para este lançamento.");
      }
      const state = sessionPayConfirm.get(userNorm);
      if (state) setPayState(userNorm, { ...state, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      return;
    }
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
      if (opt === "hoje") {
        const start = startOfDay(now);
        const end = endOfDay(now);
        await showLancamentos(from, userNorm, { start, end });
      } else if (opt === "mes_atual") {
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
      sessionFixedRegister.set(userNorm, { expiresAt: Date.now() + SESSION_TIMEOUT_MS });
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

  if (await handlePaymentCodeFlow(fromRaw, userNorm, trimmed)) return;
  if (await handleStatusConfirmationFlow(fromRaw, userNorm, trimmed)) return;
  if (await handlePaymentConfirmFlow(fromRaw, userNorm, trimmed)) return;
  if (await handleFixedDeleteFlow(fromRaw, userNorm, trimmed)) return;
  if (await handleFixedRegisterFlow(fromRaw, userNorm, trimmed)) return;
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

  const intent = await detectIntent(trimmed);
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
    case "contas_fixas":
      await sendContasFixasMenu(fromRaw);
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
      const fixedParsed = parseFixedAccountCommand(text);
      if (fixedParsed) {
        await registerFixedAccount(fromRaw, userNorm, fixedParsed);
      } else if (extractAmountFromText(trimmed).amount) {
        await registerEntry(fromRaw, userNorm, text);
      } else {
        await sendMainMenu(fromRaw);
      }
      break;
  }
}

async function handleStripeWebhook(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.error("Stripe não configurado corretamente.");
    res.sendStatus(200);
    return;
  }

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("⚠️  Erro ao validar webhook Stripe:", err.message);
    res.status(400).send(`Webhook error: ${err.message}`);
    return;
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const whatsapp = session.metadata?.whatsapp;

    if (whatsapp) {
      console.log("✅ Novo pagamento Stripe recebido:", whatsapp);
      try {
        const sheet = await ensureSheetClientes();
        await sheet.addRow({
          user: whatsapp,
          plano: "Ativo",
          ativo: "TRUE",
          data_inicio: new Date().toISOString().split("T")[0],
          vencimento_plano: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
        });

        await sendText(
          whatsapp,
          "🎉 Bem-vindo(a) à *FinPlanner IA*! Seu plano foi ativado com sucesso. Envie uma mensagem a qualquer momento para começar seu planejamento financeiro."
        );
      } catch (error) {
        console.error("Erro ao registrar cliente após pagamento:", error);
      }
    }
  }

  res.sendStatus(200);
}

app.post(
  "/stripe/webhook",
  bodyParser.raw({ type: "application/json" }),
  handleStripeWebhook
);

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
            const messageId = message.id;
            if (isDuplicateMessage(messageId)) {
              if (DEBUG_SHEETS) console.log(`[Webhook] Ignorando mensagem duplicada ${messageId}`);
              continue;
            }
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
