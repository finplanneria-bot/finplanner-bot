// ============================
// FinPlanner IA - WhatsApp Bot
// Versão: app.js v2025-10-23.1
// ============================

import "dotenv/config";

import express from "express";
import Stripe from "stripe";
import OpenAI from "openai";
import axios from "axios";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import path from "path";
import { fileURLToPath } from "url";

// ============================
// ENV
// ============================
// 🔧 Variáveis de ambiente principais
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USE_OPENAI_RAW = process.env.USE_OPENAI;
const DEBUG_SHEETS_RAW = process.env.DEBUG_SHEETS;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_MENSAL = process.env.STRIPE_PRICE_MENSAL;
const STRIPE_PRICE_TRIMESTRAL = process.env.STRIPE_PRICE_TRIMESTRAL;
const STRIPE_PRICE_ANUAL = process.env.STRIPE_PRICE_ANUAL;
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL;
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL;

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
    const responsesClient = openaiClient.responses;
    if (responsesClient && typeof responsesClient.create === "function") {
      const response = await responsesClient.create({
        model,
        input,
        temperature,
        max_output_tokens: maxOutputTokens,
      });
      return response?.output_text?.trim() || null;
    }
    const chatCompletionsClient = openaiClient.chat?.completions;
    if (chatCompletionsClient && typeof chatCompletionsClient.create === "function") {
      const response = await chatCompletionsClient.create({
        model,
        messages: messages.length ? messages : [{ role: "user", content: typeof input === "string" ? input : JSON.stringify(input) }],
        temperature,
        max_tokens: maxOutputTokens,
      });
      return response?.choices?.[0]?.message?.content?.trim() || null;
    }
    const completionsClient = openaiClient.completions;
    if (completionsClient && typeof completionsClient.create === "function") {
      const prompt = (messages.length ? messages : [{ role: "user", content: typeof input === "string" ? input : JSON.stringify(input) }])
        .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
        .join("\n\n");
      const response = await completionsClient.create({
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

// Stripe webhook (raw body) - endpoint: /webhook/stripe
// Eventos no Stripe Dashboard:
// - checkout.session.completed
// - invoice.payment_succeeded
// - invoice.payment_failed
// - customer.subscription.deleted
app.post("/webhook/stripe", express.raw({ type: "application/json" }), handleStripeWebhook);

app.use(express.json());

app.get("/internal/wake", (_req, res) => {
  console.log(`[WAKE] Servidor acordado em ${new Date().toISOString()}`);
  res.status(200).json({ ok: true, status: "awake" });
});

app.post("/internal/cron-aviso", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const resumo = await runAvisoCron({ requestedBy: "cron-job" });
    return res.status(200).json({ ok: true, resumo });
  } catch (e) {
    console.error("[CRON] endpoint error:", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.get("/", (_req, res) => {
  res.send("FinPlanner IA ativo! 🚀");
});

app.post("/checkout", async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: "Stripe não configurado." });
  }
  const { plano, whatsapp, nome, email } = req.body || {};
  if (!whatsapp) {
    return res.status(400).json({ error: "whatsapp obrigatório." });
  }
  const planoNorm = normalizePlan(plano) || "mensal";
  const priceMap = {
    mensal: STRIPE_PRICE_MENSAL,
    trimestral: STRIPE_PRICE_TRIMESTRAL,
    anual: STRIPE_PRICE_ANUAL,
  };
  const priceId = priceMap[planoNorm];
  if (!priceId) {
    return res.status(400).json({ error: "Plano inválido ou price não configurado." });
  }
  if (!STRIPE_SUCCESS_URL || !STRIPE_CANCEL_URL) {
    return res.status(500).json({ error: "URLs de checkout não configuradas." });
  }

  console.log("Checkout create payload:", { plano: planoNorm, whatsapp: !!whatsapp });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      subscription_data: {
        metadata: {
          whatsapp: String(whatsapp || ""),
          plano: planoNorm,
          nome: String(nome || ""),
          email: String(email || ""),
        },
      },
      metadata: {
        whatsapp: String(whatsapp || ""),
        plano: planoNorm,
      },
    });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("Erro ao criar checkout:", error.message);
    return res.status(500).json({ error: "Erro ao criar checkout." });
  }
});

// ============================
// Utils
// ============================
const normalizeUser = (num) => (num || "").replace(/\D/g, "");
const userFirstNames = new Map();

const extractFirstName = (value) => {
  if (!value) return "";
  const cleaned = value.toString().trim();
  if (!cleaned) return "";
  const parts = cleaned.split(/\s+/);
  const first = parts[0] || "";
  return first;
};

const rememberUserName = (userNorm, fullName) => {
  if (!userNorm || !fullName) return;
  const first = extractFirstName(fullName);
  if (!first) return;
  userFirstNames.set(userNorm, first);
};

const getStoredFirstName = (userNorm) => {
  if (!userNorm) return "";
  return userFirstNames.get(userNorm) || "";
};

const processedMessages = new Map();
const MESSAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const lastInboundInteraction = new Map();
const reminderAdminNotice = new Map();
const WA_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const usuarioStatusCache = new Map();
const USUARIO_CACHE_TTL_MS = 60 * 1000;

const recordUserInteraction = (userNorm) => {
  if (!userNorm) return;
  lastInboundInteraction.set(userNorm, Date.now());
};

function hasRecentUserInteraction(userNorm) {
  if (!userNorm) return false;
  const last = lastInboundInteraction.get(userNorm);
  return typeof last === "number" && Date.now() - last <= WA_SESSION_WINDOW_MS;
}

const shouldNotifyAdminReminder = (userNorm) => {
  if (!userNorm) return false;
  const today = new Date().toISOString().split("T")[0];
  const key = reminderAdminNotice.get(userNorm);
  if (key === today) return false;
  reminderAdminNotice.set(userNorm, today);
  return true;
};

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

const DATE_TOKEN_PATTERN = "\\b(\\d{1,2}[\\/-]\\d{1,2}(?:[\\/-]\\d{2,4})?)\\b";
const VALUE_TOKEN_PATTERN =
  "(?:R\\$?\\s*)?(?:\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)(?!\\s*[\\/-]\\d)";

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
  const source = text.toString();

  const dataRegexGlobal = new RegExp(DATE_TOKEN_PATTERN, "g");
  const dateMatches = [...source.matchAll(dataRegexGlobal)];
  const spans = dateMatches.map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));

  const inlineTrailingDateRegex = /[\/-]\s*\d{1,2}(?:[\/-]\d{2,4})?/g;
  let trailing;
  while ((trailing = inlineTrailingDateRegex.exec(source)) !== null) {
    const prevChar = source[trailing.index - 1];
    if (prevChar && /\d/.test(prevChar)) {
      spans.push({ start: trailing.index, end: trailing.index + trailing[0].length });
    }
  }

  spans.sort((a, b) => a.start - b.start);

  const valorRegexGlobal = new RegExp(VALUE_TOKEN_PATTERN, "gi");
  let match;
  while ((match = valorRegexGlobal.exec(source)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (spans.some((span) => start < span.end && end > span.start)) continue;
    const raw = match[0];
    const value = parseNumericToken(raw);
    if (value) return { amount: value, raw };
  }

  const words = extractNumberWords(source);
  if (words) return words;

  let sanitized = source;
  if (spans.length) {
    const chars = Array.from(source);
    spans.forEach(({ start, end }) => {
      for (let i = start; i < end; i += 1) {
        chars[i] = " ";
      }
    });
    sanitized = chars.join("");
  }
  const fallbackRegex = /\d+(?:[.,]\d+)?k|\d+/gi;
  while ((match = fallbackRegex.exec(sanitized)) !== null) {
    const raw = match[0];
    const remainder = sanitized.slice(match.index + raw.length);
    const trailingDigits = remainder.match(/^\s*[\/-]\s*\d/);
    if (trailingDigits) continue;
    let cursor = 0;
    while (cursor < remainder.length && /\s/.test(remainder[cursor])) cursor += 1;
    if (cursor < remainder.length && /\d/.test(remainder[cursor])) continue;
    const value = parseNumericToken(raw);
    if (value) return { amount: value, raw };
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
  const match = token.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const currentYear = new Date().getFullYear();
    let year = currentYear;
    if (match[3]) {
      year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    } else {
      const tentative = new Date(currentYear, month, day);
      const now = new Date();
      if (tentative < startOfDay(now)) {
        year = currentYear + 1;
      }
    }
    const d = new Date(year, month, day);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
};

const CATEGORY_DEFINITIONS = [
  {
    slug: "mercado",
    label: "Mercado / Supermercado",
    emoji: "🛒",
    description: "Compras de supermercado, feira e itens de despensa para casa.",
    keywords: [
      "mercado",
      "supermercado",
      "hortifruti",
      "atacado",
      "atacadista",
      "sacolao",
      "mercearia",
      "açougue",
      "acougue",
      "feira",
      "compras do mes",
      "cesta basica",
    ],
    aliases: ["supermercado", "mercado_supermercado"],
  },
  {
    slug: "alimentacao",
    label: "Alimentação",
    emoji: "🍽️",
    description: "Refeições prontas, lanches e alimentação fora de casa.",
    keywords: [
      "restaurante",
      "lanche",
      "lanchonete",
      "ifood",
      "almoço",
      "almoco",
      "jantar",
      "padaria",
      "marmita",
      "self-service",
      "delivery",
      "comida pronta",
      "quentinha",
      "espetinho",
    ],
  },
  {
    slug: "bebidas",
    label: "Bebidas",
    emoji: "🍹",
    description: "Bebidas alcoólicas ou não alcoólicas compradas separadamente da refeição.",
    keywords: [
      "bebida",
      "cerveja",
      "refrigerante",
      "vinho",
      "drink",
      "drinks",
      "bar",
      "chopp",
      "suco",
      "água",
      "agua",
      "whisky",
      "gin",
      "café",
      "cafe",
      "energético",
      "energetico",
    ],
  },
  {
    slug: "higiene_pessoal",
    label: "Higiene Pessoal",
    emoji: "🧴",
    description: "Produtos de cuidado pessoal, higiene e cosméticos.",
    keywords: [
      "higiene",
      "sabonete",
      "shampoo",
      "condicionador",
      "creme",
      "desodorante",
      "perfume",
      "escova",
      "pasta",
      "fio dental",
      "absorvente",
      "barbeador",
      "cotonete",
      "higiene pessoal",
      "cosmetico",
      "cosmético",
    ],
  },
  {
    slug: "utilidades",
    label: "Utilidades",
    emoji: "🔌",
    description: "Contas essenciais como luz, água e gás.",
    keywords: ["luz", "energia", "água", "agua", "gás", "gas", "conta de luz", "conta de agua"],
  },
  {
    slug: "internet_telefonia",
    label: "Internet / Telefonia",
    emoji: "🌐",
    description: "Planos de internet, telefonia fixa ou celular.",
    keywords: ["internet", "fibra", "vivo", "claro", "tim", "oi", "telefonia", "celular", "telefone"],
  },
  {
    slug: "moradia",
    label: "Moradia",
    emoji: "🏠",
    description: "Custos de moradia como aluguel, condomínio e financiamentos.",
    keywords: ["aluguel", "condomínio", "condominio", "iptu", "financiamento", "alojamento", "imovel", "imóvel"],
  },
  {
    slug: "transporte",
    label: "Transporte",
    emoji: "🚗",
    description: "Deslocamentos, combustível, pedágios e manutenção de veículos.",
    keywords: [
      "uber",
      "99",
      "gasolina",
      "combustível",
      "combustivel",
      "passagem",
      "ônibus",
      "onibus",
      "transporte",
      "estacionamento",
      "pedágio",
      "pedagio",
      "manutenção carro",
      "manutencao carro",
    ],
  },
  {
    slug: "saude",
    label: "Saúde",
    emoji: "💊",
    description: "Cuidados com saúde, planos, exames e medicamentos.",
    keywords: [
      "academia",
      "plano",
      "consulta",
      "dentista",
      "farmácia",
      "farmacia",
      "remédio",
      "remedio",
      "exame",
      "hospital",
      "terapia",
    ],
  },
  {
    slug: "educacao",
    label: "Educação",
    emoji: "🎓",
    description: "Cursos, mensalidades, materiais e formação.",
    keywords: ["curso", "faculdade", "escola", "mensalidade", "aula", "material", "livro", "apostila"],
  },
  {
    slug: "lazer",
    label: "Lazer",
    emoji: "🎭",
    description: "Atividades de lazer, cultura, assinaturas e viagens.",
    keywords: ["netflix", "spotify", "cinema", "show", "lazer", "entretenimento", "viagem", "passeio", "parque"],
  },
  {
    slug: "impostos_taxas",
    label: "Impostos e Taxas",
    emoji: "🧾",
    description: "Tributos, licenças, multas e encargos governamentais.",
    keywords: ["multa", "taxa", "imposto", "receita", "darf", "alvará", "alvara", "licenciamento"],
  },
  {
    slug: "servicos_domesticos",
    label: "Serviços Domésticos",
    emoji: "🧹",
    description: "Serviços para casa como faxina, diarista e reparos.",
    keywords: ["faxina", "diarista", "limpeza", "serviço doméstico", "servico domestico", "manutenção", "manutencao"],
  },
  {
    slug: "salario_trabalho",
    label: "Salário / Trabalho",
    emoji: "💼",
    description: "Receitas de salário, folha de pagamento e pró-labore.",
    keywords: ["salário", "salario", "pagamento", "folha", "pro labore", "adiantamento", "contrato"],
  },
  {
    slug: "vendas_receitas",
    label: "Vendas e Receitas",
    emoji: "💵",
    description: "Recebimentos por vendas, serviços e entradas diversas.",
    keywords: ["venda", "recebimento", "cliente", "boleto recebido", "serviço", "servico", "entrada", "receita"],
  },
  {
    slug: "investimentos",
    label: "Investimentos",
    emoji: "📈",
    description: "Aportes, resgates e movimentações financeiras de investimentos.",
    keywords: ["investimento", "bolsa", "renda fixa", "tesouro", "ação", "acao", "cripto", "poupança", "poupanca"],
  },
  {
    slug: "outros",
    label: "Outros",
    emoji: "🧩",
    description: "Despesas ou receitas que não se encaixam nas demais categorias.",
    keywords: [],
  },
];

const sanitizeCategoryKey = (value) => {
  if (!value) return "";
  return normalizeDiacritics(value.toString().toLowerCase())
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
};

const CATEGORY_BY_SLUG = new Map();
CATEGORY_DEFINITIONS.forEach((category) => {
  category.normalizedKeywords = (category.keywords || []).map((kw) => normalizeDiacritics(kw));
  const keys = new Set([
    sanitizeCategoryKey(category.slug),
    sanitizeCategoryKey(category.label),
  ]);
  (category.aliases || []).forEach((alias) => keys.add(sanitizeCategoryKey(alias)));
  keys.forEach((key) => {
    if (key) CATEGORY_BY_SLUG.set(key, category);
  });
});

const getCategoryDefinition = (slug) => {
  const key = sanitizeCategoryKey(slug);
  if (!key) return null;
  return CATEGORY_BY_SLUG.get(key) || null;
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
    const keywords = category.normalizedKeywords || [];
    if (keywords.some((kw) => kw && normalized.includes(kw))) {
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
  const detail = category.description ? ` - ${category.description}` : "";
  const sampleText = samples.length ? ` Exemplos: ${samples.join(", ")}.` : "";
  return `${category.slug}: ${category.label}${detail}${sampleText}`;
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
    const predicted = output?.trim();
    const def = getCategoryDefinition(predicted);
    if (!def && predicted) {
      const pieces = predicted.split(/\s|,|;|\n/).filter(Boolean);
      for (const piece of pieces) {
        const candidate = getCategoryDefinition(piece);
        if (candidate) {
          return { slug: candidate.slug, emoji: candidate.emoji };
        }
      }
    }
    if (def) return { slug: def.slug, emoji: def.emoji };
  } catch (error) {
    console.error("Falha ao consultar OpenAI para categoria:", error?.message || error);
  }
  return fallback;
};

// ============================
// WhatsApp helpers
// ============================
const WA_API_VERSION = "v17.0";
const WA_API = `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
const WA_TEXT_LIMIT = 4000;
const TEMPLATE_REMINDER_NAME = "lembrete_finplanner_1";
const TEMPLATE_REMINDER_BUTTON_ID = "REMINDERS_VIEW";
const ADMIN_FALLBACK_NUMBER = "5579998023759";
const ADMIN_NUMBER_NORM = normalizeUser(ADMIN_WA_NUMBER || ADMIN_FALLBACK_NUMBER);
const ADMIN_NUMBERS = new Set();

function registerAdminNumber(value) {
  const norm = normalizeUser(value);
  if (!norm) return;
  ADMIN_NUMBERS.add(norm);
  const candidates = getUserCandidates(norm);
  for (const candidate of candidates) {
    ADMIN_NUMBERS.add(candidate);
  }
}

function isAdminUser(userNorm) {
  const norm = normalizeUser(userNorm);
  if (!norm) return false;
  if (ADMIN_NUMBERS.has(norm)) return true;
  const candidates = getUserCandidates(norm);
  return candidates.some((candidate) => ADMIN_NUMBERS.has(candidate));
}

registerAdminNumber(ADMIN_WA_NUMBER);
registerAdminNumber(ADMIN_FALLBACK_NUMBER);

const splitLongMessage = (text, limit = WA_TEXT_LIMIT) => {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > limit) {
    let sliceIndex = remaining.lastIndexOf("\n", limit);
    if (sliceIndex === -1 || sliceIndex < limit * 0.5) {
      const spaceIndex = remaining.lastIndexOf(" ", limit);
      if (spaceIndex > sliceIndex) {
        sliceIndex = spaceIndex;
      }
    }
    if (sliceIndex === -1 || sliceIndex === 0) {
      sliceIndex = limit;
    }
    const chunk = remaining.slice(0, sliceIndex).trimEnd();
    if (chunk) {
      parts.push(chunk);
    }
    remaining = remaining.slice(sliceIndex).trimStart();
    if (!remaining) {
      break;
    }
    if (remaining.length <= limit) {
      parts.push(remaining);
      return parts;
    }
  }
  if (remaining && remaining.length <= limit) {
    parts.push(remaining);
  }
  return parts;
};

async function sendWA(payload, context = {}) {
  try {
    await axios.post(WA_API, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    return true;
  } catch (error) {
    console.error("[WA] error", {
      kind: context.kind || payload?.type,
      response: error.response?.data || error.message,
    });
    return false;
  }
}

const sendTemplateReminder = async (to, userNorm, nameHint = "") => {
  const firstName = (nameHint || getStoredFirstName(userNorm) || "").trim();
  const safeName = firstName || "-";
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: TEMPLATE_REMINDER_NAME,
      language: { code: "pt_BR" },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: safeName }],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: TEMPLATE_REMINDER_BUTTON_ID }],
        },
      ],
    },
  };
  console.log("[WA] sending", {
    to,
    kind: "template",
    withinWindow: false,
    hasBody: false,
    templateName: TEMPLATE_REMINDER_NAME,
  });
  const success = await sendWA(payload, { kind: "template" });
  if (success) {
    console.log("✅ Template de reengajamento enviado para", to);
  }
  return success;
};

const ensureSessionWindow = async ({ to, userNorm, nameHint, bypassWindow = false }) => {
  if (!to) return false;
  if (bypassWindow) return true;
  if (isAdminUser(userNorm)) {
    return true;
  }
  if (hasRecentUserInteraction(userNorm)) {
    return true;
  }
  await sendTemplateReminder(to, userNorm, nameHint);
  return false;
};

const sendText = async (to, body, options = {}) => {
  const trimmedBody = typeof body === "string" ? body.trim() : "";
  if (!to || !trimmedBody) {
    console.log("[WA] skip empty text", { to, context: options.context || null });
    return { ok: false, skipped: true, reason: "empty_text" };
  }
  const userNorm = normalizeUser(to);
  const nameHint = options.nameHint || getStoredFirstName(userNorm);
  const canSend = await ensureSessionWindow({
    to,
    userNorm,
    nameHint,
    bypassWindow: options.bypassWindow || false,
  });
  if (!canSend) return { ok: false, skipped: true, reason: "outside_window" };
  const segments = splitLongMessage(trimmedBody);
  let allDelivered = true;
  const total = segments.length || 1;
  if (total === 0) return { ok: false, skipped: true, reason: "empty_text" };
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    console.log("[WA] sending", {
      to,
      kind: "text",
      withinWindow: options.withinWindow ?? null,
      hasBody: Boolean(segment && segment.trim()),
      templateName: null,
    });
    const success = await sendWA(
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: segment },
      },
      { kind: "text" }
    );
    if (success) {
      const suffix = total > 1 ? ` (parte ${index + 1}/${total})` : "";
      console.log("💬 Mensagem enviada normalmente para", to, suffix);
    } else {
      allDelivered = false;
      break;
    }
  }
  return { ok: allDelivered, skipped: false };
};

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

const USUARIOS_HEADERS = ["user", "plano", "ativo", "data_inicio", "vencimento_plano", "email", "nome", "checkout_id"];
const USER_LANC_HEADERS = [
  "row_id",
  "tipo",
  "descricao",
  "categoria",
  "status",
  "valor",
  "contas_a_pagar",
  "contas_a_receber",
  "vencimento_iso",
  "vencimento_br",
  "criado_em",
];
const CONFIG_HEADERS = ["key", "value"];
const SHEET_READ_BACKOFF_MS = [1000, 2000, 4000, 8000, 12000];
const USER_SHEET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const userSheetCache = new Map();

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async (fn, label) => {
  for (let attempt = 0; attempt < SHEET_READ_BACKOFF_MS.length; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const status = error?.response?.status || error?.code;
      if (status === 429 || status === 403) {
        const delay = SHEET_READ_BACKOFF_MS[attempt] + Math.floor(Math.random() * 250);
        console.warn(`🔁 Sheets retry (${label}) tentativa ${attempt + 1}: aguardando ${delay}ms`);
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
  return null;
};

async function ensureSheet() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["finplanner"];
  if (!sheet) {
    sheet = await withRetry(() => doc.addSheet({ title: "finplanner", headerValues: SHEET_HEADERS }), "add-sheet");
  } else {
    await withRetry(() => sheet.loadHeaderRow(), "load-header-finplanner");
    const current = sheet.headerValues || [];
    const normalized = current.map((header) => (header || "").trim());
    const hasDuplicate = new Set(normalized.filter(Boolean)).size !== normalized.filter(Boolean).length;
    const missing = SHEET_HEADERS.filter((header) => !normalized.includes(header));
    const orderMismatch = SHEET_HEADERS.some((header, index) => normalized[index] !== header);

    if (hasDuplicate || missing.length || orderMismatch || normalized.length !== SHEET_HEADERS.length) {
      await withRetry(() => sheet.setHeaderRow(SHEET_HEADERS), "set-header-finplanner");
    }
  }
  return sheet;
}

async function ensureSheetUsuarios() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["Usuarios"];
  if (!sheet) {
    sheet = await withRetry(() => doc.addSheet({ title: "Usuarios", headerValues: USUARIOS_HEADERS }), "add-usuarios");
  } else {
    await withRetry(() => sheet.loadHeaderRow(), "load-header-usuarios");
    const current = (sheet.headerValues || []).map((header) => (header || "").trim());
    const filtered = current.filter(Boolean);
    const hasDuplicate = new Set(filtered).size !== filtered.length;
    const missing = USUARIOS_HEADERS.filter((header) => !current.includes(header));
    const orderMismatch = USUARIOS_HEADERS.some((header, index) => current[index] !== header);
    if (hasDuplicate || missing.length || orderMismatch || current.length !== USUARIOS_HEADERS.length) {
      await withRetry(() => sheet.setHeaderRow(USUARIOS_HEADERS), "set-header-usuarios");
    }
  }
  console.log("📄 Usuarios headers:", sheet.headerValues);
  return sheet;
}

const getUserSheetName = (userNorm) => {
  const base = `Usuario_${userNorm || "desconhecido"}`.replace(/[\\/*?:[\]]/g, "_");
  return base.length > 100 ? base.slice(0, 100) : base;
};

async function ensureUserSheet(userNorm) {
  await ensureAuth();
  const title = getUserSheetName(userNorm);
  const cached = userSheetCache.get(userNorm);
  if (cached && cached.expiresAt > Date.now() && cached.title === title) {
    console.log("📌 Cache aba usuário:", { userNorm, title });
  }
  let sheet = doc.sheetsByTitle[title];
  if (!sheet) {
    sheet = await withRetry(() => doc.addSheet({ title, headerValues: USER_LANC_HEADERS }), "add-user-sheet");
  } else {
    await withRetry(() => sheet.loadHeaderRow(), "load-header-user-sheet");
    const current = (sheet.headerValues || []).map((header) => (header || "").trim());
    const filtered = current.filter(Boolean);
    const hasDuplicate = new Set(filtered).size !== filtered.length;
    const missing = USER_LANC_HEADERS.filter((header) => !current.includes(header));
    const orderMismatch = USER_LANC_HEADERS.some((header, index) => current[index] !== header);
    if (hasDuplicate || missing.length || orderMismatch || current.length !== USER_LANC_HEADERS.length) {
      await withRetry(() => sheet.setHeaderRow(USER_LANC_HEADERS), "set-header-user-sheet");
    }
  }
  userSheetCache.set(userNorm, { title, expiresAt: Date.now() + USER_SHEET_CACHE_TTL_MS });
  return sheet;
}

async function ensureConfigSheet() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["CONFIG"];
  if (!sheet) {
    sheet = await withRetry(() => doc.addSheet({ title: "CONFIG", headerValues: CONFIG_HEADERS }), "add-config");
  } else {
    await withRetry(() => sheet.loadHeaderRow(), "load-header-config");
    const current = (sheet.headerValues || []).map((header) => (header || "").trim());
    const filtered = current.filter(Boolean);
    const hasDuplicate = new Set(filtered).size !== filtered.length;
    const missing = CONFIG_HEADERS.filter((header) => !current.includes(header));
    const orderMismatch = CONFIG_HEADERS.some((header, index) => current[index] !== header);
    if (hasDuplicate || missing.length || orderMismatch || current.length !== CONFIG_HEADERS.length) {
      await withRetry(() => sheet.setHeaderRow(CONFIG_HEADERS), "set-header-config");
    }
  }
  return sheet;
}

const getConfigValue = async (key) => {
  const sheet = await ensureConfigSheet();
  const rows = await withRetry(() => sheet.getRows(), "get-config");
  const found = rows?.find((row) => getVal(row, "key") === key);
  return found ? getVal(found, "value") : "";
};

const setConfigValue = async (key, value) => {
  const sheet = await ensureConfigSheet();
  const rows = await withRetry(() => sheet.getRows(), "get-config");
  const found = rows?.find((row) => getVal(row, "key") === key);
  if (found) {
    setVal(found, "value", value);
    await withRetry(() => found.save(), "save-config");
  } else {
    await withRetry(() => sheet.addRow({ key, value }), "add-config-row");
  }
};

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

const buildUserSheetRow = (entry) => {
  const tipo = getVal(entry, "tipo");
  const valor = getVal(entry, "valor");
  return {
    row_id: getVal(entry, "row_id"),
    tipo,
    descricao: getVal(entry, "descricao"),
    categoria: getVal(entry, "categoria"),
    status: getVal(entry, "status"),
    valor,
    contas_a_pagar: tipo === "conta_pagar" ? valor : "",
    contas_a_receber: tipo === "conta_receber" ? valor : "",
    vencimento_iso: getVal(entry, "vencimento_iso"),
    vencimento_br: getVal(entry, "vencimento_br"),
    criado_em: getVal(entry, "timestamp") || new Date().toISOString(),
  };
};

const upsertUserSheetEntry = async (entry, { skipCheck = false } = {}) => {
  const userRaw = getVal(entry, "user") || getVal(entry, "user_raw");
  const userNorm = normalizeUser(userRaw);
  const rowId = getVal(entry, "row_id");
  if (!userNorm || !rowId) return;
  const sheet = await ensureUserSheet(userNorm);
  if (skipCheck) {
    await withRetry(() => sheet.addRow(buildUserSheetRow(entry)), "append-user-sheet");
    return;
  }
  const rows = await withRetry(() => sheet.getRows(), "get-user-rows");
  const exists = rows?.find((row) => getVal(row, "row_id") === rowId);
  if (exists) return;
  await withRetry(() => sheet.addRow(buildUserSheetRow(entry)), "append-user-sheet");
};

function normalizePlan(input) {
  if (!input) return null;
  const p = String(input).trim().toLowerCase();

  if (p === "mensal" || p.includes("mensal") || p === "monthly" || p === "month") return "mensal";
  if (p === "trimestral" || p.includes("trim") || p === "quarterly" || p === "quarter") return "trimestral";
  if (p === "anual" || p.includes("anual") || p.includes("anu") || p === "yearly" || p === "annual" || p === "year")
    return "anual";

  return null;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
}

async function getSubscriptionMetadata(stripeClient, subscriptionId) {
  if (!subscriptionId) return {};
  try {
    const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
    return sub?.metadata || {};
  } catch (e) {
    console.error("Erro ao buscar subscription metadata:", e?.message || e);
    return {};
  }
}

function isTruthy(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).trim().toLowerCase();
  return ["true", "1", "yes", "y", "sim", "s", "verdadeiro", "ativo", "on"].includes(s);
}

function parseDateLoose(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split("/").map(Number);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getUserCandidates(userNorm) {
  const candidates = new Set();
  if (userNorm) candidates.add(userNorm);
  const digits = String(userNorm || "").replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length === 13 && digits[4] === "9") {
    candidates.add(digits.slice(0, 4) + digits.slice(5));
  }
  if (digits.startsWith("55") && digits.length === 12) {
    candidates.add(digits.slice(0, 4) + "9" + digits.slice(4));
  }
  return Array.from(candidates);
}

const addMonthsSafe = (date, months) => {
  if (!date || Number.isNaN(date.getTime?.())) return null;
  const day = date.getDate();
  const base = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  return new Date(base.getFullYear(), base.getMonth(), Math.min(day, daysInMonth));
};

const formatISODate = (date) => {
  if (!date || Number.isNaN(date.getTime?.())) return "";
  return date.toISOString().split("T")[0];
};

const parseISODateSafe = (value) => {
  if (!value) return null;
  const raw = value.toString().trim();
  if (!raw) return null;
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = isoMatch ? new Date(`${raw}T00:00:00`) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

const computeNewVencimento = (currentVencISO, plan, baseDate) => {
  const planKey = normalizePlan(plan);
  if (!planKey) return null;
  const planMonths = { mensal: 1, trimestral: 3, anual: 12 };
  const today = startOfDay(new Date());
  const currentDate = parseISODateSafe(currentVencISO);
  const base =
    currentDate && startOfDay(currentDate).getTime() >= today.getTime()
      ? currentDate
      : baseDate || new Date();
  const next = addMonthsSafe(base, planMonths[planKey]);
  return formatISODate(next);
};

const upsertUsuarioFromSubscription = async ({
  userNorm,
  nome,
  plano,
  email,
  checkout_id,
  data_inicio,
  ativo,
  extendVencimento = false,
}) => {
  if (!userNorm) throw new Error("Usuário inválido.");
  const sheet = await ensureSheetUsuarios();
  const rows = await withRetry(() => sheet.getRows(), "get-usuarios");
  const target = rows.find((row) => normalizeUser(getVal(row, "user")) === userNorm);
  const normalizedPlan = normalizePlan(plano) || normalizePlan(getVal(target, "plano"));
  const existingDataInicio = parseISODateSafe(getVal(target, "data_inicio"));
  const payloadDataInicio = parseISODateSafe(data_inicio);
  const baseDataInicio = payloadDataInicio || existingDataInicio || new Date();
  const existingVencimento = getVal(target, "vencimento_plano");
  const vencimento = extendVencimento
    ? computeNewVencimento(existingVencimento, normalizedPlan, baseDataInicio) || existingVencimento
    : existingVencimento || formatISODate(baseDataInicio);
  const nowIso = formatISODate(new Date());
  const update = {
    user: userNorm,
    plano: normalizedPlan || getVal(target, "plano") || "",
    ativo: ativo ? "true" : "false",
    data_inicio: formatISODate(baseDataInicio),
    vencimento_plano: vencimento || "",
    email: email || getVal(target, "email") || "",
    nome: nome || getVal(target, "nome") || "",
    checkout_id: checkout_id || getVal(target, "checkout_id") || "",
  };

  if (target) {
    Object.entries(update).forEach(([key, value]) => setVal(target, key, value));
    await target.save();
  } else {
    await sheet.addRow(update);
  }
  const candidates = getUserCandidates(userNorm);
  candidates.forEach((candidate) => usuarioStatusCache.delete(candidate));
  console.log("✅ Usuario atualizado:", userNorm, update.plano, update.ativo);
  return update;
};

const isUsuarioAtivo = async (userNorm) => {
  if (!userNorm) return false;
  const cached = usuarioStatusCache.get(userNorm);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const sheet = await ensureSheetUsuarios();
  const rows = await withRetry(() => sheet.getRows(), "get-usuarios");
  const candidates = getUserCandidates(userNorm);
  const exact = rows.find((row) => normalizeUser(getVal(row, "user")) === userNorm);
  const candidateMatches = exact
    ? [exact]
    : rows.filter((row) => candidates.includes(normalizeUser(getVal(row, "user"))));
  const pickMostRecent = (list) =>
    list
      .slice()
      .sort((a, b) => {
        const dateA = parseDateLoose(getVal(a, "data_inicio")) || parseDateLoose(getVal(a, "vencimento_plano")) || new Date(0);
        const dateB = parseDateLoose(getVal(b, "data_inicio")) || parseDateLoose(getVal(b, "vencimento_plano")) || new Date(0);
        return dateB.getTime() - dateA.getTime();
      })[0];
  const target = exact || pickMostRecent(candidateMatches);

  if (!target) {
    console.log("🔐 AccessCheck:", {
      fromRaw: userNorm,
      userNorm,
      candidates,
      found: false,
      ativoVal: null,
      ativoOk: false,
      vencimentoVal: null,
      vencOk: false,
      planoVal: null,
    });
    usuarioStatusCache.set(userNorm, { value: false, expiresAt: Date.now() + USUARIO_CACHE_TTL_MS });
    return false;
  }
  console.log("🔎 MatchedRow:", {
    userNorm,
    candidates,
    matchedUser: getVal(target, "user"),
    ativoVal: getVal(target, "ativo"),
    planoVal: getVal(target, "plano"),
    vencimentoVal: getVal(target, "vencimento_plano"),
  });
  const ativoRaw = getVal(target, "ativo");
  const ativoOk = isTruthy(ativoRaw);
  if (!ativoOk) {
    console.log("🔐 AccessCheck:", {
      fromRaw: userNorm,
      userNorm,
      candidates,
      found: true,
      ativoVal: ativoRaw,
      ativoOk: false,
      vencimentoVal: getVal(target, "vencimento_plano"),
      vencOk: false,
      planoVal: getVal(target, "plano"),
    });
    usuarioStatusCache.set(userNorm, { value: false, expiresAt: Date.now() + USUARIO_CACHE_TTL_MS });
    return false;
  }
  const vencimentoRaw = getVal(target, "vencimento_plano");
  const vencimentoDate = parseDateLoose(vencimentoRaw);
  const today = startOfDay(new Date());
  const vencOk = vencimentoDate ? startOfDay(vencimentoDate).getTime() >= today.getTime() : true;
  const planoVal = getVal(target, "plano");
  const active = Boolean(ativoOk && vencOk);
  console.log("🔐 AccessCheck:", {
    fromRaw: userNorm,
    userNorm,
    candidates,
    found: true,
    ativoVal: ativoRaw,
    ativoOk,
    vencimentoVal: vencimentoRaw,
    vencOk,
    planoVal,
  });
  usuarioStatusCache.set(userNorm, { value: active, expiresAt: Date.now() + USUARIO_CACHE_TTL_MS });
  return active;
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
  const rows = await withRetry(() => sheet.getRows(), "get-finplanner");
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
  await withRetry(() => sheet.addRow(payload), "append-finplanner");
  await upsertUserSheetEntry(payload, { skipCheck: true });
};

const deleteRow = async (row) => {
  if (!row) return;
  if (DEBUG_SHEETS) console.log("[Sheets] Removing row", getVal(row, "row_id"));
  if (typeof row.delete === "function") await row.delete();
};

const generateRowId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const buildCronBuckets = (rows, todayMs) => {
  const dueByUser = new Map();
  const enqueueReminder = (row, kind) => {
    const dueIso = getVal(row, "vencimento_iso");
    const dueBr = getVal(row, "vencimento_br");
    const dueDate = dueIso ? new Date(dueIso) : parseDateToken(dueBr);
    if (!dueDate || Number.isNaN(dueDate.getTime())) {
      console.log("⚠️ Cron skip (data inválida):", {
        user: getVal(row, "user") || getVal(row, "user_raw"),
        tipo: getVal(row, "tipo"),
        vencimento_iso: dueIso,
        vencimento_br: dueBr,
      });
      return;
    }
    const dueMs = startOfDay(dueDate).getTime();
    if (dueMs > todayMs) {
      console.log("ℹ️ Cron skip (vencimento futuro):", {
        user: getVal(row, "user") || getVal(row, "user_raw"),
        tipo: getVal(row, "tipo"),
        vencimento_iso: dueIso,
        vencimento_br: dueBr,
      });
      return;
    }
    const toRaw = getVal(row, "user_raw") || getVal(row, "user");
    const userNorm = normalizeUser(getVal(row, "user") || getVal(row, "user_raw"));
    if (!toRaw || !userNorm) {
      console.log("⚠️ Cron skip (usuário inválido):", {
        user: getVal(row, "user") || getVal(row, "user_raw"),
        tipo: getVal(row, "tipo"),
      });
      return;
    }
    const bucket = dueByUser.get(userNorm) || { to: toRaw, items: [] };
    if (!bucket.to) bucket.to = toRaw;
    bucket.items.push({ row, kind, dueMs });
    dueByUser.set(userNorm, bucket);
  };

  for (const row of rows) {
    const tipo = (getVal(row, "tipo") || "").toString().toLowerCase();
    const status = (getVal(row, "status") || "").toString().toLowerCase();
    if (tipo === "conta_pagar" && status !== "pago") enqueueReminder(row, "pagar");
    if (tipo === "conta_receber" && !["pago", "recebido"].includes(status)) enqueueReminder(row, "receber");
  }

  return dueByUser;
};

const buildCronMessage = (items, todayMs) => {
  const pagar = items.filter((item) => item.kind === "pagar").sort((a, b) => a.dueMs - b.dueMs);
  const receber = items.filter((item) => item.kind === "receber").sort((a, b) => a.dueMs - b.dueMs);
  const sections = [];
  let counter = 1;

  if (pagar.length) {
    const blocks = pagar.map((item) => {
      const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
      const dueLabel = dueRaw || "—";
      const label = item.dueMs < todayMs ? `${dueLabel} (atrasado)` : dueLabel;
      return formatEntryBlock(item.row, { index: counter++, dateText: label });
    });
    sections.push(`💸 *Pagamentos pendentes*\n\n${blocks.join("\n\n")}`);
  }

  if (receber.length) {
    const blocks = receber.map((item) => {
      const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
      const dueLabel = dueRaw || "—";
      const label = item.dueMs < todayMs ? `${dueLabel} (atrasado)` : dueLabel;
      return formatEntryBlock(item.row, { index: counter++, dateText: label });
    });
    sections.push(`💵 *Recebimentos pendentes*\n\n${blocks.join("\n\n")}`);
  }

  if (!sections.length) return { message: "", pagar, receber };
  return { message: `⚠️ *Lembrete FinPlanner IA*\n\n${sections.join("\n\n")}`, pagar, receber };
};

const sendCronReminderForUser = async (userNorm, to, { bypassWindow = false } = {}) => {
  const sheet = await ensureSheet();
  const rows = await withRetry(() => sheet.getRows(), "get-finplanner-cron");
  const today = startOfDay(new Date());
  const dueByUser = buildCronBuckets(rows, today.getTime());
  const bucket = dueByUser.get(userNorm);
  if (!bucket || !bucket.items.length) {
    await sendText(to, "ℹ️ Nenhum lembrete pendente para este usuário.", { bypassWindow: true });
    return;
  }
  const { message, pagar, receber } = buildCronMessage(bucket.items, today.getTime());
  if (!message) {
    await sendText(to, "ℹ️ Nenhum lembrete pendente para este usuário.", { bypassWindow: true });
    return;
  }
  console.log("🧪 Cron manual (admin):", { userNorm, to, total: bucket.items.length, pagar: pagar.length, receber: receber.length });
  await sendText(to, message, { bypassWindow });
};

const migrateUserSheets = async () => {
  try {
    const sheet = await ensureSheet();
    const batchSize = 100;
    const cursorRaw = await getConfigValue("user_sheet_cursor");
    const cursor = Number.parseInt(cursorRaw || "0", 10) || 0;
    const rows = await withRetry(() => sheet.getRows({ offset: cursor, limit: batchSize }), "get-finplanner-batch");
    if (!rows || rows.length === 0) {
      console.log("ℹ️ Migração de lançamentos: nada novo para migrar.", { cursor });
      return;
    }
    let migrated = 0;
    for (const row of rows) {
      await upsertUserSheetEntry(row, { skipCheck: true });
      migrated += 1;
    }
    const nextCursor = cursor + rows.length;
    await setConfigValue("user_sheet_cursor", String(nextCursor));
    console.log("✅ Migração de lançamentos concluída:", { total: migrated, cursor: nextCursor });
  } catch (error) {
    console.error("Erro ao migrar lançamentos para abas de usuário:", error.message);
  }
};

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
  const dateMatch = original.match(new RegExp(`(hoje|amanh[ãa]|ontem|${DATE_TOKEN_PATTERN})`, "i"));
  if (dateMatch) data = parseDateToken(dateMatch[1]);

  if (!data) {
    const valueDateMatch = original.match(/(\d{3,})[\/-](\d{1,2})(?:\b|$)/);
    if (valueDateMatch) {
      const day = Number(valueDateMatch[2]);
      if (day >= 1 && day <= 31) {
        const now = new Date();
        const candidate = new Date(now.getFullYear(), now.getMonth(), day);
        candidate.setHours(0, 0, 0, 0);
        if (candidate < startOfDay(now)) {
          candidate.setMonth(candidate.getMonth() + 1, day);
        }
        data = candidate;
      }
    }
  }

  let descricao = original;
  if (amountInfo.raw) {
    const rawEscaped = escapeRegex(amountInfo.raw);
    descricao = descricao.replace(new RegExp(rawEscaped, "i"), "");
  }
  descricao = descricao
    .replace(/(hoje|amanh[ãa]|ontem)/gi, "")
    .replace(new RegExp(DATE_TOKEN_PATTERN, "gi"), "")
    .replace(/[-\/]\s*\d{1,2}(?:\b|$)/g, "")
    .replace(/\b(recebimento|receber|recebido|recebi|pagamento|pagar|pago|paguei|pendente|quitad[oa]|liquidad[oa]|entrada|receita)\b/gi, "")
    .replace(/\b(dia|data)\b/gi, "")
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
        buttons: [{ type: "reply", reply: { id: `REG:EDIT:${rowId}`, title: "✏ Editar" } }],
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

  const dateMatch = original.match(new RegExp(`(hoje|amanh[ãa]|ontem|${DATE_TOKEN_PATTERN})`, "i"));
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
  "mostrar_menu",
  "relatorios_menu",
  "relatorio_pagamentos_mes",
  "relatorio_recebimentos_mes",
  "relatorio_contas_pagar_mes",
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
  if (/^(abrir\s+)?menu$/.test(normalized.replace(/\s+/g, " ").trim())) return "mostrar_menu";
  if (/quanto eu gastei|quanto gastei|gastei esse mes|gastos? desse mes|gastos? do mes/.test(normalized)) {
    return "relatorio_pagamentos_mes";
  }
  if (/quanto eu recebi|quanto recebi|recebimentos? desse mes|recebimentos? do mes/.test(normalized)) {
    return "relatorio_recebimentos_mes";
  }
  if (/contas?\s+a\s+pagar.*mes|pendentes? desse mes|pendentes? do mes/.test(normalized)) {
    return "relatorio_contas_pagar_mes";
  }
  if (/\brelat[óo]rios?\b/.test(lower)) return "relatorios_menu";
  if (/\brelat[óo]rio\s+completo\b/.test(lower) || /\bcompleto\b/.test(lower)) return "relatorio_completo";
  if (/\blan[cç]amentos\b|extrato/.test(lower)) return "listar_lancamentos";
  if (/contas?\s+a\s+pagar|pendentes|a pagar/.test(lower)) return "listar_pendentes";
  if (/contas?\s+fixas?/.test(lower)) return "contas_fixas";
  if (/editar lan[cç]amentos?/.test(lower)) return "editar";
  if (/excluir lan[cç]amentos?/.test(lower)) return "excluir";
  if (/registrar recebimento|\brecebimento\b/.test(lower)) return "registrar_recebimento";
  if (/registrar pagamento|\bpagamento\b|\bpagar\b/.test(lower)) return "registrar_pagamento";
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
          text:
            `Opções válidas: ${options}.\n\n` +
            "Exemplos:\n" +
            '- "quanto eu gastei esse mês?" -> relatorio_pagamentos_mes\n' +
            '- "quanto recebi este mês?" -> relatorio_recebimentos_mes\n' +
            '- "contas a pagar deste mês" -> relatorio_contas_pagar_mes\n' +
            '- "pagar escola 12/11 2.000" -> registrar_pagamento\n' +
            '- "quero relatório completo" -> relatorio_completo\n' +
            '- "abrir menu" -> mostrar_menu\n\n' +
            `Mensagem: "${text}"\nResponda somente com uma das opções. Use "desconhecido" caso não tenha correspondência.`,
        },
      ],
    },
  ];
};

const detectIntent = async (text) => {
  const fallback = detectIntentHeuristic(text);
  if (!text) return fallback;
  if (!openaiClient) return fallback;
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
  recordUserInteraction(userNorm);
  if (type === "button_reply") {
    const id = payload.button_reply.id;
    const payloadId = payload.button_reply?.payload;
    const title = payload.button_reply?.title?.toLowerCase?.() || "";
    if (
      id === TEMPLATE_REMINDER_BUTTON_ID ||
      payloadId === TEMPLATE_REMINDER_BUTTON_ID ||
      title === "ver meus lembretes"
    ) {
      await listPendingPayments(from, userNorm);
      return;
    }
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
  console.log("📩 Inbound:", { fromRaw, userNorm });
  recordUserInteraction(userNorm);
  const trimmed = (text || "").trim();
  const normalizedMessage = normalizeDiacritics(trimmed).toLowerCase();
  const adminCronCommand =
    /\baviso\s*cron\b/i.test(normalizedMessage) ||
    /\bcron\s*(teste|agora)?\b/i.test(normalizedMessage);

  if (isAdminUser(userNorm)) {
    if (adminCronCommand) {
      console.log("🧪 Admin cron command received:", { fromRaw, normalizedMessage });
      await sendCronReminderForUser(userNorm, fromRaw, { bypassWindow: true });
      return;
    }
  }

  if (!userNorm || !isAdminUser(userNorm)) {
    const active = await isUsuarioAtivo(userNorm);
    if (!active) {
      const nome = getStoredFirstName(userNorm);
      const saudacaoNome = nome ? `Olá, ${nome}!` : "Olá!";
      await sendText(
        fromRaw,
        `${saudacaoNome} Eu sou a FinPlanner IA. Para usar os recursos, você precisa de um plano ativo. Conheça e contrate em: www.finplanneria.com.br`,
        { bypassWindow: true }
      );
      return;
    }
  }

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

  if (
    normalizedMessage === "ver meus lembretes" ||
    normalizedMessage === "meus lembretes" ||
    normalizedMessage.startsWith("ver meus lembretes")
  ) {
    await listPendingPayments(fromRaw, userNorm);
    return;
  }

  const intent = await detectIntent(trimmed);
  switch (intent) {
    case "boas_vindas":
      await sendWelcomeList(fromRaw);
      break;
    case "mostrar_menu":
      await sendMainMenu(fromRaw);
      break;
    case "relatorios_menu":
      await sendRelatoriosButtons(fromRaw);
      break;
    case "relatorio_pagamentos_mes": {
      const now = new Date();
      const range = {
        start: startOfMonth(now.getFullYear(), now.getMonth()),
        end: endOfMonth(now.getFullYear(), now.getMonth()),
      };
      await showReportByCategory(fromRaw, userNorm, "pag", range);
      break;
    }
    case "relatorio_recebimentos_mes": {
      const now = new Date();
      const range = {
        start: startOfMonth(now.getFullYear(), now.getMonth()),
        end: endOfMonth(now.getFullYear(), now.getMonth()),
      };
      await showReportByCategory(fromRaw, userNorm, "rec", range);
      break;
    }
    case "relatorio_contas_pagar_mes": {
      const now = new Date();
      const range = {
        start: startOfMonth(now.getFullYear(), now.getMonth()),
        end: endOfMonth(now.getFullYear(), now.getMonth()),
      };
      await showReportByCategory(fromRaw, userNorm, "cp", range);
      break;
    }
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
  if (!sig) {
    console.error("stripe-signature ausente");
    res.sendStatus(400);
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    console.error("Webhook Stripe sem raw Buffer — verifique se a rota está antes do express.json()");
    res.sendStatus(400);
    return;
  }
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("⚠️ Stripe raw body inválido:", {
      isBuffer: Buffer.isBuffer(req.body),
      contentType: req.headers["content-type"],
      error: err.message,
    });
    res.status(400).send(`Webhook error: ${err.message}`);
    return;
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const subMeta = await getSubscriptionMetadata(stripe, session.subscription);
      const planoRaw = pickFirst(session.metadata?.plano, subMeta?.plano);
      let plano = normalizePlan(planoRaw);
      let priceId = "";

      if (!plano) {
        try {
          const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
          priceId = lineItems?.data?.[0]?.price?.id || "";
          console.log("🔎 Stripe line items:", { sessionId: session.id, priceId });
          if (priceId) {
            if (priceId === STRIPE_PRICE_MENSAL) plano = "mensal";
            else if (priceId === STRIPE_PRICE_TRIMESTRAL) plano = "trimestral";
            else if (priceId === STRIPE_PRICE_ANUAL) plano = "anual";
          }
          if (plano) {
            console.log("✅ Plano resolvido via priceId:", { plano, priceId });
          }
        } catch (error) {
          console.error("Erro ao buscar line items do Stripe:", error.message);
        }
      }

      if (!plano) {
        console.log("⚠️ Evento Stripe sem plano válido. planoRaw =", planoRaw, "priceId =", priceId);
        return res.sendStatus(200);
      }

      const whatsapp = session.metadata?.whatsapp;
      if (!whatsapp) {
        console.log("⚠️ Evento Stripe sem whatsapp metadata.");
        return res.sendStatus(200);
      }

      const userNorm = normalizeUser(whatsapp);
      if (!userNorm) {
        return res.sendStatus(200);
      }

      const nome = session.customer_details?.name || session.customer_name || session.metadata?.nome || "";
      const email = session.customer_details?.email || session.customer_email || session.metadata?.email || "";
      console.log("🧾 Upsert usuario:", { userNorm, plano, ativo: true });
      await upsertUsuarioFromSubscription({
        userNorm,
        nome,
        plano,
        email,
        checkout_id: session.id || session.subscription || session.payment_intent || "",
        data_inicio: formatISODate(new Date()),
        ativo: true,
        extendVencimento: true,
      });
    }

    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const subMeta = await getSubscriptionMetadata(stripe, invoice.subscription);
      const planoRaw = pickFirst(subMeta?.plano);
      const plano = normalizePlan(planoRaw);

      if (!plano) {
        console.log("⚠️ Evento Stripe sem plano válido. planoRaw =", planoRaw);
        return res.sendStatus(200);
      }

      const whatsapp = subMeta?.whatsapp;
      if (!whatsapp) {
        console.log("⚠️ Evento Stripe sem whatsapp metadata.");
        return res.sendStatus(200);
      }

      const userNorm = normalizeUser(whatsapp);
      if (!userNorm) {
        return res.sendStatus(200);
      }

      console.log("🧾 Upsert usuario:", { userNorm, plano, ativo: true });
      await upsertUsuarioFromSubscription({
        userNorm,
        plano,
        ativo: true,
        extendVencimento: true,
      });
    }

    if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
      const payload = event.data.object || {};
      const subMeta = await getSubscriptionMetadata(stripe, payload.subscription);
      const whatsapp = pickFirst(payload.metadata?.whatsapp, subMeta?.whatsapp);
      if (!whatsapp) {
        console.log("⚠️ Evento Stripe sem whatsapp metadata.");
        return res.sendStatus(200);
      }
      const userNorm = normalizeUser(whatsapp);
      if (!userNorm) {
        return res.sendStatus(200);
      }
      console.log("🧾 Upsert usuario:", { userNorm, plano: null, ativo: false });
      await upsertUsuarioFromSubscription({
        userNorm,
        ativo: false,
        extendVencimento: false,
      });
    }
  } catch (error) {
    console.error("Erro ao processar evento Stripe:", error.message);
  }

  res.sendStatus(200);
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
          const contacts = value.contacts || [];

          for (const contact of contacts) {
            const waId = normalizeUser(contact.wa_id || contact.waId || contact.id || contact.input);
            const displayName =
              contact.profile?.name || contact.profile?.pushname || contact.profile?.display_name || contact.profile?.first_name;
            if (waId) rememberUserName(waId, displayName);
          }

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
            const fromNorm = normalizeUser(from);
            const profileName =
              message.profile?.name || message.profile?.pushname || message.profile?.display_name || message.profile?.first_name;
            if (fromNorm) rememberUserName(fromNorm, profileName);
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

async function runAvisoCron({ requestedBy = "cron", dryRun = false } = {}) {
  console.log(`[CRON] runAvisoCron start requestedBy=${requestedBy} at ${new Date().toISOString()}`);
  const reasons = {
    invalid_date: 0,
    future_due: 0,
    invalid_user: 0,
    inactive_plan: 0,
    no_items: 0,
    sent_ok: 0,
    sent_text_ok: 0,
    sent_template_ok: 0,
    send_error: 0,
  };
  let totalItems = 0;
  let sentCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const dueByUser = new Map();

  try {
    const sheet = await ensureSheet();
    const rows = await withRetry(() => sheet.getRows(), "get-finplanner-cron");
    const today = startOfDay(new Date());
    const todayMs = today.getTime();

    const enqueueReminder = (row, kind) => {
      const dueIso = getVal(row, "vencimento_iso");
      const dueBr = getVal(row, "vencimento_br");
      const dueDate = dueIso ? new Date(dueIso) : parseDateToken(dueBr);
      if (!dueDate || Number.isNaN(dueDate.getTime())) {
        console.log("⚠️ Cron skip (data inválida):", {
          user: getVal(row, "user") || getVal(row, "user_raw"),
          tipo: getVal(row, "tipo"),
          vencimento_iso: dueIso,
          vencimento_br: dueBr,
        });
        reasons.invalid_date += 1;
        skippedCount += 1;
        return;
      }
      const dueMs = startOfDay(dueDate).getTime();
      if (dueMs > todayMs) {
        console.log("ℹ️ Cron skip (vencimento futuro):", {
          user: getVal(row, "user") || getVal(row, "user_raw"),
          tipo: getVal(row, "tipo"),
          vencimento_iso: dueIso,
          vencimento_br: dueBr,
        });
        reasons.future_due += 1;
        skippedCount += 1;
        return;
      }
      const toRaw = getVal(row, "user_raw") || getVal(row, "user");
      const userNorm = normalizeUser(getVal(row, "user") || getVal(row, "user_raw"));
      if (!toRaw || !userNorm) {
        console.log("⚠️ Cron skip (usuário inválido):", {
          user: getVal(row, "user") || getVal(row, "user_raw"),
          tipo: getVal(row, "tipo"),
        });
        reasons.invalid_user += 1;
        skippedCount += 1;
        return;
      }
      const bucket = dueByUser.get(userNorm) || { to: toRaw, items: [] };
      if (!bucket.to) bucket.to = toRaw;
      bucket.items.push({ row, kind, dueMs });
      dueByUser.set(userNorm, bucket);
    };

    for (const row of rows) {
      const tipo = (getVal(row, "tipo") || "").toString().toLowerCase();
      const status = (getVal(row, "status") || "").toString().toLowerCase();
      if (tipo === "conta_pagar" && status !== "pago") enqueueReminder(row, "pagar");
      if (tipo === "conta_receber" && !["pago", "recebido"].includes(status)) enqueueReminder(row, "receber");
    }

    for (const bucket of dueByUser.values()) {
      totalItems += bucket.items.length;
    }

    if (!dueByUser.size) {
      console.log("ℹ️ Cron: nenhum lançamento pendente para hoje ou vencido.");
    }

    for (const [userNorm, bucket] of dueByUser.entries()) {
      const { to, items } = bucket;
      if (!items.length || !to) {
        reasons.no_items += 1;
        skippedCount += 1;
        continue;
      }
      const ativo = await isUsuarioAtivo(userNorm);
      if (!ativo) {
        console.log("⛔ Cron skip (plano inativo):", { userNorm, to, itens: items.length });
        reasons.inactive_plan += 1;
        skippedCount += 1;
        continue;
      }

      const pagar = items
        .filter((item) => item.kind === "pagar")
        .sort((a, b) => a.dueMs - b.dueMs);
      const receber = items
        .filter((item) => item.kind === "receber")
        .sort((a, b) => a.dueMs - b.dueMs);

      const sections = [];
      let counter = 1;

      if (pagar.length) {
        const blocks = pagar.map((item) => {
          const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
          const dueLabel = dueRaw || "—";
          const label = item.dueMs < todayMs ? `${dueLabel} (atrasado)` : dueLabel;
          return formatEntryBlock(item.row, { index: counter++, dateText: label });
        });
        sections.push(`💸 *Pagamentos pendentes*\n\n${blocks.join("\n\n")}`);
      }

      if (receber.length) {
        const blocks = receber.map((item) => {
          const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
          const dueLabel = dueRaw || "—";
          const label = item.dueMs < todayMs ? `${dueLabel} (atrasado)` : dueLabel;
          return formatEntryBlock(item.row, { index: counter++, dateText: label });
        });
        sections.push(`💵 *Recebimentos pendentes*\n\n${blocks.join("\n\n")}`);
      }

      if (!sections.length) {
        skippedCount += 1;
        continue;
      }

      const message = `⚠️ *Lembrete FinPlanner IA*\n\n${sections.join("\n\n")}`;
      const withinWindow = hasRecentUserInteraction(userNorm);
      console.log("⏰ Cron send attempt:", {
        userNorm,
        to,
        total: items.length,
        pagar: pagar.length,
        receber: receber.length,
        withinWindow,
      });
      let delivered = false;
      let threw = false;
      let usedTemplate = false;
      try {
        if (withinWindow) {
          const result = await sendText(to, message, { withinWindow });
          delivered = result?.ok === true;
          if (delivered) {
            sentCount += 1;
            reasons.sent_ok += 1;
            reasons.sent_text_ok += 1;
          }
        } else {
          usedTemplate = true;
          delivered = await sendTemplateReminder(to, userNorm, getStoredFirstName(userNorm));
          if (delivered) {
            sentCount += 1;
            reasons.sent_ok += 1;
            reasons.sent_template_ok += 1;
          }
        }
      } catch (error) {
        threw = true;
        errorCount += 1;
        reasons.send_error += 1;
        console.error("Erro no envio do CRON:", error.message);
      }
      if (!delivered) {
        console.log("⚠️ Cron delivery failed:", { userNorm, to, delivered, withinWindow, usedTemplate });
        if (!threw) {
          errorCount += 1;
          reasons.send_error += 1;
        }
        skippedCount += 1;
        continue;
      }
      console.log("✅ Cron delivery ok:", { userNorm, to, via: usedTemplate ? "template" : "text" });

      for (const item of items) {
        const paymentType = (getVal(item.row, "tipo_pagamento") || "").toString().toLowerCase();
        const code = getVal(item.row, "codigo_pagamento");
        if (!code) continue;
        if (paymentType === "pix") await sendCopyButton(to, "💳 Chave Pix:", code, "Copiar Pix");
        if (paymentType === "boleto") await sendCopyButton(to, "🧾 Código de barras:", code, "Copiar boleto");
      }
    }
  } catch (error) {
    errorCount += 1;
    console.error("Erro no CRON:", error.message);
  }

  const resumo = {
    users: dueByUser.size,
    reminders: totalItems,
    sent: sentCount,
    skipped: skippedCount,
    errors: errorCount,
    reasons,
  };
  console.log("[CRON] runAvisoCron done", resumo);
  return resumo;
}

// ============================
// Server
// ============================
const port = PORT || 10000;
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const isCronMode = process.argv.includes("--cron-aviso");
if (isCronMode) {
  (async () => {
    console.log(`[CRON] cron-aviso start at ${new Date().toISOString()}`);
    console.log("[CRON] env check", {
      hasGoogleEmail: !!GOOGLE_SERVICE_ACCOUNT_EMAIL,
      hasGoogleKey: !!GOOGLE_SERVICE_ACCOUNT_KEY,
    });
    try {
      await runAvisoCron({ requestedBy: "linux-cron" });
      console.log(`[CRON] cron-aviso done at ${new Date().toISOString()}`);
      process.exit(0);
    } catch (error) {
      console.error("[CRON] cron-aviso error:", error);
      process.exit(1);
    }
  })();
} else if (isMain) {
  app.listen(port, () => {
    console.log(`FinPlanner IA (2025-10-23) rodando na porta ${port}`);
    migrateUserSheets();
  });
}

export {
  ensureSheet,
  withRetry,
  startOfDay,
  parseDateToken,
  getVal,
  normalizeUser,
  isUsuarioAtivo,
  formatBRDate,
  formatEntryBlock,
  hasRecentUserInteraction,
  sendText,
  sendTemplateReminder,
  getStoredFirstName,
  sendCopyButton,
};
