// ============================
// FinPlanner IA - WhatsApp Bot
// Versão: app.js v2025-01-23 PRODUCTION-READY
// ============================
// 🔧 MELHORIAS APLICADAS NESTA VERSÃO:
// 
// 🐛 CORREÇÕES DE BUGS:
// ✅ Corrigido caminho hardcoded do .env - agora funciona em qualquer ambiente
// ✅ Removida duplicação em WA_ACCESS_TOKEN 
// ✅ Corrigido tratamento de exceção em callOpenAI
// 
// 🔒 SEGURANÇA:
// ✅ Timeout adicionado em requisições HTTP (10s)
// ✅ Rate limiting implementado (proteção DDoS)
// ✅ Helmet.js para headers de segurança
// ✅ Validação de webhook Stripe com assinatura
// ✅ Validação de variáveis obrigatórias
// ✅ Tokens sanitizados em logs
// 
// ⚡ PERFORMANCE:
// ✅ Cache do Google Sheets (5 minutos TTL)
// ✅ Compressão HTTP (gzip)
// ✅ Otimização de requisições
// 
// 📊 MONITORAMENTO:
// ✅ Logging estruturado com Winston
// ✅ Health check completo (/health)
// ✅ Métricas de uso e memória
// ✅ Logs separados por nível (error/combined)
// 
// ⚠️  FUNCIONALIDADE 100% PRESERVADA - Pronto para produção!
// ============================


import dotenv from "dotenv";
import express from "express";
import Stripe from "stripe";
import OpenAI from "openai";
import axios from "axios";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import path from "path";
import { fileURLToPath } from "url";
// ✅ NOVAS DEPENDÊNCIAS - Segurança, Performance e Monitoramento
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import winston from "winston";
import fs from "fs";
import cron from "node-cron";

// ✅ FIX: Caminho automático do .env (funciona em qualquer ambiente)
dotenv.config();

// ============================
// LOGGING ESTRUTURADO (Winston)
// ============================
// Cria diretório de logs se não existir
if (!fs.existsSync("logs")) {
  fs.mkdirSync("logs");
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: "logs/error.log", 
      level: "error",
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: "logs/combined.log",
      maxsize: 5242880,
      maxFiles: 5
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Substitui console.log/error por logger (mantém compatibilidade)
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

console.log = (...args) => {
  logger.info(args.join(" "));
  if (process.env.NODE_ENV !== "production") originalConsoleLog(...args);
};

console.error = (...args) => {
  logger.error(args.join(" "));
  if (process.env.NODE_ENV !== "production") originalConsoleError(...args);
};

console.warn = (...args) => {
  logger.warn(args.join(" "));
  if (process.env.NODE_ENV !== "production") originalConsoleWarn(...args);
};

// ============================
// VALIDAÇÃO DE VARIÁVEIS OBRIGATÓRIAS
// ============================
function validateRequiredEnv() {
  const required = [
    { key: "WA_ACCESS_TOKEN", value: WA_ACCESS_TOKEN },
    { key: "WA_PHONE_NUMBER_ID", value: WA_PHONE_NUMBER_ID },
    { key: "SHEETS_ID", value: SHEETS_ID },
    { key: "GOOGLE_SERVICE_ACCOUNT_EMAIL", value: GOOGLE_SERVICE_ACCOUNT_EMAIL },
    { key: "GOOGLE_SERVICE_ACCOUNT_KEY", value: GOOGLE_SERVICE_ACCOUNT_KEY }
  ];

  const missing = required.filter(item => !item.value);

  if (missing.length > 0) {
    logger.error("❌ Variáveis obrigatórias faltando:", {
      missing: missing.map(m => m.key)
    });
    console.error("\n⚠️  Configure as variáveis no arquivo .env antes de continuar!");
    console.error("Missing:", missing.map(m => m.key).join(", "));
    return false;
  }

  logger.info("✅ Todas as variáveis obrigatórias configuradas");
  return true;
}

process.on("unhandledRejection", (err) => {
  console.error("[FATAL] unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
});

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
  WA_PHONE_NUMBER_ID,
  ADMIN_WA_NUMBER,
  STRIPE_WEBHOOK_SECRET,
} = process.env;

const WA_ACCESS_TOKEN = String(
  process.env.WA_ACCESS_TOKEN ||
    process.env.WHATSAPP_ACCESS_TOKEN ||
    process.env.ACCESS_TOKEN ||
    ""
).trim();

const WEBHOOK_VERIFY_TOKEN = String(
  process.env.WA_VERIFY_TOKEN ||
    process.env.WEBHOOK_VERIFY_TOKEN ||
    process.env.WHATSAPP_VERIFY_TOKEN ||
    process.env.VERIFY_TOKEN ||
    ""
).trim();

const USE_OPENAI = (USE_OPENAI_RAW || "false").toLowerCase() === "true";
const DEBUG_SHEETS = (DEBUG_SHEETS_RAW || "false").toLowerCase() === "true";
const SKIP_TEMPLATE_REMINDER = (process.env.SKIP_TEMPLATE_REMINDER || "false").toLowerCase() === "true";
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

const adaptInputForResponses = (input) => {
  if (!Array.isArray(input)) return input;
  return input.map((msg) => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    const isAssistant = msg.role === "assistant";
    const mappedContent = msg.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "text") {
        return { ...part, type: isAssistant ? "output_text" : "input_text" };
      }
      if (part.type === "image_url" || part.type === "image") {
        return { ...part, type: "input_image" };
      }
      return part;
    });
    return { ...msg, content: mappedContent };
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
        input: adaptInputForResponses(input),
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
    console.error("[OpenAI] Erro na chamada da API:", error.message);
    return null;
  }
};

// ============================
// Google Auth fix (supports literal \n)
// ============================
let GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}

// Valida na inicialização
validateRequiredEnv();

// ============================
// APP
// ============================
// ============================
// CACHE DO GOOGLE SHEETS
// ============================
const sheetsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getCachedSheet(key) {
  const cached = sheetsCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.info("[Cache] Usando dados em cache", { key });
    return cached.data;
  }
  return null;
}

function setCachedSheet(key, data) {
  sheetsCache.set(key, {
    data,
    timestamp: Date.now()
  });
  logger.info("[Cache] Dados armazenados em cache", { key });
}

// Limpa cache expirado a cada 10 minutos
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of sheetsCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      sheetsCache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.info("[Cache] Limpeza automática", { removed: cleaned });
  }
}, 10 * 60 * 1000);
const app = express();

// ✅ Confiar em 1 proxy reverso (Nginx) - mais seguro que 'true' para rate limiting correto
// Valor '1' indica que há exatamente 1 proxy (Nginx) entre o cliente e o app
app.set('trust proxy', 1);

// ============================
// SEGURANÇA E PERFORMANCE
// ============================

// ✅ Helmet.js - Headers de segurança HTTP
app.use(helmet({
  contentSecurityPolicy: false, // Desabilitado para compatibilidade com APIs
  crossOriginEmbedderPolicy: false
}));

// ✅ Compressão gzip para reduzir tamanho das respostas
app.use(compression());

// ✅ Rate Limiting - Proteção contra DDoS e abuso
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Máximo 100 requisições por IP
  message: {
    error: "Muitas requisições. Tente novamente em 15 minutos.",
    retryAfter: "15 minutos"
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("[Rate Limit] Limite excedido", { 
      ip: req.ip,
      path: req.path 
    });
    res.status(429).json({
      error: "Muitas requisições. Tente novamente em 15 minutos."
    });
  }
});

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 30, // Máximo 30 webhooks por minuto
  message: "Webhook rate limit excedido",
  skipSuccessfulRequests: false
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 10, // Máximo 10 tentativas de checkout por hora
  message: "Muitas tentativas de checkout. Aguarde 1 hora."
});

// Aplica rate limiting (exceto em caminhos específicos)
app.use((req, res, next) => {
  // Pula rate limit para health check, wake e Stripe webhook (evitar bloquear retries do Stripe)
  if (req.path === "/health" || req.path === "/internal/wake" || req.path === "/webhook/stripe") {
    return next();
  }
  return generalLimiter(req, res, next);
});

logger.info("✅ Segurança configurada: Helmet + Rate Limiting + Compression");

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
    const onboardingResumo = await runOnboardingCron({ requestedBy: "cron-job" });
    const reengagementResumo = await runReengagementCron({ requestedBy: "cron-job" });
    return res.status(200).json({ ok: true, resumo, onboardingResumo, reengagementResumo });
  } catch (e) {
    console.error("[CRON] endpoint error:", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.get("/", (_req, res) => {
  res.send("FinPlanner IA ativo! 🚀");
});

// ============================
// HEALTH CHECK COMPLETO
// ============================
app.get("/health", async (req, res) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  
  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: {
      seconds: Math.floor(uptime),
      formatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`
    },
    memory: {
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
      external: `${Math.round(memoryUsage.external / 1024 / 1024)}MB`
    },
    services: {
      whatsapp: {
        configured: !!WA_ACCESS_TOKEN && !!WA_PHONE_NUMBER_ID,
        hasToken: !!WA_ACCESS_TOKEN,
        hasPhoneId: !!WA_PHONE_NUMBER_ID
      },
      googleSheets: {
        configured: !!GOOGLE_SERVICE_ACCOUNT_EMAIL && !!GOOGLE_SERVICE_ACCOUNT_KEY,
        sheetId: !!SHEETS_ID
      },
      stripe: {
        configured: !!STRIPE_SECRET_KEY,
        webhookSecret: !!STRIPE_WEBHOOK_SECRET,
        pricesConfigured: !!(STRIPE_PRICE_MENSAL && STRIPE_PRICE_TRIMESTRAL && STRIPE_PRICE_ANUAL)
      },
      openai: {
        configured: !!OPENAI_API_KEY,
        enabled: USE_OPENAI,
        model: OPENAI_INTENT_MODEL
      }
    },
    cache: {
      entries: sheetsCache.size,
      ttl: `${CACHE_TTL / 1000 / 60} minutos`
    },
    environment: {
      nodeEnv: process.env.NODE_ENV || "development",
      nodeVersion: process.version,
      platform: process.platform
    }
  };
  
  // Verifica se todos os serviços críticos estão configurados
  const criticalServices = [
    health.services.whatsapp.configured,
    health.services.googleSheets.configured
  ];
  
  const allHealthy = criticalServices.every(service => service === true);
  
  if (!allHealthy) {
    health.status = "degraded";
    logger.warn("[Health] Sistema com serviços não configurados", health);
  }
  
  const statusCode = allHealthy ? 200 : 503;
  res.status(statusCode).json(health);
  
  logger.info("[Health] Health check realizado", { 
    status: health.status,
    ip: req.ip 
  });
});

app.post("/checkout", checkoutLimiter, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: "Stripe não configurado." });
  }
  const { plano, whatsapp, nome, email } = req.body || {};
  if (!whatsapp) {
    return res.status(400).json({ error: "whatsapp obrigatório." });
  }
  const whatsappNorm = normalizeWhatsAppNumber(String(whatsapp));
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
          whatsapp: whatsappNorm,
          plano: planoNorm,
          nome: String(nome || ""),
          email: String(email || ""),
        },
      },
      metadata: {
        whatsapp: whatsappNorm,
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

const normalizeWhatsAppNumber = (num) => {
  const digits = (num || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("55") && digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) return "55" + digits;
  return digits;
};

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
const onboardingNotice = new Map();
const shouldSendOnboarding = (userNorm, day) => {
  if (!userNorm || !day) return false;
  const today = new Date().toISOString().split("T")[0];
  const key = `${userNorm}:day${day}`;
  if (onboardingNotice.get(key) === today) return false;
  onboardingNotice.set(key, today);
  return true;
};
const WA_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const usuarioStatusCache = new Map();
const USUARIO_CACHE_TTL_MS = 60 * 1000;
const USUARIO_ROW_CACHE_TTL_MS = 60 * 1000;
const usuarioRowCache = new Map();

function getCanonicalUserId(value) {
  const norm = normalizeUser(value);
  if (!norm) return "";
  const digits = String(norm);
  if (digits.startsWith("55") && digits.length === 12) {
    return digits.slice(0, 4) + "9" + digits.slice(4);
  }
  return digits;
}

function getUserCandidates(userNorm) {
  const candidates = new Set();
  if (userNorm) candidates.add(userNorm);
  const digits = String(userNorm || "").replace(/\D/g, "");
  // BR mobile with country code + "9": "5511999999999" (13 digits)
  if (digits.startsWith("55") && digits.length === 13 && digits[4] === "9") {
    candidates.add(digits.slice(0, 4) + digits.slice(5)); // without "9": 551199999999
    candidates.add(digits.slice(2));                       // without country code: 11999999999
    candidates.add(digits.slice(2, 4) + digits.slice(5));  // without country code and without "9": 1199999999
  }
  // BR with country code without "9": "551199999999" (12 digits)
  if (digits.startsWith("55") && digits.length === 12) {
    candidates.add(digits.slice(0, 4) + "9" + digits.slice(4)); // with "9": 5511999999999
    candidates.add(digits.slice(2));                             // without country code: 1199999999
    candidates.add(digits.slice(2, 4) + "9" + digits.slice(4));  // without country code + with "9": 11999999999
  }
  // BR mobile without country code, with "9": "11999999999" (11 digits, 3rd digit is "9")
  if (!digits.startsWith("55") && digits.length === 11 && digits[2] === "9") {
    candidates.add("55" + digits);                                // +country code: 5511999999999
    candidates.add("55" + digits.slice(0, 2) + digits.slice(3));  // +country code, -"9": 551199999999
    candidates.add(digits.slice(0, 2) + digits.slice(3));         // -"9": 1199999999
  }
  // BR without country code, 10 digits (landline or mobile without "9"): "1199999999"
  if (!digits.startsWith("55") && digits.length === 10) {
    candidates.add("55" + digits);                                   // +country code: 551199999999
    candidates.add("55" + digits.slice(0, 2) + "9" + digits.slice(2)); // +country code +"9": 5511999999999
    candidates.add(digits.slice(0, 2) + "9" + digits.slice(2));      // +"9": 11999999999
  }
  // Número sem prefixo 55 → adicionar com prefixo
  if (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) {
    const with55 = "55" + digits;
    candidates.add(with55);
    if (with55.length === 13 && with55[4] === "9") {
      candidates.add(with55.slice(0, 4) + with55.slice(5));
    }
    if (with55.length === 12) {
      candidates.add(with55.slice(0, 4) + "9" + with55.slice(4));
    }
  }
  // Número com prefixo 55 → adicionar sem prefixo
  if (digits.startsWith("55") && digits.length >= 12) {
    candidates.add(digits.slice(2));
  }
  return Array.from(candidates);
}

const recordUserInteraction = (userNorm) => {
  const canonical = getCanonicalUserId(userNorm);
  if (!canonical) return;
  const now = Date.now();
  lastInboundInteraction.set(canonical, now);
  const candidates = getUserCandidates(canonical);
  for (const candidate of candidates) {
    lastInboundInteraction.set(candidate, now);
  }
};

function getLastInteractionInfo(userNorm) {
  const canonical = getCanonicalUserId(userNorm);
  if (!canonical) return { canonicalUserId: "", lastMs: null, lastIso: "" };
  const candidates = getUserCandidates(canonical);
  let lastMs = null;
  for (const candidate of candidates) {
    const stored = lastInboundInteraction.get(candidate);
    if (typeof stored === "number" && (lastMs === null || stored > lastMs)) {
      lastMs = stored;
    }
  }
  return {
    canonicalUserId: canonical,
    lastMs,
    lastIso: typeof lastMs === "number" ? new Date(lastMs).toISOString() : "",
  };
}

const setLastInteractionForTest = (userNorm, timestampMs) => {
  const canonical = getCanonicalUserId(userNorm);
  if (!canonical || typeof timestampMs !== "number") return;
  lastInboundInteraction.set(canonical, timestampMs);
  const candidates = getUserCandidates(canonical);
  for (const candidate of candidates) {
    lastInboundInteraction.set(candidate, timestampMs);
  }
};

function hasRecentUserInteraction(userNorm) {
  const info = getLastInteractionInfo(userNorm);
  if (!info.lastMs) return false;
  return Date.now() - info.lastMs <= WA_SESSION_WINDOW_MS;
}

const persistLastInteraction = async (userNorm) => {
  const canonical = getCanonicalUserId(userNorm);
  if (!canonical) return;
  try {
    const sheet = await ensureSheetUsuarios();
    const cacheKey = canonical;
    const cached = usuarioRowCache.get(cacheKey);
    let rows;
    let rowMap;
    if (cached && cached.expiresAt > Date.now()) {
      rows = cached.rows;
      rowMap = cached.rowMap;
    } else {
      rows = await withRetry(() => sheet.getRows(), "get-usuarios-last-interaction");
      rowMap = new Map();
      rows.forEach((row) => {
        const key = normalizeUser(getVal(row, "user"));
        if (key) rowMap.set(key, row);
      });
      usuarioRowCache.set(cacheKey, { rows, rowMap, expiresAt: Date.now() + USUARIO_ROW_CACHE_TTL_MS });
    }
    const candidates = getUserCandidates(canonical);
    const target =
      rowMap?.get(canonical) ||
      candidates.map((candidate) => rowMap?.get(candidate)).find(Boolean) ||
      rows.find((row) => normalizeUser(getVal(row, "user")) === canonical) ||
      rows.find((row) => candidates.includes(normalizeUser(getVal(row, "user"))));
    const nowIso = new Date().toISOString();
    if (target) {
      // Restaura cache in-memory a partir do sheet (corrige estado pós-restart)
      if (!lastInboundInteraction.has(canonical)) {
        const storedIso = getVal(target, "last_interaction");
        const storedMs = storedIso ? new Date(storedIso).getTime() : 0;
        if (storedMs && !isNaN(storedMs)) {
          lastInboundInteraction.set(canonical, storedMs);
          getUserCandidates(canonical).forEach((c) => lastInboundInteraction.set(c, storedMs));
        }
      }
      setVal(target, "last_interaction", nowIso);
      await target.save();
    } else {
      const newRow = await sheet.addRow({ user: canonical, last_interaction: nowIso });
      rows.push(newRow);
      rowMap?.set(canonical, newRow);
    }
    console.log("[INBOUND] last_interaction saved", {
      canonicalUserId: canonical,
      matchedUser: target ? getVal(target, "user") : canonical,
      iso: nowIso,
    });
  } catch (err) {
    console.error("[INBOUND] last_interaction save failed", {
      canonicalUserId: canonical,
      err: String(err?.message || err),
    });
  }
};

const loadLastInteractionFromUsuarios = async () => {
  const sheet = await ensureSheetUsuarios();
  const rows = await withRetry(() => sheet.getRows(), "get-usuarios-last-interaction");
  const map = new Map();
  let validCount = 0;
  let invalidCount = 0;
  for (const row of rows) {
    const rawUser = normalizeUser(getVal(row, "user"));
    const canonical = getCanonicalUserId(rawUser);
    if (!canonical) {
      invalidCount++;
      continue;
    }
    const lastIso = getVal(row, "last_interaction");
    const lastDate = lastIso ? new Date(lastIso) : null;
    if (!lastDate || Number.isNaN(lastDate.getTime())) {
      console.log("[CRON] Skipping user with invalid last_interaction:", {
        user: rawUser,
        last_interaction: lastIso,
      });
      invalidCount++;
      continue;
    }
    const lastMs = lastDate.getTime();
    const candidates = getUserCandidates(canonical);
    for (const candidate of candidates) {
      const prev = map.get(candidate);
      if (!prev || lastMs > prev) map.set(candidate, lastMs);
    }
    validCount++;
  }
  console.log("[CRON] Loaded last interactions from usuarios sheet:", {
    totalRows: rows.length,
    validUsers: validCount,
    invalidUsers: invalidCount,
    mapSize: map.size,
  });
  return map;
};

const getLastInteractionFromMap = (userNorm, map) => {
  const canonical = getCanonicalUserId(userNorm);
  if (!canonical) return { canonicalUserId: "", lastMs: null, lastIso: "" };
  const candidates = getUserCandidates(canonical);
  let lastMs = null;
  for (const candidate of candidates) {
    const stored = map.get(candidate);
    if (typeof stored === "number" && (lastMs === null || stored > lastMs)) {
      lastMs = stored;
    }
  }
  return {
    canonicalUserId: canonical,
    lastMs,
    lastIso: typeof lastMs === "number" ? new Date(lastMs).toISOString() : "",
  };
};

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
  "(?:\\bR\\$?\\s*)?(?:\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)(?!\\s*[\\/-]\\d)";

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
    const dotCount = (token.match(/\./g) || []).length;
    if (dotCount > 1) {
      // "3.197.78" → múltiplos pontos: todos menos o último são separadores de milhar
      const parts = token.split(".");
      const intPart = parts.slice(0, -1).join("");
      const decPart = parts[parts.length - 1];
      // Se a última parte tem 3 dígitos, também é milhar (ex: "1.000.000")
      token = decPart.length <= 2 ? `${intPart}.${decPart}` : intPart + decPart;
    } else {
      const lastDot = token.lastIndexOf(".");
      const decimals = token.length - lastDot - 1;
      if (decimals === 3 && token.replace(/[^0-9]/g, "").length > 3) {
        token = token.replace(/\./g, "");
      }
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
  const lower = token.toLowerCase().trim();

  // Palavras especiais
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

  // "daqui a x dias" ou "daqui x dias"
  const daquiMatch = lower.match(/daqui\s+a?\s*(\d+)\s*dias?/);
  if (daquiMatch) {
    const days = Number(daquiMatch[1]);
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d;
  }

  // Formato: dd/mm/yyyy, dd/mm/yy, dd/mm, dd ou d
  // Também aceita - no lugar de /
  const dateMatch = token.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})|(\d{1,2})[\/-](\d{1,2})|(\d{1,2})(?![\/-])/);

  if (dateMatch) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    // Formato completo: dd/mm/yyyy ou dd/mm/yy
    if (dateMatch[1] && dateMatch[2] && dateMatch[3]) {
      const day = Number(dateMatch[1]);
      const month = Number(dateMatch[2]) - 1;
      let year = Number(dateMatch[3]);

      // Se ano tem 2 dígitos, adiciona 20xx
      if (year < 100) year += 2000;

      const d = new Date(year, month, day);
      if (!Number.isNaN(d.getTime()) && day >= 1 && day <= 31 && month >= 0 && month <= 11) {
        return d;
      }
    }

    // Formato: dd/mm (sem ano - usa ano atual ou próximo)
    if (dateMatch[4] && dateMatch[5]) {
      const day = Number(dateMatch[4]);
      const month = Number(dateMatch[5]) - 1;

      if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
        const d = new Date(currentYear, month, day);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }

    // Formato: apenas dd (usa mês e ano atuais ou próximo mês)
    if (dateMatch[6] && !dateMatch[4] && !dateMatch[1]) {
      const day = Number(dateMatch[6]);

      if (day >= 1 && day <= 31) {
        let month = currentMonth;
        let year = currentYear;
        const tentative = new Date(year, month, day);

        // Se a data já passou este mês, usa próximo mês
        if (tentative < startOfDay(now)) {
          month += 1;
          if (month > 11) {
            month = 0;
            year += 1;
          }
        }

        const d = new Date(year, month, day);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
  }

  return null;
};

const CATEGORY_DEFINITIONS = [
  {
    slug: "mercado",
    label: "Mercado / Supermercado",
    emoji: "🛒",
    description: "Compras de supermercado, feira, açougue e itens de despensa para casa.",
    keywords: [
      "mercado",
      "supermercado",
      "hortifruti",
      "hortifruit",
      "atacado",
      "atacadista",
      "atacadao",
      "sacolao",
      "mercearia",
      "açougue",
      "acougue",
      "feira",
      "quitanda",
      "empório",
      "emporio",
      "armazém",
      "armazem",
      "compras do mes",
      "compras da semana",
      "cesta basica",
      "rancho",
      "assai",
      "assaí",
      "makro",
      "sam's",
      "sams",
      "costco",
      "carrefour",
      "extra",
      "pao de acucar",
      "big bompreço",
      "big bompeco",
    ],
    aliases: ["supermercado", "mercado_supermercado"],
  },
  {
    slug: "alimentacao",
    label: "Alimentação",
    emoji: "🍽️",
    description: "Refeições prontas, lanches, fast food e alimentação fora de casa.",
    keywords: [
      "restaurante",
      "lanche",
      "lanchonete",
      "ifood",
      "almoço",
      "almoco",
      "jantar",
      "café da manhã",
      "cafe da manha",
      "padaria",
      "marmita",
      "marmitex",
      "self-service",
      "delivery",
      "comida pronta",
      "comida",
      "quentinha",
      "espetinho",
      "hamburguer",
      "hambúrguer",
      "pizza",
      "pizzaria",
      "sushi",
      "japonês",
      "japones",
      "açaí",
      "acai",
      "food",
      "refeição",
      "refeicao",
      "cantina",
      "buffet",
      "rodízio",
      "rodizio",
      "fast food",
      "mcdonalds",
      "mc donalds",
      "burger king",
      "subway",
      "kfc",
      "bobs",
      "habibs",
      "habib's",
      "rappi",
      "dogão",
      "dogao",
      "hot dog",
      "tapioca",
      "coxinha",
      "salgado",
      "doceria",
      "confeitaria",
      "sorveteria",
      "sorvete",
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
      "cervejaria",
      "refrigerante",
      "vinho",
      "drink",
      "drinks",
      "bar",
      "chopp",
      "chope",
      "suco",
      "água mineral",
      "ze delivery",
      "zé delivery",
      "zedelivery",
      "ze entrega",
      "whisky",
      "whiskey",
      "gin",
      "vodka",
      "rum",
      "tequila",
      "champagne",
      "espumante",
      "cachaça",
      "cachaca",
      "destilado",
      "café",
      "cafe",
      "cafeteria",
      "cappuccino",
      "capuccino",
      "energético",
      "energetico",
      "chá",
      "cha",
      "milkshake",
      "limonada",
      "kombucha",
      "isotônico",
      "isotonico",
    ],
  },
  {
    slug: "higiene_pessoal",
    label: "Higiene / Beleza",
    emoji: "🧴",
    description: "Produtos de cuidado pessoal, higiene, cosméticos, salão de beleza e barbearia.",
    keywords: [
      "higiene",
      "sabonete",
      "shampoo",
      "condicionador",
      "creme",
      "hidratante",
      "protetor solar",
      "desodorante",
      "perfume",
      "colônia",
      "colonia",
      "escova de dente",
      "pasta de dente",
      "fio dental",
      "absorvente",
      "barbeador",
      "gilete",
      "cotonete",
      "higiene pessoal",
      "cosmetico",
      "cosmético",
      "maquiagem",
      "batom",
      "rimel",
      "base",
      "esmalte",
      "unha",
      "manicure",
      "pedicure",
      "salão",
      "salao",
      "salão de beleza",
      "cabelo",
      "cabeleireiro",
      "cabeleireira",
      "corte de cabelo",
      "tintura",
      "progressiva",
      "barbeiro",
      "barbearia",
      "depilação",
      "depilacao",
      "cera",
      "sobrancelha",
      "skincare",
    ],
  },
  {
    slug: "utilidades",
    label: "Utilidades",
    emoji: "🔌",
    description: "Contas essenciais de consumo da casa: luz, água, gás, esgoto e saneamento.",
    keywords: [
      "luz",
      "energia",
      "energia elétrica",
      "energia eletrica",
      "eletricidade",
      "conta de luz",
      "conta de energia",
      "água",
      "agua",
      "conta de agua",
      "conta de água",
      "gás",
      "gas",
      "conta de gas",
      "conta de gás",
      "gás encanado",
      "gas encanado",
      "botijão",
      "botijao",
      "esgoto",
      "saneamento",
      "lixo",
      "taxa de lixo",
      "cemig",
      "enel",
      "cpfl",
      "light",
      "celpe",
      "coelba",
      "sabesp",
      "compesa",
      "embasa",
      "copasa",
      "cagece",
      "comgas",
      "comgás",
    ],
  },
  {
    slug: "internet_telefonia",
    label: "Internet / Telefonia",
    emoji: "🌐",
    description: "Planos de internet, telefonia fixa ou celular e recargas.",
    keywords: [
      "internet",
      "fibra",
      "fibra óptica",
      "fibra optica",
      "wifi",
      "wi-fi",
      "vivo fibra",
      "claro internet",
      "tim internet",
      "oi fibra",
      "telefonia",
      "celular",
      "telefone",
      "recarga",
      "recarga celular",
      "plano celular",
      "plano internet",
      "plano de celular",
      "plano de internet",
      "dados moveis",
      "dados móveis",
      "chip",
      "linha telefônica",
      "linha telefonica",
    ],
  },
  {
    slug: "moradia",
    label: "Moradia",
    emoji: "🏠",
    description: "Custos de moradia: aluguel, condomínio, financiamento imobiliário, IPTU, reforma e mudança.",
    keywords: [
      "aluguel",
      "condomínio",
      "condominio",
      "iptu",
      "financiamento",
      "prestação do apartamento",
      "prestação da casa",
      "alojamento",
      "imovel",
      "imóvel",
      "apartamento",
      "casa",
      "reforma",
      "obra",
      "pedreiro",
      "pintura",
      "mudança",
      "mudanca",
      "escritura",
      "cartório imóvel",
      "seguro residencial",
      "seguro casa",
      "mobília",
      "mobilia",
      "decoração",
      "decoracao",
    ],
  },
  {
    slug: "transporte",
    label: "Transporte",
    emoji: "🚗",
    description: "Deslocamentos, combustível, pedágios, manutenção de veículos, IPVA, seguro auto e transporte público.",
    keywords: [
      "uber",
      "99",
      "99pop",
      "gasolina",
      "combustível",
      "combustivel",
      "etanol",
      "álcool",
      "alcool",
      "diesel",
      "gnv",
      "abastecimento",
      "posto",
      "passagem",
      "ônibus",
      "onibus",
      "transporte",
      "metrô",
      "metro",
      "trem",
      "barca",
      "balsa",
      "táxi",
      "taxi",
      "cabify",
      "estacionamento",
      "pedágio",
      "pedagio",
      "manutenção carro",
      "manutencao carro",
      "oficina",
      "mecânico",
      "mecanico",
      "revisão carro",
      "revisao carro",
      "pneu",
      "troca de óleo",
      "troca de oleo",
      "borracheiro",
      "guincho",
      "lavagem",
      "lava jato",
      "lava rápido",
      "lava rapido",
      "ipva",
      "seguro auto",
      "seguro carro",
      "seguro veicular",
      "seguro automotivo",
      "seguro moto",
      "seguro do carro",
      "licenciamento veiculo",
      "dpvat",
      "detran",
      "cnh",
      "habilitação",
      "habilitacao",
      "moto",
      "bicicleta",
      "bike",
      "patinete",
    ],
  },
  {
    slug: "saude",
    label: "Saúde",
    emoji: "💊",
    description: "Cuidados com saúde: consultas médicas, planos de saúde, odontologia, farmácia, exames, terapia, academia e atividade física.",
    keywords: [
      "academia",
      "gym",
      "crossfit",
      "pilates",
      "yoga",
      "musculação",
      "musculacao",
      "personal",
      "consulta",
      "consulta médica",
      "consulta medica",
      "médico",
      "medico",
      "dentista",
      "odonto",
      "odontologia",
      "ortodontia",
      "ortodontista",
      "plano de saude",
      "plano de saúde",
      "plano saude",
      "plano odontologico",
      "plano odontológico",
      "plano odonto",
      "convênio",
      "convenio",
      "unimed",
      "amil",
      "sulamerica",
      "hapvida",
      "bradesco saude",
      "notredame",
      "farmácia",
      "farmacia",
      "drogaria",
      "remédio",
      "remedio",
      "medicamento",
      "suplemento",
      "vitamina",
      "proteína",
      "proteina",
      "whey",
      "creatina",
      "exame",
      "exame de sangue",
      "ultrassom",
      "raio x",
      "ressonância",
      "ressonancia",
      "tomografia",
      "hospital",
      "clínica",
      "clinica",
      "pronto socorro",
      "emergência",
      "emergencia",
      "urgência",
      "urgencia",
      "internação",
      "internacao",
      "cirurgia",
      "terapia",
      "psicólogo",
      "psicologo",
      "psicóloga",
      "psicologa",
      "psiquiatra",
      "psicoterapia",
      "fisioterapia",
      "fisioterapeuta",
      "fonoaudiólogo",
      "fonoaudiologo",
      "nutricionista",
      "oftalmologista",
      "oculista",
      "dermatologista",
      "ortopedista",
      "cardiologista",
      "ginecologista",
      "urologista",
      "pediatra",
      "otorrino",
      "vacina",
      "laboratório",
      "laboratorio",
      "óculos",
      "oculos",
      "lente de contato",
      "aparelho ortodôntico",
      "aparelho ortodontico",
    ],
    aliases: ["saude", "saúde"],
  },
  {
    slug: "educacao",
    label: "Educação",
    emoji: "🎓",
    description: "Cursos, mensalidades escolares/universitárias, materiais didáticos, idiomas e formação profissional.",
    keywords: [
      "curso",
      "faculdade",
      "universidade",
      "escola",
      "colégio",
      "colegio",
      "creche",
      "berçário",
      "bercario",
      "mensalidade escolar",
      "mensalidade faculdade",
      "aula",
      "aula particular",
      "material escolar",
      "livro",
      "apostila",
      "caderno",
      "uniforme escolar",
      "pós-graduação",
      "pos graduacao",
      "graduação",
      "graduacao",
      "mestrado",
      "doutorado",
      "mba",
      "inglês",
      "ingles",
      "espanhol",
      "idioma",
      "intercâmbio",
      "intercambio",
      "treinamento",
      "capacitação",
      "capacitacao",
      "certificação",
      "certificacao",
      "ead",
      "ensino",
      "educação",
      "educacao",
      "alura",
      "udemy",
      "coursera",
      "hotmart",
      "workshop",
      "palestra",
      "seminário",
      "seminario",
    ],
  },
  {
    slug: "assinaturas",
    label: "Assinaturas / Streaming",
    emoji: "📺",
    description: "Assinaturas digitais de streaming, música, jogos e serviços online recorrentes.",
    keywords: [
      "netflix",
      "spotify",
      "disney",
      "disney+",
      "hbo",
      "hbo max",
      "max",
      "amazon prime",
      "prime video",
      "globoplay",
      "telecine",
      "paramount",
      "paramount+",
      "apple tv",
      "youtube premium",
      "youtube music",
      "deezer",
      "tidal",
      "crunchyroll",
      "twitch",
      "xbox game pass",
      "playstation plus",
      "ps plus",
      "steam",
      "assinatura",
      "streaming",
      "icloud",
      "google one",
      "google drive",
      "dropbox",
      "onedrive",
      "chatgpt",
      "chatgpt plus",
      "canva",
      "adobe",
      "office 365",
      "microsoft 365",
      "antivírus",
      "antivirus",
      "vpn",
      "kindle unlimited",
      "audible",
      "starzplay",
      "star+",
      "pluto tv",
      "kwai",
    ],
  },
  {
    slug: "lazer",
    label: "Lazer / Entretenimento",
    emoji: "🎭",
    description: "Atividades de lazer, cultura, viagens, eventos, esportes e diversão.",
    keywords: [
      "cinema",
      "show",
      "lazer",
      "entretenimento",
      "viagem",
      "passeio",
      "parque",
      "parque aquático",
      "parque aquatico",
      "teatro",
      "museu",
      "exposição",
      "exposicao",
      "ingresso",
      "evento",
      "festival",
      "festa",
      "aniversário",
      "aniversario",
      "balada",
      "boate",
      "karaoke",
      "churrasco",
      "pescaria",
      "camping",
      "trilha",
      "escalada",
      "esporte",
      "futebol",
      "pelada",
      "natação",
      "natacao",
      "corrida",
      "maratona",
      "jogo",
      "videogame",
      "game",
      "brinquedo",
      "diversão",
      "diversao",
      "zoo",
      "zoológico",
      "zoologico",
      "aquário",
      "aquario",
      "praia",
      "piscina",
      "hotel",
      "pousada",
      "resort",
      "airbnb",
      "hospedagem",
      "excursão",
      "excursao",
      "cruzeiro",
      "spa",
    ],
  },
  {
    slug: "pets",
    label: "Pets / Animais",
    emoji: "🐾",
    description: "Gastos com animais de estimação: ração, veterinário, petshop, banho e tosa, medicamentos e acessórios para pets.",
    keywords: [
      "pet",
      "pets",
      "cachorro",
      "gato",
      "cão",
      "cao",
      "gatinho",
      "filhote",
      "veterinário",
      "veterinario",
      "veterinária",
      "veterinaria",
      "vet",
      "ração",
      "racao",
      "petshop",
      "pet shop",
      "banho e tosa",
      "banho tosa",
      "tosa",
      "antipulgas",
      "vermífugo",
      "vermifugo",
      "coleira",
      "caminha pet",
      "brinquedo pet",
      "areia de gato",
      "areia sanitária",
      "areia sanitaria",
      "cobasi",
      "petz",
      "canil",
      "gatil",
      "adestramento",
      "castração",
      "castracao",
      "vacina pet",
      "vacina cachorro",
      "vacina gato",
    ],
  },
  {
    slug: "roupas",
    label: "Roupas / Vestuário",
    emoji: "👗",
    description: "Compras de roupas, calçados, acessórios de moda e vestuário em geral.",
    keywords: [
      "roupa",
      "roupas",
      "vestuário",
      "vestuario",
      "calça",
      "calca",
      "camisa",
      "camiseta",
      "blusa",
      "vestido",
      "saia",
      "short",
      "bermuda",
      "sapato",
      "tênis",
      "tenis",
      "chinelo",
      "sandália",
      "sandalia",
      "bota",
      "sapatênis",
      "sapatenis",
      "jaqueta",
      "casaco",
      "moletom",
      "pijama",
      "cueca",
      "calcinha",
      "sutiã",
      "sutia",
      "meia",
      "cinto",
      "gravata",
      "terno",
      "social",
      "acessório moda",
      "bolsa",
      "mochila",
      "relógio",
      "relogio",
      "joia",
      "joias",
      "bijuteria",
      "anel",
      "pulseira",
      "colar",
      "brinco",
      "renner",
      "riachuelo",
      "c&a",
      "cea",
      "marisa",
      "zara",
      "shein",
      "shopee",
      "centauro",
      "netshoes",
      "dafiti",
      "hering",
      "loja de roupa",
    ],
  },
  {
    slug: "impostos_taxas",
    label: "Impostos e Taxas",
    emoji: "🧾",
    description: "Tributos, impostos, multas, taxas governamentais, anuidades e encargos oficiais.",
    keywords: [
      "multa",
      "taxa",
      "imposto",
      "tributo",
      "receita federal",
      "darf",
      "alvará",
      "alvara",
      "licenciamento",
      "ir",
      "irpf",
      "irpj",
      "inss",
      "iss",
      "icms",
      "pis",
      "cofins",
      "csll",
      "contribuição",
      "contribuicao",
      "anuidade",
      "crea",
      "crm",
      "oab",
      "crc",
      "coren",
      "cartório",
      "cartorio",
      "registro",
      "certidão",
      "certidao",
      "das",
      "simples nacional",
      "mei",
      "guia",
    ],
  },
  {
    slug: "servicos_domesticos",
    label: "Serviços Domésticos",
    emoji: "🧹",
    description: "Serviços para casa: faxina, diarista, jardinagem, lavanderia, reparos e manutenção residencial.",
    keywords: [
      "faxina",
      "faxineira",
      "diarista",
      "limpeza",
      "serviço doméstico",
      "servico domestico",
      "empregada",
      "doméstica",
      "domestica",
      "jardineiro",
      "jardinagem",
      "eletricista",
      "encanador",
      "pintor",
      "marceneiro",
      "vidraceiro",
      "serralheiro",
      "dedetização",
      "dedetizacao",
      "desentupimento",
      "lavanderia",
      "passadeira",
      "conserto",
      "reparo",
      "manutenção casa",
      "manutencao casa",
      "porteiro",
      "zelador",
    ],
  },
  {
    slug: "presentes",
    label: "Presentes / Doações",
    emoji: "🎁",
    description: "Presentes, doações, dízimos, ofertas religiosas e contribuições beneficentes.",
    keywords: [
      "presente",
      "presentes",
      "doação",
      "doacao",
      "doações",
      "doacoes",
      "dízimo",
      "dizimo",
      "oferta",
      "oferta religiosa",
      "caridade",
      "ong",
      "contribuição social",
      "contribuicao social",
      "vaquinha",
      "ajuda",
      "esmola",
      "bazar",
      "lembrancinha",
      "mimo",
      "gift",
      "mesada",
    ],
  },
  {
    slug: "salario_trabalho",
    label: "Salário / Trabalho",
    emoji: "💼",
    description: "Receitas de salário, freelance, holerite, comissões, vale e benefícios trabalhistas.",
    keywords: [
      "salário",
      "salario",
      "pagamento",
      "folha",
      "pro labore",
      "pró-labore",
      "adiantamento",
      "contrato",
      "holerite",
      "contracheque",
      "vale transporte",
      "vale alimentação",
      "vale alimentacao",
      "vale refeição",
      "vale refeicao",
      "vt",
      "va",
      "vr",
      "bonificação",
      "bonificacao",
      "comissão",
      "comissao",
      "freelance",
      "freela",
      "bico",
      "renda extra",
      "hora extra",
      "décimo terceiro",
      "decimo terceiro",
      "13º",
      "férias",
      "ferias",
      "rescisão",
      "rescisao",
      "fgts",
      "seguro desemprego",
      "pis",
      "abono",
    ],
  },
  {
    slug: "vendas_receitas",
    label: "Vendas e Receitas",
    emoji: "💵",
    description: "Recebimentos por vendas, serviços prestados, faturamento e entradas diversas.",
    keywords: [
      "venda",
      "vendas",
      "recebimento",
      "cliente",
      "boleto recebido",
      "serviço prestado",
      "servico prestado",
      "entrada",
      "receita",
      "faturamento",
      "nota fiscal",
      "nf",
      "nfe",
      "cobrança",
      "cobranca",
      "reembolso",
      "pix recebido",
      "transferência recebida",
      "transferencia recebida",
      "lucro",
      "ganho",
      "honorário",
      "honorario",
      "consultoria",
      "projeto",
    ],
  },
  {
    slug: "investimentos",
    label: "Investimentos",
    emoji: "📈",
    description: "Aportes, resgates, dividendos, rendimentos e movimentações financeiras de investimentos.",
    keywords: [
      "investimento",
      "bolsa",
      "renda fixa",
      "tesouro",
      "tesouro direto",
      "ação",
      "acao",
      "ações",
      "acoes",
      "cripto",
      "criptomoeda",
      "bitcoin",
      "btc",
      "ethereum",
      "eth",
      "poupança",
      "poupanca",
      "cdb",
      "lci",
      "lca",
      "lc",
      "fundo",
      "fundo imobiliário",
      "fundo imobiliario",
      "fii",
      "dividendo",
      "dividendos",
      "rendimento",
      "juros",
      "debênture",
      "debenture",
      "previdência",
      "previdencia",
      "pgbl",
      "vgbl",
      "day trade",
      "swing trade",
      "forex",
      "dólar",
      "dolar",
      "câmbio",
      "cambio",
      "ouro",
      "commodities",
      "coe",
      "nft",
      "aporte",
      "resgate",
      "aplicação",
      "aplicacao",
    ],
  },
  {
    slug: "outros",
    label: "Outros",
    emoji: "🧩",
    description: "Despesas ou receitas que não se encaixam nas demais categorias.",
    keywords: [],
  },
];

// ============================
// Helper para exibir categoria com emoji
// ============================
function getCategoryInfo(categorySlug) {
  if (!categorySlug) return { emoji: "📝", label: "Sem categoria" };
  // Busca nas categorias base primeiro
  const base = CATEGORY_DEFINITIONS.find((c) => c.slug === categorySlug);
  if (base) return base;
  // Busca no cache de customizadas (síncrono — usa o cache em memória se disponível)
  if (customCategoriesCache) {
    const custom = customCategoriesCache.find((c) => c.slug === categorySlug);
    if (custom) return { emoji: custom.emoji, label: custom.label };
  }
  return { emoji: "🏷️", label: humanizeCategorySlug(categorySlug) || categorySlug };
}


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

const detectCategoryWithCustom = async (description, tipo, userNorm = null) => {
  const baseMatch = detectCategoryHeuristic(description, tipo);
  if (!userNorm) return baseMatch;
  try {
    const normalized = normalizeDiacritics((description || "").toLowerCase());
    const customCats = await loadCustomCategories(userNorm);
    let bestCustom = null;
    let bestCustomLen = baseMatch ? 0 : -1;
    for (const cat of customCats) {
      const kwList = (cat.keywords || "")
        .split(",")
        .map((k) => normalizeDiacritics(k.trim()).toLowerCase())
        .filter(Boolean);
      for (const kw of kwList) {
        if (kw && kw.length > bestCustomLen && normalized.includes(kw)) {
          bestCustom = { slug: cat.slug, emoji: cat.emoji };
          bestCustomLen = kw.length;
        }
      }
    }
    if (bestCustom) return bestCustom;
  } catch (err) {
    console.error("⚠️ detectCategoryWithCustom error:", err.message);
  }
  return baseMatch;
};

const detectCategoryHeuristic = (description, tipo) => {
  const normalized = normalizeDiacritics((description || "").toLowerCase());
  let bestMatch = null;
  let bestLen = 0;
  for (const category of CATEGORY_DEFINITIONS) {
    const keywords = category.normalizedKeywords || [];
    for (const kw of keywords) {
      if (kw && kw.length > bestLen && normalized.includes(kw)) {
        bestMatch = { slug: category.slug, emoji: category.emoji };
        bestLen = kw.length;
      }
    }
  }
  if (bestMatch) return bestMatch;
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

const buildCategoryPrompt = async (description, tipo, userNorm = null) => {
  const customCats = await loadCustomCategories(userNorm);
  const baseHint = CATEGORY_PROMPT_HINT;
  const customHint = customCats.length
    ? customCats
        .map((c) => `${c.slug}: ${c.label} (${c.emoji})${c.description ? " - " + c.description : ""}`)
        .join("\n")
    : "";
  const allCategoriesHint = customHint ? `${baseHint}\n${customHint}` : baseHint;

  return [
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text: `Você é um classificador inteligente de categorias financeiras.

TAREFA: Analisar o lançamento e escolher ou criar a categoria mais adequada.

REGRAS:
1. Prefira categorias existentes quando forem realmente adequadas
2. Crie nova categoria SOMENTE se nenhuma existente for específica o suficiente
3. A categoria "outros" deve ser usada APENAS como último recurso absoluto
4. Slugs em snake_case minúsculo (ex: "pets", "streaming", "delivery_app")
5. Labels curtos e descritivos (máximo 40 caracteres)

FORMATO DE RESPOSTA — responda SOMENTE com JSON válido, sem texto adicional:

Se usar categoria existente:
{"slug":"nome_slug","isNew":false}

Se criar categoria nova:
{"slug":"slug_novo","label":"Nome da Categoria","emoji":"🏷️","description":"Descrição breve","keywords":"palavra1,palavra2,palavra3","isNew":true}`,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Categorias disponíveis:\n${allCategoriesHint}\n\nDescrição do lançamento: "${truncateForPrompt(description)}"\nTipo: ${tipo === "conta_receber" ? "recebimento" : "pagamento"}\n\nResponda com o JSON da categoria.`,
        },
      ],
    },
  ];
};

const resolveCategory = async (description, tipo, userNorm) => {
  const fallback = await detectCategoryWithCustom(description, tipo, userNorm);
  if (!description || !description.toString().trim() || !openaiClient) return fallback;
  try {
    const prompt = await buildCategoryPrompt(description, tipo, userNorm);
    const output = await callOpenAI({
      model: OPENAI_CATEGORY_MODEL,
      input: prompt,
      temperature: 0,
      maxOutputTokens: 150,
    });

    let parsed = null;
    try {
      const jsonStr = (output || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      parsed = JSON.parse(jsonStr);
    } catch (_) {
      parsed = null;
    }

    if (parsed && parsed.slug) {
      const cleanSlug = (parsed.slug || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/__+/g, "_").replace(/^_|_$/g, "");

      if (parsed.isNew && parsed.label) {
        saveCustomCategory({
          slug: cleanSlug,
          label: parsed.label,
          emoji: parsed.emoji || "🏷️",
          description: parsed.description || "",
          keywords: parsed.keywords || "",
          created_by: userNorm || "",
        }).catch((err) => console.error("⚠️ Erro ao salvar nova categoria:", err.message));

        return { slug: cleanSlug, emoji: parsed.emoji || "🏷️" };
      }

      const baseDef = getCategoryDefinition(cleanSlug);
      if (baseDef) return { slug: baseDef.slug, emoji: baseDef.emoji };

      const customCats = await loadCustomCategories(userNorm);
      const customDef = customCats.find((c) => c.slug === cleanSlug);
      if (customDef) {
        incrementCategoryUsage(cleanSlug).catch(() => {});
        return { slug: customDef.slug, emoji: customDef.emoji };
      }
    }

    const predicted = (output || "").trim();
    if (predicted) {
      const def = getCategoryDefinition(predicted);
      if (def) return { slug: def.slug, emoji: def.emoji };
      const pieces = predicted.split(/\s|,|;|\n/).filter(Boolean);
      for (const piece of pieces) {
        const candidate = getCategoryDefinition(piece);
        if (candidate) return { slug: candidate.slug, emoji: candidate.emoji };
      }
    }
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
if (!WA_ACCESS_TOKEN) {
  console.warn("[WA] missing access token env");
}
const WA_TEXT_LIMIT = 4000;
const TEMPLATE_REMINDER_NAME_V2 = "lembrete_finplanner_2";
const TEMPLATE_REMINDER_BUTTON_ID = "REMINDERS_VIEW";
const REMINDER_PENDING_BUTTON_ID = "VISUALIZAR_LEMBRETES_VENCIDAS";
const SUPPORT_NUMBER = normalizeUser("5579991249561");
const ADMIN_NUMBER_NORM = normalizeUser(ADMIN_WA_NUMBER);
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

// ============================
// Transcrição de áudio via OpenAI Whisper
// ============================

const WA_MEDIA_API_BASE = `https://graph.facebook.com/${WA_API_VERSION}`;

async function transcribeAudio(mediaId) {
  if (!openaiClient) {
    console.warn("[Whisper] OpenAI não está habilitado. Ignorando áudio.");
    return null;
  }

  // 1. Busca a URL de download do arquivo no WhatsApp
  let mediaUrl;
  try {
    const metaRes = await axios.get(`${WA_MEDIA_API_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
      timeout: 10000,
    });
    mediaUrl = metaRes.data?.url;
  } catch (err) {
    console.error("[Whisper] Erro ao buscar URL da mídia:", err.message);
    return null;
  }

  if (!mediaUrl) {
    console.error("[Whisper] URL da mídia não encontrada para mediaId:", mediaId);
    return null;
  }

  // 2. Baixa o arquivo de áudio como buffer
  let audioBuffer;
  try {
    const audioRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
      responseType: "arraybuffer",
      timeout: 30000,
    });
    audioBuffer = Buffer.from(audioRes.data);
  } catch (err) {
    console.error("[Whisper] Erro ao baixar áudio:", err.message);
    return null;
  }

  // 3. Transcreve com OpenAI Whisper
  try {
    const file = new File([audioBuffer], "audio.ogg", { type: "audio/ogg" });
    const transcription = await openaiClient.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "pt",
    });
    const text = transcription?.text?.trim();
    console.log("[Whisper] Transcrição:", text);
    return text || null;
  } catch (err) {
    console.error("[Whisper] Erro ao transcrever áudio:", err.message);
    return null;
  }
}

async function sendWA(payload, context = {}) {
  try {
    await axios.post(WA_API, payload, {
      headers: {
        Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000, // ✅ FIX: Timeout de 10 segundos
    });

    // Log de saída: registra resposta do bot na planilha Log_Mensagens
    try {
      const to = payload.to || "";
      const userNorm = normalizeUser(to);
      const tipo = payload.type || "text";
      let mensagem = "";
      let buttonId = "";
      let buttonTitle = "";

      if (tipo === "text") {
        mensagem = payload.text?.body || "";
      } else if (tipo === "interactive") {
        mensagem = payload.interactive?.body?.text || "";
        const buttons = payload.interactive?.action?.buttons || [];
        buttonId = buttons.map((b) => b.reply?.id || b.copy_code || "").join(", ");
        buttonTitle = buttons.map((b) => b.reply?.title || b.title || "").join(", ");
      } else if (tipo === "template") {
        mensagem = `[template: ${payload.template?.name || "unknown"}]`;
      }

      saveMessageToLog(to, userNorm, tipo, mensagem, buttonId, buttonTitle, "saida").catch(() => {});
    } catch (_logErr) {
      // Nunca bloquear envio por falha de log
    }

    return true;
  } catch (error) {
    const errorData = error.response?.data?.error || {};
    const errorTitle = errorData.error_data?.details || errorData.message || error.message;

    console.error("[WA] error", {
      kind: context.kind || payload?.type,
      to: payload.to,
      errorTitle,
      errorCode: errorData.code,
      fullResponse: error.response?.data,
    });
    return false;
  }
}

const buildReminderText = (name, {
  pagarVencidas = 0, pagarHoje = 0,
  receberVencidas = 0, receberHoje = 0,
  total = "0,00"
} = {}) => {
  const cleaned = (name || "").trim();
  const greeting = cleaned ? `Olá, ${cleaned}! 👋` : "Olá! 👋";
  return (
    `${greeting}\n\n` +
    `Você tem pendências financeiras:\n` +
    `📋 Contas vencidas: ${pagarVencidas} conta(s)\n` +
    `📅 Contas que vencem hoje: ${pagarHoje} conta(s)\n` +
    `💸 Recebimentos vencidos: ${receberVencidas} recebimento(s)\n` +
    `💰 Recebimentos para hoje: ${receberHoje} recebimento(s)\n\n` +
    `✅ Total: R$ ${total}\n\n` +
    `Toque em Visualizar para ver os detalhes.`
  );
};

const sendInteractiveReminder = async (to, userNorm, {
  pagarVencidas = 0, pagarHoje = 0,
  receberVencidas = 0, receberHoje = 0,
  total = "0,00"
} = {}) => {
  const name = getStoredFirstName(userNorm);
  const bodyText = buildReminderText(name, { pagarVencidas, pagarHoje, receberVencidas, receberHoje, total });
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: REMINDER_PENDING_BUTTON_ID,
              title: "Visualizar",
            },
          },
        ],
      },
    },
  };
  console.log("[WA] sending", {
    to,
    kind: "interactive",
    withinWindow: true,
    hasBody: Boolean(bodyText),
    templateName: null,
  });
  return sendWA(payload, { kind: "interactive" });
};

const sendTemplateReminderV2 = async (to, userNorm, {
  nameHint = "",
  pagarVencidas = 0, pagarHoje = 0,
  receberVencidas = 0, receberHoje = 0,
  total = "0,00"
} = {}) => {
  const firstName = (nameHint || getStoredFirstName(userNorm) || "").trim();
  const safeName = firstName || "-";
  const vencidasTotal = pagarVencidas + receberVencidas;
  const hojeTotal = pagarHoje + receberHoje;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: TEMPLATE_REMINDER_NAME_V2,
      language: { code: "pt_BR" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: safeName },
            { type: "text", text: String(vencidasTotal) },
            { type: "text", text: String(hojeTotal) },
            { type: "text", text: total },
          ],
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
    templateName: TEMPLATE_REMINDER_NAME_V2,
  });
  const success = await sendWA(payload, { kind: "template" });
  if (success) {
    console.log("✅ Template v2 enviado para", to, { pagarVencidas, pagarHoje, receberVencidas, receberHoje, total });
  }
  return success;
};

const sendTemplateReminder = async (to, userNorm, nameHint = "") =>
  sendTemplateReminderV2(to, userNorm, { nameHint });

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

const USUARIOS_HEADERS = [
  "user",
  "plano",
  "ativo",
  "data_inicio",
  "vencimento_plano",
  "email",
  "nome",
  "checkout_id",
  "last_interaction",
];
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
const LOG_MENSAGENS_HEADERS = [
  "timestamp",      // Data/hora ISO da mensagem
  "direcao",        // "entrada" (usuário → bot) ou "saida" (bot → usuário)
  "user",           // Número normalizado do usuário
  "user_raw",       // Número original do WhatsApp
  "tipo",           // text, interactive, button
  "mensagem",       // Texto da mensagem (se text)
  "button_id",      // ID do botão (se interactive)
  "button_title",   // Título do botão (se interactive)
];
const CUSTOM_CATEGORIES_HEADERS = [
  "slug",           // Identificador único (snake_case)
  "label",          // Nome legível da categoria
  "emoji",          // Emoji representativo
  "description",    // Descrição da categoria
  "keywords",       // Palavras-chave separadas por vírgula para detecção automática
  "created_by",     // Usuário que gerou a categoria
  "created_at",     // Timestamp de criação
  "usage_count",    // Contagem de uso
];
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
    const cachedSheet = doc.sheetsByTitle[title];
    if (cachedSheet) return cachedSheet;
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

async function ensureLogSheet() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["Log_Mensagens"];
  if (!sheet) {
    sheet = await withRetry(
      () => doc.addSheet({ title: "Log_Mensagens", headerValues: LOG_MENSAGENS_HEADERS }),
      "add-log-mensagens"
    );
    console.log("✅ Aba Log_Mensagens criada");
  } else {
    await withRetry(() => sheet.loadHeaderRow(), "load-header-log");
    const current = (sheet.headerValues || []).map((header) => (header || "").trim());
    const filtered = current.filter(Boolean);
    const hasDuplicate = new Set(filtered).size !== filtered.length;
    const missing = LOG_MENSAGENS_HEADERS.filter((header) => !current.includes(header));
    const orderMismatch = LOG_MENSAGENS_HEADERS.some((header, index) => current[index] !== header);
    if (hasDuplicate || missing.length || orderMismatch || current.length !== LOG_MENSAGENS_HEADERS.length) {
      await withRetry(() => sheet.setHeaderRow(LOG_MENSAGENS_HEADERS), "set-header-log");
    }
  }
  return sheet;
}

// ============================
// Categorias Customizadas (dinâmicas via IA)
// ============================
let customCategoriesCache = null;
let customCategoriesCacheExpiry = 0;
const CUSTOM_CATEGORIES_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function ensureCustomCategoriesSheet() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["Categorias_Customizadas"];
  if (!sheet) {
    sheet = await withRetry(
      () => doc.addSheet({ title: "Categorias_Customizadas", headerValues: CUSTOM_CATEGORIES_HEADERS }),
      "add-custom-categories-sheet"
    );
  } else {
    await withRetry(() => sheet.loadHeaderRow(), "load-header-custom-categories");
    const current = (sheet.headerValues || []).map((h) => (h || "").trim());
    const filtered = current.filter(Boolean);
    const hasDuplicate = new Set(filtered).size !== filtered.length;
    const missing = CUSTOM_CATEGORIES_HEADERS.filter((h) => !current.includes(h));
    const orderMismatch = CUSTOM_CATEGORIES_HEADERS.some((h, i) => current[i] !== h);
    if (hasDuplicate || missing.length || orderMismatch || current.length !== CUSTOM_CATEGORIES_HEADERS.length) {
      await withRetry(() => sheet.setHeaderRow(CUSTOM_CATEGORIES_HEADERS), "set-header-custom-categories");
    }
  }
  return sheet;
}

const loadCustomCategories = async (userNorm = null) => {
  const now = Date.now();
  if (customCategoriesCache && now < customCategoriesCacheExpiry) {
    return userNorm
      ? customCategoriesCache.filter((c) => !c.created_by || c.created_by === userNorm)
      : customCategoriesCache;
  }
  try {
    const sheet = await ensureCustomCategoriesSheet();
    const rows = await withRetry(() => sheet.getRows(), "get-custom-categories");
    customCategoriesCache = rows
      .map((row) => ({
        slug: (getVal(row, "slug") || "").trim(),
        label: (getVal(row, "label") || "").trim(),
        emoji: (getVal(row, "emoji") || "🏷️").trim(),
        description: (getVal(row, "description") || "").trim(),
        keywords: (getVal(row, "keywords") || "").trim(),
        created_by: (getVal(row, "created_by") || "").trim(),
        isCustom: true,
      }))
      .filter((c) => c.slug);
    customCategoriesCacheExpiry = now + CUSTOM_CATEGORIES_CACHE_TTL;
    return userNorm
      ? customCategoriesCache.filter((c) => !c.created_by || c.created_by === userNorm)
      : customCategoriesCache;
  } catch (err) {
    console.error("⚠️ Erro ao carregar categorias customizadas:", err.message);
    const fallback = customCategoriesCache || [];
    return userNorm ? fallback.filter((c) => !c.created_by || c.created_by === userNorm) : fallback;
  }
};

const invalidateCustomCategoriesCache = () => {
  customCategoriesCache = null;
  customCategoriesCacheExpiry = 0;
};

const saveCustomCategory = async ({ slug, label, emoji, description, keywords = "", created_by }) => {
  try {
    const cleanSlug = (slug || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/__+/g, "_").replace(/^_|_$/g, "");
    if (!cleanSlug || cleanSlug.length < 2) return;
    const cleanLabel = (label || "").toString().slice(0, 50).trim();
    const cleanEmoji = (emoji || "🏷️").toString().trim().slice(0, 4);
    if (!cleanLabel) return;

    // Verificar duplicata apenas para este usuário (não global)
    const existing = await loadCustomCategories(created_by || null);
    if (existing.some((c) => c.slug === cleanSlug)) {
      console.log("⚠️ Categoria já existe para este usuário:", cleanSlug);
      return;
    }

    const sheet = await ensureCustomCategoriesSheet();
    await withRetry(
      () =>
        sheet.addRow({
          slug: cleanSlug,
          label: cleanLabel,
          emoji: cleanEmoji,
          description: (description || "").slice(0, 200),
          keywords: (keywords || "").toString().slice(0, 500),
          created_by: created_by || "",
          created_at: new Date().toISOString(),
          usage_count: "1",
        }),
      "add-custom-category"
    );
    invalidateCustomCategoriesCache();
    console.log("✨ Nova categoria criada:", cleanSlug, cleanLabel, cleanEmoji);
  } catch (err) {
    console.error("⚠️ Erro ao salvar categoria customizada:", err.message);
  }
};

const incrementCategoryUsage = async (slug) => {
  try {
    const sheet = await ensureCustomCategoriesSheet();
    const rows = await withRetry(() => sheet.getRows(), "get-custom-cat-rows");
    const row = rows.find((r) => (getVal(r, "slug") || "").trim() === slug);
    if (row) {
      const current = parseInt(getVal(row, "usage_count") || "0", 10);
      setVal(row, "usage_count", String(current + 1));
      await withRetry(() => row.save(), "inc-category-usage");
    }
  } catch (err) {
    console.error("⚠️ Erro ao incrementar uso de categoria:", err.message);
  }
};

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

const saveMessageToLog = async (userRaw, userNorm, tipo, mensagem, buttonId, buttonTitle, direcao = "entrada") => {
  try {
    const sheet = await ensureLogSheet();
    const now = new Date();
    const logEntry = {
      timestamp: now.toISOString(),
      direcao,
      user: userNorm || "",
      user_raw: userRaw || "",
      tipo: tipo || "text",
      mensagem: mensagem || "",
      button_id: buttonId || "",
      button_title: buttonTitle || "",
    };
    await withRetry(() => sheet.addRow(logEntry), "add-log-message");
  } catch (error) {
    // Não bloquear o fluxo se log falhar
    console.error("⚠️ Erro ao salvar mensagem no log:", error.message);
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
  vencimento_trial, // Data fixa de vencimento do trial (3 dias)
  ativo,
  extendVencimento = false,
}) => {
  if (!userNorm) throw new Error("Usuário inválido.");
  const sheet = await ensureSheetUsuarios();
  const rows = await withRetry(() => sheet.getRows(), "get-usuarios");
  const candidates = getUserCandidates(userNorm);
  const target =
    rows.find((row) => normalizeUser(getVal(row, "user")) === userNorm) ||
    rows.find((row) => candidates.includes(normalizeUser(getVal(row, "user"))));
  const normalizedPlan = normalizePlan(plano) || normalizePlan(getVal(target, "plano"));
  const existingDataInicio = parseISODateSafe(getVal(target, "data_inicio"));
  const payloadDataInicio = parseISODateSafe(data_inicio);
  const baseDataInicio = payloadDataInicio || existingDataInicio || new Date();
  const existingVencimento = getVal(target, "vencimento_plano");

  let vencimento;
  if (vencimento_trial) {
    // Checkout: usa vencimento do trial (3 dias), só sobrescreve se não houver vencimento futuro
    const existingDate = parseISODateSafe(existingVencimento);
    const today = startOfDay(new Date());
    const existingIsFuture = existingDate && startOfDay(existingDate).getTime() > today.getTime();
    vencimento = existingIsFuture ? existingVencimento : vencimento_trial;
  } else if (extendVencimento) {
    // Pagamento confirmado: calcula novo vencimento baseado no plano
    vencimento = computeNewVencimento(existingVencimento, normalizedPlan, baseDataInicio) || existingVencimento;
  } else {
    vencimento = existingVencimento || formatISODate(baseDataInicio);
  }

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
    await withRetry(() => target.save(), "upsert-usuario-save");
  } else {
    await withRetry(() => sheet.addRow(update), "upsert-usuario-addrow");
  }
  // ✅ Criar/garantir aba do usuário no Sheets automaticamente
  try {
    await ensureUserSheet(userNorm);
    console.log("✅ Aba do usuário garantida:", getUserSheetName(userNorm));
  } catch (sheetErr) {
    console.error("⚠️ Erro ao criar aba do usuário:", userNorm, sheetErr.message);
  }
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
  const vencimentoTrialRaw = getVal(target, "vencimento_trial");
  const vencimentoDate = parseDateLoose(vencimentoRaw) || parseDateLoose(vencimentoTrialRaw);
  const today = startOfDay(new Date());
  const vencOk = vencimentoDate ? startOfDay(vencimentoDate).getTime() >= today.getTime() : false;
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
  const statusEmoji = statusRaw === "recebido" || statusRaw === "pago" ? "✅" : "⏳";

  // Linha 1: número + nome
  // Linha 2: valor · data · status
  // Linha 3: categoria
  // Linha 4: recorrência (se houver)
  const line2Parts = [`💰 ${valor}`, `📅 ${data}`, statusEmoji];
  const lines = [];

  if (headerLabel) {
    lines.push(`${headerLabel}\n`);
    lines.push(`💰 ${valor}  ·  📅 ${data}  ·  ${statusEmoji}`);
    lines.push(categoriaLabel);
  } else if (typeof index === "number") {
    lines.push(`*${index}. ${descricao}*`);
    lines.push(line2Parts.join("  ·  "));
    lines.push(categoriaLabel);
  } else {
    lines.push(`*${descricao}*`);
    lines.push(line2Parts.join("  ·  "));
    lines.push(categoriaLabel);
  }

  if (isRowFixed(row)) {
    const recurrenceLabel = describeRecurrence(row);
    if (recurrenceLabel) lines.push(`🔄 ${recurrenceLabel}`);
  }

  return lines.join("\n");
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

const buildPeriodLabel = (start, end) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  if (start.getTime() === todayStart.getTime() && end.getTime() === todayEnd.getTime()) {
    return `Hoje, ${formatBRDate(now)}`;
  }
  const monthStart = startOfMonth(now.getFullYear(), now.getMonth());
  const monthEnd = endOfMonth(now.getFullYear(), now.getMonth());
  if (start.getTime() === monthStart.getTime() && end.getTime() === monthEnd.getTime()) {
    return now.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
      .replace(/^./, (c) => c.toUpperCase());
  }
  return `${formatBRDate(start)} a ${formatBRDate(end)}`;
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
      { id: "MENU:contas_receber", title: "💵 Contas a receber", description: "Ver e confirmar recebimentos pendentes." },
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
          ? `Olá! Bem-vindo à FinPlanner IA 💰

Sou sua assistente financeira no WhatsApp. Basta me mandar uma mensagem normal:

✍️ *Exemplos que funcionam:*
• _"Paguei R$89,90 de mercado"_
• _"Recebi R$2.500 de salário"_
• _"Gastei 45 no almoço hoje"_
• _"Conta de luz R$180 vence dia 15"_

📊 *Consultas:*
• Digite *saldo* para ver seu balanço
• Digite *pendentes* para ver contas a pagar
• Digite *menu* para ver todas as opções

🚀 Pode começar digitando um gasto ou recebimento!`
          : `Toque em *Abrir menu* ou digite o que deseja fazer.

💡 _Ex: "Paguei R$50 de mercado"_ ou _"saldo"_`,
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
          { type: "reply", reply: { id: `${prefix}:hoje`, title: "Hoje" } },
          { type: "reply", reply: { id: `${prefix}:mes_atual`, title: "Mês Atual" } },
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
    `♻ Cadastro de conta fixa\n\nEnvie tudo em uma única mensagem neste formato:\n\n📝 Descrição: Nome da conta\n(ex: Internet, Academia, Aluguel)\n\n💰 Valor: Valor fixo da conta\n(ex: 120,00)\n\n🔁 Recorrência: Informe o intervalo\n(ex: todo dia 05, a cada 15 dias, semanal, quinzenal)\n\n💡 Exemplos:\n➡ Internet 120 todo dia 05\n➡ Aluguel 150 a cada 15 dias\n➡ Academia 90 semanal\n➡ Tênis 3 parcelas de 80 todo dia 10\n\n📦 *Várias de uma vez?* Envie uma por linha!\n\nDigite *cancelar* para sair.`
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
    .sort((a, b) => (getEffectiveDate(a)?.getTime() || 0) - (getEffectiveDate(b)?.getTime() || 0));
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
const sessionLastRegistered = new Map(); // rowId do último lançamento registrado (para correção rápida)
const sessionDuplicateConfirm = new Map(); // payload aguardando confirmação de duplicado
const sessionNewCategory = new Map(); // estado do fluxo guiado de criação de categoria
const lastMessagesHistory = new Map(); // userNorm → [últimas 5 mensagens normalizadas]

const trackMessageAndDetectLoop = (userNorm, normalizedMessage) => {
  if (!normalizedMessage || normalizedMessage.length < 2) return false;
  const history = lastMessagesHistory.get(userNorm) || [];
  history.push(normalizedMessage);
  while (history.length > 5) history.shift();
  lastMessagesHistory.set(userNorm, history);
  return history.length >= 3 && history.slice(-3).every((m) => m === normalizedMessage);
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
  sessionLastRegistered.delete(userNorm);
  sessionDuplicateConfirm.delete(userNorm);
  sessionNewCategory.delete(userNorm);
};

const hasActiveSession = (userNorm) =>
  sessionPaymentCode.has(userNorm) ||
  sessionStatusConfirm.has(userNorm) ||
  sessionPayConfirm.has(userNorm) ||
  sessionFixedDelete.has(userNorm) ||
  sessionFixedRegister.has(userNorm) ||
  sessionEdit.has(userNorm) ||
  sessionDelete.has(userNorm) ||
  sessionRegister.has(userNorm) ||
  sessionPeriod.has(userNorm) ||
  sessionDuplicateConfirm.has(userNorm) ||
  sessionNewCategory.has(userNorm);

const ESCAPE_REGEX = /^(cancelar|cancel|menu|voltar|sair|inicio|início)$/i;
const NAVIGATE_REGEX = /^(menu|voltar|inicio|início)$/i;

const sendCancelMessage = async (to, { reason } = {}) => {
  console.log("[sendCancelMessage] Enviando menu após cancelamento:", { to, reason });
  const msg = reason === "timeout"
    ? "⏰ Operação cancelada por inatividade.\n\n💡 Você pode recomeçar a qualquer momento — basta enviar sua mensagem novamente ou tocar em *Abrir menu*."
    : "Operação cancelada.";
  await sendText(to, msg);
  await sendMainMenu(to);
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
  try {
    if (DEBUG_SHEETS) console.log("[Sheets] Removing row", getVal(row, "row_id"));
    if (typeof row.delete === "function") await row.delete();
  } catch (error) {
    console.error("[Sheets] Erro ao excluir linha:", error.message);
    throw error; // Re-throw para que o caller saiba que falhou
  }
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
      const label = item.dueMs < todayMs ? `${dueLabel} ⚠️ atrasado` : dueLabel;
      return formatEntryBlock(item.row, { index: counter++, dateText: label });
    });
    sections.push(`💸 *Pagamentos pendentes* (${pagar.length})\n\n${blocks.join("\n\n")}`);
  }

  if (receber.length) {
    const blocks = receber.map((item) => {
      const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
      const dueLabel = dueRaw || "—";
      const label = item.dueMs < todayMs ? `${dueLabel} ⚠️ atrasado` : dueLabel;
      return formatEntryBlock(item.row, { index: counter++, dateText: label });
    });
    sections.push(`💵 *Recebimentos pendentes* (${receber.length})\n\n${blocks.join("\n\n")}`);
  }

  if (!sections.length) return { message: "", pagar, receber };

  const totalValor = items.reduce((sum, item) => sum + toNumber(getVal(item.row, "valor")), 0);
  const totalLine = totalValor > 0 ? `\n💰 *Total: ${formatCurrencyBR(totalValor)}*\n` : "";
  return { message: `📋 *Seus lembretes*${totalLine}\n${sections.join("\n\n")}`, pagar, receber };
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
  const dateMatch = original.match(new RegExp(`(daqui\\s+a?\\s*\\d+\\s*dias?|hoje|amanh[ãa]|ontem|${DATE_TOKEN_PATTERN})`, "i"));
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
    .replace(/daqui\s+a?\s*\d+\s*dias?/gi, "")
    .replace(/(hoje|amanh[ãa]|ontem)/gi, "")
    .replace(new RegExp(DATE_TOKEN_PATTERN, "gi"), "")
    .replace(/[-\/]\s*\d{1,2}(?:\b|$)/g, "")
    .replace(/\b(recebimento|receber|recebido|recebi|recebemos|pagamento|pagar|pago|paguei|pendente|quitad[oa]|liquidad[oa]|entrada|receita)\b/gi, "")
    .replace(/\b(gastei|comprei|ganhei|vendi|transferi|mandei|depositei|pix(?:ei)?)\b/gi, "")
    .replace(/\b(dia|data)\b/gi, "")
    .replace(/\b(valor|lançamento|lancamento|novo|registrar|registro)\b/gi, "")
    .replace(/r\$/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Remove filler words from the start (greetings, pronouns)
  descricao = descricao.replace(/^(oi|ei|opa|olá|ola|ah|eh|bom|bem|então|entao|ok|oi,|ei,|opa,)\s+/gi, "").trim();
  // Remove subject pronouns from the start
  descricao = descricao.replace(/^(eu|vc|voce|você)\s+/gi, "").trim();

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

  // Remove leading prepositions/articles that ended up at the start after cleaning
  descricao = descricao.replace(/^(com|de|do|da|no|na|nos|nas|pro|pra|para|num|numa|o|a|os|as|um|uma)\s+/gi, "").trim();
  // Remove trailing loose punctuation
  descricao = descricao.replace(/[\s.,;!?]+$/, "").trim();

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
  const periodLabel = buildPeriodLabel(start, end);

  const statusOf = (row) => (getVal(row, "status") || "").toString().toLowerCase();
  const isPaid = (row) => statusOf(row) === "pago";
  const isReceived = (row) => {
    const status = statusOf(row);
    return status === "recebido" || status === "pago";
  };

  const DIV = "━━━━━━━━━━━━";

  if (category === "cp") {
    const expenses = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar");
    const pending = expenses.filter((row) => !isPaid(row));
    const paid = expenses.filter(isPaid);
    const totalPending = sumValues(pending);
    const totalPaid = sumValues(paid);
    const totalExpenses = sumValues(expenses);

    let message = `📊 *Contas a Pagar*\n📅 _${periodLabel}_`;
    if (!expenses.length) {
      message += "\n\n✅ Nenhuma conta encontrada para o período selecionado.";
    } else {
      if (pending.length) {
        const blocks = pending.map((row) => formatEntryBlock(row)).join("\n\n");
        message += `\n\n⏳ *Pendentes* (${pending.length})\n\n${blocks}`;
      }
      if (paid.length) {
        const blocks = paid.map((row) => formatEntryBlock(row)).join("\n\n");
        message += `\n\n✅ *Pagas* (${paid.length})\n\n${blocks}`;
      }
      message += `\n\n${DIV}`;
      message += `\n⏳ Pendente:     ${formatCurrencyBR(totalPending)}`;
      message += `\n✅ Pago:         ${formatCurrencyBR(totalPaid)}`;
      message += `\n💰 *Total geral: ${formatCurrencyBR(totalExpenses)}*`;
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

    let message = `📊 *Recebimentos*\n📅 _${periodLabel}_`;
    if (!receipts.length) {
      message += "\n\n✅ Nenhum recebimento encontrado para o período selecionado.";
    } else {
      if (pending.length) {
        const blocks = pending.map((row) => formatEntryBlock(row)).join("\n\n");
        message += `\n\n⏳ *Pendentes* (${pending.length})\n\n${blocks}`;
      }
      if (confirmed.length) {
        const blocks = confirmed.map((row) => formatEntryBlock(row)).join("\n\n");
        message += `\n\n✅ *Recebidos* (${confirmed.length})\n\n${blocks}`;
      }
      message += `\n\n${DIV}`;
      message += `\n✅ Recebido:     ${formatCurrencyBR(totalReceived)}`;
      message += `\n⏳ Pendente:     ${formatCurrencyBR(totalPending)}`;
      message += `\n💰 *Total geral: ${formatCurrencyBR(totalReceipts)}*`;
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

    let message = `📊 *Pagamentos*\n📅 _${periodLabel}_`;
    if (!paid.length) {
      message += "\n\n✅ Nenhum pagamento confirmado no período.";
      if (pending.length) {
        const blocks = pending.map((row) => formatEntryBlock(row)).join("\n\n");
        message += `\n\n⏳ *Pendentes* (${pending.length})\n\n${blocks}`;
        message += `\n\n${DIV}`;
        message += `\n⏳ Pendente: ${formatCurrencyBR(totalPending)}`;
      }
      await sendText(fromRaw, message);
      return;
    }
    const paidBlocks = paid.map((row) => formatEntryBlock(row)).join("\n\n");
    message += `\n\n✅ *Pagas* (${paid.length})\n\n${paidBlocks}`;
    if (pending.length) {
      const pendingBlocks = pending.map((row) => formatEntryBlock(row)).join("\n\n");
      message += `\n\n⏳ *Pendentes* (${pending.length})\n\n${pendingBlocks}`;
    }
    message += `\n\n${DIV}`;
    message += `\n✅ Pago:         ${formatCurrencyBR(totalPaid)}`;
    if (pending.length) {
      message += `\n⏳ Pendente:     ${formatCurrencyBR(totalPending)}`;
    }
    message += `\n💰 *Total geral: ${formatCurrencyBR(totalPaid + totalPending)}*`;
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
    const totalPendingReceipts = sumValues(pendingReceipts);
    const totalReceipts = sumValues(receipts);
    const totalPaid = sumValues(paidExpenses);
    const totalPendingExpenses = sumValues(pendingExpenses);
    const totalExpenses = sumValues(expenses);

    let message = `📊 *Relatório Completo*\n📅 _${periodLabel}_`;
    if (!receipts.length && !expenses.length) {
      message += "\n\n✅ Nenhum lançamento encontrado para o período selecionado.";
    } else {
      if (receipts.length) {
        message += `\n\n${DIV}`;
        message += `\n💵 *Recebimentos* (${receipts.length} lançamento${receipts.length > 1 ? "s" : ""})`;
        message += `\n${formatCategoryLines(receipts)}`;
        message += `\n💵 Recebido: ${formatCurrencyBR(totalReceived)}  |  ⏳ Pendente: ${formatCurrencyBR(totalPendingReceipts)}`;
      }
      if (expenses.length) {
        message += `\n\n${DIV}`;
        message += `\n💸 *Contas a Pagar* (${expenses.length} lançamento${expenses.length > 1 ? "s" : ""})`;
        message += `\n${formatCategoryLines(expenses)}`;
        message += `\n✅ Pago: ${formatCurrencyBR(totalPaid)}  |  ⏳ Pendente: ${formatCurrencyBR(totalPendingExpenses)}`;
      }
      message += `\n\n${DIV}`;
      message += `\n📈 *Resumo*`;
      message += `\n💵 Entradas: ${formatCurrencyBR(totalReceipts)}`;
      message += `\n💸 Saídas:   ${formatCurrencyBR(totalExpenses)}`;
      message += `\n${formatSaldoLine(totalReceived, totalPaid)}`;
    }
    await sendText(fromRaw, message);
  }
}

async function showLancamentos(fromRaw, userNorm, range) {
  const rows = await allRowsForUser(userNorm);
  const filtered = withinPeriod(rows, range.start, range.end)
    .filter((row) => toNumber(getVal(row, "valor")) > 0)
    .sort((a, b) => (getEffectiveDate(a)?.getTime() || 0) - (getEffectiveDate(b)?.getTime() || 0));
  if (!filtered.length) {
    await sendText(fromRaw, "✅ Nenhum lançamento encontrado para o período selecionado.");
    return;
  }
  const blocks = filtered.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  const message = `🧾 *Meus lançamentos*\n\n${blocks.join("\n\n")}`;
  await sendText(fromRaw, message);
}

async function sendReceberHint(fromRaw, userNorm) {
  const rows = await allRowsForUser(userNorm);
  const count = rows.filter(
    (row) =>
      getVal(row, "tipo") === "conta_receber" &&
      !["recebido", "pago"].includes(getVal(row, "status"))
  ).length;
  if (count > 0) {
    await sendText(
      fromRaw,
      `💵 Você também tem *${count} recebimento${count === 1 ? "" : "s"} pendente${count === 1 ? "" : "s"}*.\n\nAcesse _Contas a receber_ no menu para confirmar.`
    );
  }
}

async function listPendingPayments(fromRaw, userNorm) {
  const rows = await allRowsForUser(userNorm);
  const pending = rows.filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") !== "pago");
  if (!pending.length) {
    await sendText(fromRaw, "🎉 Você não possui contas pendentes no momento!");
    return;
  }
  const blocks = pending.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  const total = pending.reduce((sum, row) => sum + toNumber(getVal(row, "valor")), 0);
  const totalLine = total > 0 ? `\n💸 *Total: ${formatCurrencyBR(total)}*` : "";
  const message =
    `📋 *Contas a pagar pendentes* (${pending.length})${totalLine}\n\n${blocks.join("\n\n")}` +
    `\n\n✅ Digite o número para confirmar. Ex: *1* ou *1,2,3*`;
  sessionPayConfirm.delete(userNorm);
  setPayState(userNorm, {
    awaiting: "index",
    rows: pending,
    queue: [],
    currentIndex: 0,
    currentRowId: null,
    tipo: "pagar",
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await sendText(fromRaw, message);
}

async function listPendingReceipts(fromRaw, userNorm) {
  const rows = await allRowsForUser(userNorm);
  const pending = rows.filter(
    (row) =>
      getVal(row, "tipo") === "conta_receber" &&
      !["recebido", "pago"].includes(getVal(row, "status"))
  );
  if (!pending.length) {
    await sendText(fromRaw, "🎉 Você não possui recebimentos pendentes no momento!");
    return;
  }
  const blocks = pending.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  const total = pending.reduce((sum, row) => sum + toNumber(getVal(row, "valor")), 0);
  const totalLine = total > 0 ? `\n💵 *Total: ${formatCurrencyBR(total)}*` : "";
  const message =
    `📋 *Contas a receber pendentes* (${pending.length})${totalLine}\n\n${blocks.join("\n\n")}` +
    `\n\n✅ Digite o número para confirmar. Ex: *1* ou *1,2,3*`;
  sessionPayConfirm.delete(userNorm);
  setPayState(userNorm, {
    awaiting: "index",
    rows: pending,
    queue: [],
    currentIndex: 0,
    currentRowId: null,
    tipo: "receber",
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await sendText(fromRaw, message);
}

async function listRowsForSelection(fromRaw, userNorm, mode) {
  const rows = await allRowsForUser(userNorm);
  const sorted = rows
    .slice()
    .sort((a, b) => (getEffectiveDate(b)?.getTime() || 0) - (getEffectiveDate(a)?.getTime() || 0))
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

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

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
    resetSession(userNorm);
    await sendCancelMessage(fromRaw, { reason: "timeout" });
    return true;
  }
  if (!confirmed) {
    resetSession(userNorm);
    await sendCancelMessage(fromRaw);
    return true;
  }
  const currentIndex = state.currentIndex || 0;
  const currentItem = state.queue?.[currentIndex];
  if (!currentItem || !currentItem.row) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Nenhum lançamento selecionado para excluir.");
    return true;
  }

  // Tenta excluir com tratamento de erro
  try {
    await deleteRow(currentItem.row);

    // Mensagem de sucesso
    const totalQueue = state.queue?.length || 0;
    const isLast = (currentIndex + 1) >= totalQueue;

    if (totalQueue === 1 || isLast) {
      await sendText(fromRaw, "🗑 Lançamento excluído com sucesso!");
    } else {
      // Se tem mais, envia mensagem compacta
      await sendText(fromRaw, `🗑 Excluído (${currentIndex + 1}/${totalQueue})`);
    }

    // Pequeno delay para evitar rate limit em exclusões múltiplas
    if (!isLast && totalQueue > 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error("[Delete] Erro ao excluir lançamento:", error.message);
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, `❌ Erro ao excluir lançamento. Tente novamente.\n\nDetalhes: ${error.message}`);
    return true;
  }

  const nextIndex = currentIndex + 1;
  if (!state.queue || nextIndex >= state.queue.length) {
    sessionDelete.delete(userNorm);

    // Mensagem final consolidada para múltiplas exclusões
    if (state.queue?.length > 1) {
      await sendText(fromRaw, `✅ ${state.queue.length} lançamentos excluídos com sucesso!\n\n💡 Envie *Meus lançamentos* para ver a lista atualizada.`);
    }
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
    resetSession(userNorm);
    await sendCancelMessage(fromRaw, { reason: "timeout" });
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
    const input = normalizeDiacritics(text.trim()).toLowerCase();
    if (/^cancelar/.test(input)) {
      resetSession(userNorm);
      await sendCancelMessage(fromRaw);
      return true;
    }

    if (/^(exclu[ií]|delet|apag|remov)/.test(input)) {
      try {
        await deleteRow(state.row);
        resetSession(userNorm);
        await sendText(fromRaw, "🗑️ Lançamento excluído com sucesso.");
        await sendMainMenu(fromRaw);
      } catch (err) {
        console.error("[Edit→Delete] Erro:", err.message);
        await sendText(fromRaw, "Não consegui excluir agora. Tente novamente.");
      }
      return true;
    }

    const valid = ["conta", "descricao", "valor", "data", "status", "categoria"];
    const fieldAliases = {
      descricao: "descricao", descrição: "descricao", desc: "descricao",
      valor: "valor", preço: "valor", preco: "valor", price: "valor",
      data: "data", vencimento: "data", date: "data",
      status: "status", situacao: "status", situação: "status",
      categoria: "categoria", cat: "categoria",
      conta: "conta", nome: "conta",
    };

    const words = input.split(/\s+/);
    const firstWord = words[0];
    const resolvedField = fieldAliases[firstWord] || (valid.includes(firstWord) ? firstWord : null);

    if (resolvedField && words.length > 1) {
      const inlineValue = text.trim().slice(text.trim().indexOf(" ") + 1).trim();
      sessionEdit.set(userNorm, {
        ...state,
        awaiting: "value",
        field: resolvedField,
        expiresAt: Date.now() + SESSION_TIMEOUT_MS,
      });
      return handleEditFlow(fromRaw, userNorm, inlineValue);
    }

    const field = resolvedField || fieldAliases[input];
    if (!field) {
      await sendText(fromRaw, `Campo inválido. Escolha um dos campos:\n\n🏷 *conta*\n📝 *descrição*\n💰 *valor*\n📅 *data*\n📌 *status*\n📂 *categoria*`);
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
      resetSession(userNorm);
      await sendCancelMessage(fromRaw);
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
      const detected = await resolveCategory(categoria, getVal(row, "tipo"), userNorm);
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
    resetSession(userNorm);
    await sendCancelMessage(fromRaw, { reason: "timeout" });
    return true;
  }
  const trimmed = (text || "").trim();
  if (!trimmed) {
    await sendText(fromRaw, "Envie os detalhes da conta fixa ou escreva cancelar.");
    return true;
  }
  if (/^cancelar/i.test(trimmed)) {
    resetSession(userNorm);
    await sendCancelMessage(fromRaw);
    return true;
  }

  const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const results = [];
  const failures = [];
  for (const line of lines) {
    const parsed = parseFixedAccountCommand(line);
    if (parsed) {
      results.push({ line, parsed });
    } else if (lines.length > 1) {
      failures.push(line);
    }
  }

  if (!results.length) {
    const parsed = parseFixedAccountCommand(text);
    if (parsed) {
      sessionFixedRegister.delete(userNorm);
      await registerFixedAccount(fromRaw, userNorm, parsed);
      return true;
    }
    await sendText(
      fromRaw,
      "Não consegui entender. Informe algo como \"Internet 120 todo dia 05\" ou \"Aluguel 150 a cada 15 dias\".\n\n💡 Para cadastrar várias de uma vez, envie uma por linha."
    );
    sessionFixedRegister.set(userNorm, { expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    return true;
  }

  sessionFixedRegister.delete(userNorm);
  for (const { parsed } of results) {
    await registerFixedAccount(fromRaw, userNorm, parsed);
  }
  if (results.length > 1) {
    await sendText(fromRaw, `✅ ${results.length} contas fixas cadastradas com sucesso!`);
  }
  if (failures.length) {
    await sendText(fromRaw, `⚠️ Não consegui entender ${failures.length} linha(s):\n${failures.map((f) => `• ${f}`).join("\n")}\n\nEnvie no formato: Descrição Valor todo dia X`);
  }
  return true;
}

async function handleDeleteFlow(fromRaw, userNorm, text) {
  const state = sessionDelete.get(userNorm);
  if (!state) return false;
  if (deleteStateExpired(state)) {
    resetSession(userNorm);
    await sendCancelMessage(fromRaw, { reason: "timeout" });
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

async function sendStatusConfirmationPrompt(to, tipo) {
  const isReceber = tipo === "conta_receber";
  const pergunta = isReceber
    ? "Esse valor já foi recebido ou ainda está pendente?"
    : "Esse lançamento já foi pago ou ainda está pendente?";
  const btnConfirm = isReceber ? "✓ Recebido" : "✓ Pago";
  const fallbackResp = isReceber ? "*recebido* ou *pendente*" : "*pago* ou *pendente*";

  const success = await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: pergunta },
      action: {
        buttons: [
          { type: "reply", reply: { id: "REG:STATUS:PAGO", title: btnConfirm } },
          { type: "reply", reply: { id: "REG:STATUS:PENDENTE", title: "⏳ Pendente" } },
        ],
      },
    },
  });

  // FALLBACK: Se botões interativos falharem, usar mensagem texto
  if (!success || success.skipped) {
    console.error("⚠️ [Status] Falha ao enviar botões interativos para", to);
    await sendText(to, `${pergunta}\n\nResponda: ${fallbackResp}`, { bypassWindow: true });
  }
}

const sendRegistrationEditPrompt = async (to, rowId, statusLabel) => {
  if (!rowId) return;
  const success = await sendWA({
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

  // FALLBACK: Se botões interativos falharem, pular edição e continuar
  if (!success || success.skipped) {
    console.error("⚠️ [Edit] Falha ao enviar prompt de edição para", to);
    // Não enviar texto alternativo aqui - edição é opcional
  }
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
  const success = await sendWA({
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

  // FALLBACK: Se botões interativos falharem, pular código de pagamento
  if (!success || success.skipped) {
    console.error("⚠️ [PayCode] Falha ao enviar prompt de código para", to);
    // Limpar sessão já que não podemos continuar
    sessionPaymentCode.delete(userNorm);
  }
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
      userNorm,
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
    data: nextDue,
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
  const isReceber = state?.tipo === "receber";
  const confirmTitle = isReceber ? "✅ Recebido" : "✅ Pago";
  const buttons = [{ type: "reply", reply: { id: `PAY:MARK:${rowId}`, title: confirmTitle } }];
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
  const actionLabel = isReceber ? "recebimento" : "pagamento";
  const statusLabel = isReceber ? "recebido" : "pago";
  const body = `✅ Confirmar ${actionLabel}?\n\n${summary}\n\nDeseja marcar como ${statusLabel} agora?`;
  const success = await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: { buttons },
    },
  });

  // FALLBACK: Se botões interativos falharem, enviar mensagem texto
  if (!success || success.skipped) {
    console.error("⚠️ [PayConfirm] Falha ao enviar prompt de confirmação para", to);
    await sendText(to, body + "\n\nResponda: *sim* para confirmar ou *cancelar*", {
      bypassWindow: true,
    });
  }
}

const findRecentDuplicate = async (userNorm, payload) => {
  const allRows = await allRowsForUser(userNorm);
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const targetDesc = normalizeDiacritics((payload.descricao || "").trim()).toLowerCase();
  const targetValue = Number(payload.valor) || 0;
  if (!targetDesc || !targetValue) return null;
  return allRows.find((row) => {
    const ts = new Date(getVal(row, "timestamp")).getTime();
    if (!ts || ts < cutoff) return false;
    const rowDesc = normalizeDiacritics((getVal(row, "descricao") || "").trim()).toLowerCase();
    const rowValue = Number(getVal(row, "valor")) || 0;
    return rowDesc === targetDesc && Math.abs(rowValue - targetValue) < 0.01;
  });
};

async function finalizeRegisterEntry(fromRaw, userNorm, entry, options = {}) {
  const statusSource = options.statusSource || "auto";

  if (!options.skipDuplicateCheck) {
    try {
      const dup = await findRecentDuplicate(userNorm, entry);
      if (dup) {
        sessionDuplicateConfirm.set(userNorm, {
          entry,
          options,
          expiresAt: Date.now() + SESSION_TIMEOUT_MS,
        });
        const valor = formatCurrencyBR(entry.valor);
        await sendWA({
          messaging_product: "whatsapp",
          to: fromRaw,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: `⚠️ Já registrei *${entry.descricao}* de *${valor}* nas últimas 2h. Deseja registrar de novo?` },
            action: {
              buttons: [
                { type: "reply", reply: { id: "DUP:CONFIRM", title: "✅ Sim, registrar" } },
                { type: "reply", reply: { id: "DUP:CANCEL", title: "❌ Cancelar" } },
              ],
            },
          },
        });
        return;
      }
    } catch (err) {
      console.error("[Duplicate check] Erro:", err.message);
    }
  }

  await createRow(entry);
  const resumo = formatEntrySummary(entry);
  const statusLabel = statusIconLabel(entry.status);
  if (entry.tipo === "conta_receber") {
    const categoryInfo = getCategoryInfo(entry.categoria);
    let message = `💵 *Recebimento Registrado!*

💰 *Valor*: ${formatCurrencyBR(entry.valor)}

${categoryInfo.emoji} *Categoria*: ${categoryInfo.label}

🏷️ *Descrição*: ${entry.descricao}

📅 *Data*: ${formatBRDate(entry.vencimento_iso)}

${entry.status === "recebido" ? "✓" : "⏳"} *Status*: ${statusLabel}

💡 Lançamento adicionado!`;
    // Removido: status será informado apenas em sendRegistrationEditPrompt para evitar duplicação
    await sendText(fromRaw, message);
  } else {
    const categoryInfo = getCategoryInfo(entry.categoria);
    let message = `✅ *Pagamento Registrado!*

💸 *Valor*: ${formatCurrencyBR(entry.valor)}

${categoryInfo.emoji} *Categoria*: ${categoryInfo.label}

🏷️ *Descrição*: ${entry.descricao}

📅 *Vencimento*: ${formatBRDate(entry.vencimento_iso)}

${entry.status === "pago" ? "✓" : "⏳"} *Status*: ${statusLabel}

💡 Lançamento adicionado!`;
    // Removido: status será informado apenas em sendRegistrationEditPrompt para evitar duplicação
    await sendText(fromRaw, message);
  }

  // Guarda rowId para correção rápida (digitando "errado" logo após o registro)
  sessionLastRegistered.set(userNorm, {
    rowId: entry.row_id,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });

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
    resetSession(userNorm);
    await sendCancelMessage(fromRaw, { reason: "timeout" });
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
  await finalizeRegisterEntry(fromRaw, userNorm, entry, { statusSource: "user_confirm", autoStatus: true });
}

async function handleStatusConfirmationFlow(fromRaw, userNorm, text) {
  const state = sessionStatusConfirm.get(userNorm);
  if (!state) return false;
  if (statusStateExpired(state)) {
    resetSession(userNorm);
    await sendCancelMessage(fromRaw, { reason: "timeout" });
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
  // Fix: tornar regex mais robusta para capturar "pendente" e variações com espaços
  if (/\b(pendente|a\s+pagar|pagar|em\s+aberto)\b/.test(normalized)) {
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
    resetSession(userNorm);
    await sendCancelMessage(fromRaw, { reason: "timeout" });
    return true;
  }
  if (state.awaiting !== "input") return false;
  const code = text.trim();
  if (!code) {
    await sendText(fromRaw, "Não entendi o código. Envie novamente ou escreva cancelar.");
    return true;
  }
  if (/^cancelar/i.test(code)) {
    resetSession(userNorm);
    await sendCancelMessage(fromRaw);
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
    resetSession(userNorm);
    await sendCancelMessage(fromRaw, { reason: "timeout" });
    return true;
  }
  const normalizedText = normalizeDiacritics(text).toLowerCase().trim();
  if (state.awaiting === "index") {
    if (/cancel/.test(normalizedText)) {
      resetSession(userNorm);
      await sendCancelMessage(fromRaw);
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
    if (/pago|recebido|confirm/.test(normalizedText)) {
      const current = state.queue?.[state.currentIndex || 0];
      if (!current || !current.row) {
        sessionPayConfirm.delete(userNorm);
        return true;
      }
      await markPaymentAsPaid(fromRaw, userNorm, current.row);
      return true;
    }
    if (/cancel/.test(normalizedText)) {
      resetSession(userNorm);
      await sendCancelMessage(fromRaw);
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
    const noCodeSent = await sendText(to, "Não há código salvo para este lançamento.");
    if (!noCodeSent || noCodeSent.skipped) {
      console.error("⚠️ [PayCode] Falha ao enviar mensagem de código ausente para", to);
    }
    return;
  }
  const metodo = (getVal(row, "tipo_pagamento") || "").toLowerCase();
  const label = metodo === "boleto" ? "código de barras" : "chave Pix";
  const sent = await sendText(to, `📎 Aqui está o ${label}:\n${code}`);
  if (!sent || sent.skipped) {
    console.error("⚠️ [PayCode] Falha ao enviar código de pagamento para", to);
    // Tentar com bypassWindow se falhar
    await sendText(to, `📎 Aqui está o ${label}:\n${code}`, { bypassWindow: true });
  }
}

async function markPaymentAsPaid(fromRaw, userNorm, row) {
  if (!row) return;
  const state = sessionPayConfirm.get(userNorm);
  const isReceber = state?.tipo === "receber";
  const newStatus = isReceber ? "recebido" : "pago";
  const successMsg = isReceber ? "✅ Recebimento confirmado com sucesso!" : "✅ Pagamento confirmado com sucesso!";
  setVal(row, "status", newStatus);
  setVal(row, "timestamp", new Date().toISOString());
  await saveRow(row);
  await sendText(fromRaw, `${successMsg}\n\n${formatEntrySummary(row)}`);
  await scheduleNextFixedOccurrence(row);
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
  const categoria = await resolveCategory(parsed.descricao, parsed.tipo, userNorm);
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
    data: data,
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
    await sendStatusConfirmationPrompt(fromRaw, parsed.tipo);
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

  const normalized = normalizeDiacritics(original).toLowerCase();

  const removalPatterns = [];
  const addRemoval = (match) => {
    if (match && match[0]) removalPatterns.push(match[0]);
  };

  // Primeiro detecta a recorrência
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

  // Detecta parcelamentos ANTES de extrair valor (ex: "4 parcelas de 127", "3x de 50")
  let installmentCount = null;
  let installmentValue = null;
  const installmentPatterns = [
    /(\d+)\s*(?:parcelas?|vezes|x)\s*(?:de\s+)?(?:R\$\s*)?(\d+(?:[.,]\d+)?)/i,
    /(?:parcelar|parcelado)\s*(?:em\s+)?(\d+)\s*(?:vezes|x)?\s*(?:de\s+)?(?:R\$\s*)?(\d+(?:[.,]\d+)?)/i,
  ];
  for (const pat of installmentPatterns) {
    const m = normalized.match(pat);
    if (m) {
      installmentCount = Number(m[1]);
      installmentValue = parseFloat(m[2].replace(",", "."));
      break;
    }
  }

  // Remove padrões de recorrência ANTES de extrair o valor
  let cleanedText = original;
  removalPatterns.forEach((pattern) => {
    if (!pattern) return;
    const regex = new RegExp(escapeRegex(pattern), "gi");
    cleanedText = cleanedText.replace(regex, " ");
  });
  cleanedText = cleanedText
    .replace(/todo\s+dia\s+\d{1,2}/gi, " ")
    .replace(/\btodo\s+dia\b/gi, " ")
    .replace(/\bdia\s+\d{1,2}\b/gi, " ")
    .replace(/a\s+cada\s+\d+\s+dias?/gi, " ")
    .replace(/a\s+cada\s+\d+\s+semanas?/gi, " ")
    .replace(/\bmensal\b/gi, " ")
    .replace(/\bsemanal\b/gi, " ")
    .replace(/\bquinzenal\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Agora extrai o valor do texto limpo
  const amountInfo = installmentValue
    ? { amount: installmentValue, raw: String(installmentValue) }
    : extractAmountFromText(cleanedText);
  if (!amountInfo.amount) return null;

  const dateMatch = original.match(new RegExp(`(daqui\\s+a?\\s*\\d+\\s*dias?|hoje|amanh[ãa]|ontem|${DATE_TOKEN_PATTERN})`, "i"));
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

  // Limpa a descrição (já tem recorrência removida do cleanedText)
  let descricao = cleanedText;
  if (amountInfo.raw) {
    const rawRegex = new RegExp(escapeRegex(amountInfo.raw), "gi");
    descricao = descricao.replace(rawRegex, " ");
  }
  if (dateMatch && dateMatch[1]) {
    const dateRegex = new RegExp(escapeRegex(dateMatch[1]), "i");
    descricao = descricao.replace(dateRegex, " ");
  }
  descricao = descricao
    .replace(/\d+\s*(?:parcelas?|vezes|x)\s*(?:de\s+)?(?:R\$\s*)?\d+(?:[.,]\d+)?/gi, " ")
    .replace(/(?:parcelar|parcelado)\s*(?:em\s+)?\d+\s*(?:vezes|x)?\s*(?:de\s+)?(?:R\$\s*)?\d+(?:[.,]\d+)?/gi, " ")
    .replace(/conta\s+fixa/gi, " ")
    .replace(/\bfixa\b/gi, " ")
    .replace(/\brecorrente\b/gi, " ")
    .replace(/\bpagar\b/gi, " ")
    .replace(/\btodo\b/gi, " ")
    .replace(/\bdia\b/gi, " ")
    .replace(/\bcada\b/gi, " ")
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
    installmentCount: installmentCount && installmentCount > 1 ? installmentCount : null,
  };
};

async function registerFixedAccount(fromRaw, userNorm, parsed) {
  if (!parsed) return;
  const categoria = await resolveCategory(parsed.descricao, "conta_pagar", userNorm);
  const parentId = generateRowId();
  const due = parsed.dueDate instanceof Date ? parsed.dueDate : new Date();
  const count = parsed.installmentCount || 1;
  const isInstallment = count > 1;

  for (let i = 0; i < count; i++) {
    const installmentDue = i === 0 ? due : addMonthsSafe(due, i);
    if (!installmentDue) continue;
    const rowId = i === 0 ? parentId : generateRowId();
    const descWithInstallment = isInstallment
      ? `${parsed.descricao} (${i + 1}/${count})`
      : parsed.descricao;
    const payload = {
      row_id: rowId,
      timestamp: new Date().toISOString(),
      user: userNorm,
      user_raw: fromRaw,
      tipo: "conta_pagar",
      conta: descWithInstallment,
      valor: parsed.valor,
      vencimento_iso: installmentDue.toISOString(),
      vencimento_br: formatBRDate(installmentDue),
      data: installmentDue,
      tipo_pagamento: parsed.tipoPagamento || "",
      codigo_pagamento: "",
      status: "pendente",
      fixa: isInstallment ? "nao" : "sim",
      fix_parent_id: isInstallment ? "" : parentId,
      vencimento_dia: installmentDue.getDate(),
      categoria: categoria.slug,
      categoria_emoji: categoria.emoji,
      descricao: descWithInstallment,
      recorrencia_tipo: isInstallment ? "" : (parsed.recurrence.type || ""),
      recorrencia_valor: isInstallment ? "" : (parsed.recurrence.value?.toString() || ""),
    };
    await createRow(payload);
  }

  const categoryInfo = getCategoryInfo(categoria.slug);

  if (isInstallment) {
    const lastDue = addMonthsSafe(due, count - 1);
    const totalValue = parsed.valor * count;
    let message = `🔢 *Parcelamento Cadastrado!*

💸 *Valor da parcela*: ${formatCurrencyBR(parsed.valor)}
📊 *Total*: ${count}x de ${formatCurrencyBR(parsed.valor)} = ${formatCurrencyBR(totalValue)}

${categoryInfo.emoji} *Categoria*: ${categoryInfo.label}

🏷️ *Descrição*: ${parsed.descricao}

📅 *Primeira parcela*: ${formatBRDate(due)}
📅 *Última parcela*: ${lastDue ? formatBRDate(lastDue) : "—"}

💡 Todas as ${count} parcelas foram criadas como contas a pagar!`;
    await sendText(fromRaw, message);
  } else {
    const recurrenceLabel = describeRecurrence({
      fixa: "sim",
      recorrencia_tipo: parsed.recurrence.type,
      recorrencia_valor: parsed.recurrence.value?.toString() || "",
    });
    let message = `♻️ *Conta Fixa Cadastrada!*

💸 *Valor*: ${formatCurrencyBR(parsed.valor)}

${categoryInfo.emoji} *Categoria*: ${categoryInfo.label}

🏷️ *Descrição*: ${parsed.descricao}

📅 *Próximo Vencimento*: ${formatBRDate(due)}

🔄 *Recorrência*: ${recurrenceLabel}

💡 A próxima cobrança será gerada automaticamente!`;
    await sendText(fromRaw, message);
    if (["pix", "boleto"].includes((parsed.tipoPagamento || "").toLowerCase())) {
      await promptAttachPaymentCode(fromRaw, userNorm, {
        row_id: parentId, categoria: categoria.slug,
      }, "fixed_register");
    }
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
  "ajuda_parcelamento",
  "desconhecido",
]);

const detectIntentHeuristic = (text) => {
  const lower = (text || "").toLowerCase();
  const normalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/(oi|ola|opa|bom dia|boa tarde|boa noite)/.test(normalized)) return "boas_vindas";
  if (/^(abrir\s+)?menu$/.test(normalized.replace(/\s+/g, " ").trim())) return "mostrar_menu";
  // Parcelamento — resposta educativa
  if (/parcela(mento|s?)|prestac(ao|oes)|em\s+\d+\s+vezes?|parcelad/.test(normalized)) return "ajuda_parcelamento";
  // Relatório completo / saldo / balanço
  if (/saldo|balanco|quanto tenho|quanto sobrou|quanto estou|meu dinheiro|minha situac|situacao financeira|resumo (geral|do mes)|balanco do mes/.test(normalized)) return "relatorio_completo";
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
  // Vencimentos próximos
  if (/\bvenc(e|er|imento|imentos)\b|o que (devo|falta pagar)|proximas? contas?/.test(normalized)) return "listar_pendentes";
  if (/contas?\s+fixas?/.test(lower)) return "contas_fixas";
  if (/editar lan[cç]amentos?/.test(lower)) return "editar";
  if (/excluir lan[cç]amentos?/.test(lower)) return "excluir";
  // Registrar recebimento — formas naturais
  if (/\b(recebi|ganhei|vendi|entrou|me pagaram|me transferiram|deposito recebido|pix recebido)\b/.test(normalized)) return "registrar_recebimento";
  if (/registrar recebimento|\brecebimento\b/.test(lower)) return "registrar_recebimento";
  // Registrar pagamento — formas naturais
  if (/\b(paguei|gastei|comprei|transferi|mandei pix|fiz compra|debito|boleto pago)\b/.test(normalized)) return "registrar_pagamento";
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
          type: "input_text",
          text: `Você é um assistente de IA especializado em detectar intenções de mensagens financeiras no WhatsApp.

🎯 OBJETIVO: Classificar a mensagem do usuário em UMA das intenções disponíveis.

⚠️ REGRAS IMPORTANTES:
1. Responda APENAS com o slug da intenção (ex: "registrar_pagamento")
2. Seja MUITO flexível - usuários falam naturalmente, não seguem scripts
3. Entenda contexto e sinônimos (ex: "comprei" = "paguei" = "gastei")
4. Para valores numéricos, sempre prefira "registrar_pagamento" ou "registrar_recebimento"
5. Use "desconhecido" SOMENTE se realmente não souber

📊 CATEGORIAS PRINCIPAIS:

🔹 REGISTROS (maior prioridade quando há valor):
   • registrar_pagamento: "paguei 50", "gastei 100", "comprei X por Y"
   • registrar_recebimento: "recebi 200", "vendi por 150", "ganhei X"

🔹 RELATÓRIOS:
   • relatorio_pagamentos_mes: "quanto gastei", "meus gastos este mês"
   • relatorio_recebimentos_mes: "quanto recebi", "minhas entradas"
   • relatorio_contas_pagar_mes: "contas pendentes", "o que devo"
   • relatorio_completo: "resumo geral", "balanço do mês"

🔹 LISTAGENS:
   • listar_pendentes: "mostrar pendentes", "o que vence"
   • listar_lancamentos: "meus lançamentos", "histórico"

🔹 AÇÕES:
   • editar: "editar lançamento", "alterar registro"
   • excluir: "excluir lançamento", "apagar registro"
   • contas_fixas: "contas fixas", "cadastrar conta fixa"
   • ajuda_parcelamento: "como parcelar", "lançar em parcelas", "em X vezes", "como funciona parcelamento"

🔹 RELATÓRIO COMPLETO / SALDO:
   • relatorio_completo: "saldo", "balanço", "quanto tenho", "quanto sobrou", "resumo", "situação financeira"

🔹 NAVEGAÇÃO:
   • boas_vindas: "oi", "olá", "bom dia"
   • mostrar_menu: "menu", "opções"
   • relatorios_menu: "relatórios", "ver relatórios"

✨ DICA: Se houver VALOR MONETÁRIO na mensagem, sempre priorize "registrar_pagamento" ou "registrar_recebimento"!`,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Opções válidas: ${options}

Mensagem do usuário: "${text}"

Responda SOMENTE com o slug da intenção mais adequada.`,
        },
      ],
    },
  ];
};

// ============================
// Classificação de mensagem de usuário inativo (sem plano ativo)
// ============================

const classifyInactiveHeuristic = (text) => {
  const lower = (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (
    /ja paguei|ja assinei|ja assine|ja tenho|ja contratei|ja fiz o pagamento|pagamento recusado|pagamento nao aprovado|cartao recusado|nao consigo acessar|nao consigo usar|nao ta funcionando|nao esta funcionando|nao funciona|por que nao funciona|ja tenho plano|meu plano|minha assinatura/.test(lower)
  ) return "acredita_que_pagou";
  if (
    /quero assinar|como assinar|quero contratar|quanto custa|valor(es)?|planos?|assinar|contratar|quero comecar/.test(lower)
  ) return "quer_assinar";
  return "outro";
};

const buildInactiveUserPrompt = (text) => [
  {
    role: "system",
    content:
      `Você é um classificador de mensagens de um chatbot financeiro chamado FinPlanner IA. ` +
      `Um usuário enviou uma mensagem mas não tem plano ativo. Classifique a mensagem em uma das categorias:\n\n` +
      `- "acredita_que_pagou": o usuário diz que já pagou, já assinou, já tem plano, teve problema no pagamento, não consegue acessar mesmo tendo pago, etc.\n` +
      `- "quer_assinar": o usuário quer saber como assinar, quanto custa, quer contratar o serviço.\n` +
      `- "outro": qualquer outro caso (saudação genérica, confusão, etc.)\n\n` +
      `Responda APENAS com uma das palavras: acredita_que_pagou, quer_assinar, outro`,
  },
  { role: "user", content: text || "" },
];

const classifyInactiveUserMessage = async (text) => {
  const heuristic = classifyInactiveHeuristic(text);
  if (heuristic !== "outro") return heuristic;
  if (!openaiClient || !text) return heuristic;
  try {
    const output = await callOpenAI({
      model: OPENAI_INTENT_MODEL,
      input: buildInactiveUserPrompt(text),
      temperature: 0,
      maxOutputTokens: 20,
    });
    const normalized = (output || "").toLowerCase().trim();
    if (["acredita_que_pagou", "quer_assinar", "outro"].includes(normalized)) return normalized;
  } catch (err) {
    console.error("[OpenAI] Erro ao classificar usuário inativo:", err?.message || err);
  }
  return heuristic;
};

const buildInactiveUserResponse = (classification, nome) => {
  const saudacao = nome ? `Olá, ${nome}!` : "Olá!";
  const site = "www.finplanneria.com.br";

  if (classification === "acredita_que_pagou") {
    return (
      `${saudacao} Entendi que você realizou um pagamento, mas não encontrei uma assinatura ativa vinculada ao seu número. 😕\n\n` +
      `Isso pode acontecer por alguns motivos:\n` +
      `• *Pagamento não aprovado* – O cartão pode ter sido recusado. Verifique seu e-mail para uma mensagem da Stripe.\n` +
      `• *Número diferente* – O pagamento pode ter sido feito com outro número de WhatsApp.\n` +
      `• *Processamento em andamento* – Em alguns casos pode levar alguns minutos.\n\n` +
      `Ou refaça o checkout em:\n👉 ${site}`
    );
  }

  if (classification === "quer_assinar") {
    return (
      `${saudacao} Para acessar todos os recursos da FinPlanner IA, conheça nossos planos e assine em:\n👉 ${site}`
    );
  }

  // "outro" — mensagem padrão
  return (
    `${saudacao} Eu sou a FinPlanner IA. Para usar os recursos, você precisa de um plano ativo.\n\n` +
    `Conheça e contrate em:\n👉 ${site}`
  );
};

const sendSupportButton = (to) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: "Dúvidas? Fale conosco." },
      action: {
        name: "cta_url",
        parameters: {
          display_text: "Falar com suporte",
          url: `https://wa.me/${SUPPORT_NUMBER}`,
        },
      },
    },
  });

// ============================

const detectIntent = async (text) => {
  const heuristic = detectIntentHeuristic(text);
  if (!text) return heuristic;
  if (!openaiClient) return heuristic;
  // Early return: se a heurística já identificou uma intenção específica (não "desconhecido"),
  // não precisamos chamar a OpenAI — economiza 1-3s por mensagem simples
  if (heuristic !== "desconhecido") return heuristic;
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
  return heuristic;
};

// ============================
// Webhook
// ============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] || "").trim();
  const challenge = req.query["hub.challenge"];
  console.log("[WEBHOOK_VERIFY]", { mode, ok: mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN });
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

async function handleInteractiveMessage(from, payload) {
  const { type } = payload;
  const userNorm = normalizeUser(from);
  await persistLastInteraction(userNorm);
  const interactionInfo = getLastInteractionInfo(userNorm);
  console.log("📩 Inbound interactive:", {
    fromRaw: from,
    userNorm,
    canonicalUserId: interactionInfo.canonicalUserId,
    storedLastInteractionISO: interactionInfo.lastIso,
  });
  // Salvar interação no log (não-bloqueante)
  const buttonId = payload.button_reply?.id || payload.button_reply?.payload || "";
  const buttonTitle = payload.button_reply?.title || payload.list_reply?.title || "";
  saveMessageToLog(from, userNorm, "interactive", "", buttonId, buttonTitle).catch(err =>
    console.error("Log save failed:", err.message)
  );
  recordUserInteraction(userNorm);

  // 🔒 VALIDAÇÃO DE ACESSO: Bloqueia usuários não ativos
  if (!isAdminUser(userNorm)) {
    const active = await isUsuarioAtivo(userNorm);
    if (!active) {
      const nome = getStoredFirstName(userNorm);
      const response = buildInactiveUserResponse("outro", nome);
      await sendText(from, response, { bypassWindow: true });
      await sendSupportButton(from);
      return;
    }
  }

  if (type === "button_reply") {
    const id = payload.button_reply.id;
    const payloadId = payload.button_reply?.payload;
    const title = payload.button_reply?.title?.toLowerCase?.() || "";

    if (id === "DUP:CONFIRM") {
      const pending = sessionDuplicateConfirm.get(userNorm);
      sessionDuplicateConfirm.delete(userNorm);
      if (pending && pending.expiresAt > Date.now()) {
        await finalizeRegisterEntry(from, userNorm, pending.entry, {
          ...pending.options,
          skipDuplicateCheck: true,
        });
      } else {
        await sendText(from, "Confirmação expirou. Envie o lançamento novamente se desejar registrar.");
      }
      return;
    }
    if (id === "DUP:CANCEL") {
      sessionDuplicateConfirm.delete(userNorm);
      await sendText(from, "OK, lançamento não foi registrado.");
      return;
    }

    if (
      id === TEMPLATE_REMINDER_BUTTON_ID ||
      payloadId === TEMPLATE_REMINDER_BUTTON_ID ||
      title === "ver meus lembretes"
    ) {
      await listPendingPayments(from, userNorm);
      await sendReceberHint(from, userNorm);
      return;
    }
    if (
      id === REMINDER_PENDING_BUTTON_ID ||
      payloadId === REMINDER_PENDING_BUTTON_ID ||
      title === "visualizar"
    ) {
      await listPendingPayments(from, userNorm);
      await sendReceberHint(from, userNorm);
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
    if (id.startsWith("CORR:")) {
      const parts = id.split(":");
      const corrType = parts[1]; // VALOR | DESC | DELETE
      const corrRowId = parts[2];
      const row = await findRowById(userNorm, corrRowId);
      if (!row) {
        await sendText(from, "Lançamento não encontrado. Pode já ter sido excluído.");
        return;
      }
      if (corrType === "DELETE") {
        await deleteRow(row);
        sessionLastRegistered.delete(userNorm);
        await sendText(from, "🗑️ Lançamento excluído. Me conta novamente como foi e eu registro de novo.");
        return;
      }
      const field = corrType === "VALOR" ? "valor" : "descricao";
      const prompt = corrType === "VALOR" ? "Digite o valor correto:" : "Digite a descrição correta:";
      sessionEdit.set(userNorm, {
        awaiting: "value",
        field,
        rows: [row],
        queue: [{ row, displayIndex: 1 }],
        currentIndex: 0,
        row,
        displayIndex: 1,
        expiresAt: Date.now() + SESSION_TIMEOUT_MS,
      });
      await sendText(from, prompt);
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
      resetSession(userNorm);
      await sendCancelMessage(from);
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
      if (opt === "hoje") {
        const range = { start: startOfDay(now), end: endOfDay(now) };
        await showReportByCategory(from, userNorm, cat, range);
        sessionPeriod.delete(userNorm);
      }
      if (opt === "mes_atual") {
        const range = {
          start: startOfMonth(now.getFullYear(), now.getMonth()),
          end: endOfMonth(now.getFullYear(), now.getMonth()),
        };
        await showReportByCategory(from, userNorm, cat, range);
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
      const sorted = rows.sort((a, b) => (new Date(getVal(b, "timestamp")).getTime() || 0) - (new Date(getVal(a, "timestamp")).getTime() || 0));
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
    if (id === "MENU:contas_receber") {
      await listPendingReceipts(from, userNorm);
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

async function handleNewCategoryFlow(fromRaw, userNorm, text) {
  const state = sessionNewCategory.get(userNorm);
  if (!state || state.expiresAt < Date.now()) {
    sessionNewCategory.delete(userNorm);
    return false;
  }

  const input = text.trim();

  if (state.awaiting === "name") {
    if (!input || input.length < 2 || input.length > 40) {
      await sendText(fromRaw, "Nome muito curto ou longo. Use entre 2 e 40 caracteres. Ou *cancelar* para sair.");
      return true;
    }
    const slug = normalizeDiacritics(input)
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/__+/g, "_")
      .replace(/^_|_$/g, "");
    if (!slug || slug.length < 2) {
      await sendText(fromRaw, "Nome inválido. Use letras e números.");
      return true;
    }
    const baseDef = getCategoryDefinition(slug);
    const customExists = (await loadCustomCategories(userNorm)).some((c) => c.slug === slug);
    if (baseDef || customExists) {
      await sendText(fromRaw, `A categoria *${input}* já existe. Escolha outro nome.`);
      return true;
    }
    sessionNewCategory.set(userNorm, { ...state, awaiting: "keywords", name: input, slug, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    await sendText(
      fromRaw,
      `Ótimo! Agora me diga as *palavras-chave* para reconhecer *${input}* automaticamente.\n\n` +
      `Separe por vírgula:\n_Ex: academia, musculação, gym, crossfit_`
    );
    return true;
  }

  if (state.awaiting === "keywords") {
    const kwList = input.split(",").map((k) => k.trim()).filter((k) => k.length >= 2);
    if (!kwList.length) {
      await sendText(fromRaw, "Adicione pelo menos uma palavra-chave com 2 ou mais letras. Ou *cancelar* para sair.");
      return true;
    }
    const keywords = kwList.slice(0, 20).join(",");
    sessionNewCategory.set(userNorm, { ...state, awaiting: "emoji", keywords, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    await sendText(
      fromRaw,
      `Quase pronto! Escolha um *emoji* para *${state.name}* (ou envie *pular* para usar 🏷️):`
    );
    return true;
  }

  if (state.awaiting === "emoji") {
    const emojiMatch = [...input].find((c) => /\p{Emoji}/u.test(c) && c !== "*");
    const finalEmoji = emojiMatch || "🏷️";
    sessionNewCategory.delete(userNorm);

    await saveCustomCategory({
      slug: state.slug,
      label: state.name,
      emoji: finalEmoji,
      description: "",
      keywords: state.keywords,
      created_by: userNorm,
    });

    const kwDisplay = state.keywords.split(",").map((k) => `*${k.trim()}*`).join(", ");
    await sendText(
      fromRaw,
      `✅ Categoria *${finalEmoji} ${state.name}* criada!\n\n` +
      `Lançamentos com ${kwDisplay} serão classificados automaticamente. 📂`
    );
    await sendMainMenu(fromRaw);
    return true;
  }

  return false;
}

async function handleUserText(fromRaw, text) {
  const userNorm = normalizeUser(fromRaw);
  const trimmed = (text || "").trim();
  const normalizedMessage = normalizeDiacritics(trimmed).toLowerCase();

  // Iniciar persistLastInteraction e detectIntent em paralelo — economiza 2-5s por mensagem
  // detectIntent só será aguardado quando necessário (linha ~detectIntent await abaixo)
  const persistPromise = persistLastInteraction(userNorm);
  const intentPromise = detectIntent(trimmed);

  await persistPromise;
  const interactionInfo = getLastInteractionInfo(userNorm);
  console.log("📩 Inbound:", {
    fromRaw,
    userNorm,
    canonicalUserId: interactionInfo.canonicalUserId,
    storedLastInteractionISO: interactionInfo.lastIso,
  });
  // Salvar mensagem no log (fire-and-forget — não bloqueia fluxo principal)
  saveMessageToLog(fromRaw, userNorm, "text", trimmed, "", "").catch(err =>
    console.error("Log save failed:", err.message)
  );
  recordUserInteraction(userNorm);

  if (trackMessageAndDetectLoop(userNorm, normalizedMessage)) {
    await sendText(
      fromRaw,
      `Parece que estamos em círculo. 😅 Posso ajudar de outra forma:\n\n` +
      `• Digite *menu* — opções principais\n` +
      `• Digite *ajuda* — dicas de uso\n` +
      `• Ex: _"Paguei R$50 de mercado"_ — registrar gasto\n\n` +
      `Se preferir falar com alguém, mande um e-mail: suporte@finplanner.app`
    );
    lastMessagesHistory.delete(userNorm);
    return;
  }

  const adminCronCommand =
    /\baviso\s*cron\b/i.test(normalizedMessage) ||
    /\bcron\s*(teste|agora)?\b/i.test(normalizedMessage);

  if (isAdminUser(userNorm)) {
    if (adminCronCommand) {
      console.log("🧪 Admin cron command received:", { fromRaw, normalizedMessage });
      await sendCronReminderForUser(userNorm, fromRaw, { bypassWindow: true });
      return;
    }
    // Comando: "ativar 5511999999999 mensal" ou "ativar 5511999999999"
    const ativarMatch = /^ativar\s+(\d{10,15})(?:\s+(mensal|trimestral|anual))?$/i.test(normalizedMessage)
      ? normalizedMessage.match(/^ativar\s+(\d{10,15})(?:\s+(mensal|trimestral|anual))?$/i)
      : null;
    if (ativarMatch) {
      const targetNorm = normalizeUser(ativarMatch[1]);
      const plano = (ativarMatch[2] || "mensal").toLowerCase();
      try {
        const now = new Date();
        const vencimento = new Date(now);
        vencimento.setMonth(vencimento.getMonth() + (plano === "anual" ? 12 : plano === "trimestral" ? 3 : 1));
        await upsertUsuarioFromSubscription({
          userNorm: targetNorm,
          plano,
          ativo: true,
          data_inicio: formatISODate(now),
          extendVencimento: false,
          vencimento_trial: formatISODate(vencimento),
        });
        await sendText(fromRaw, `✅ Usuário *${targetNorm}* ativado com plano *${plano}* até ${formatBRDate(vencimento)}.`, { bypassWindow: true });
      } catch (e) {
        await sendText(fromRaw, `❌ Erro ao ativar: ${e.message}`, { bypassWindow: true });
      }
      return;
    }
  }

  // Correção rápida: "errado", "incorreto" etc logo após um registro
  const correctionRegex = /^(errad[oa]|incorret[oa]|errei|tá errad[oa]|ta errad[oa]|não é isso|nao e isso|ops?|opa|me enganei|lancei errado|registrei errado)\b/i;
  if (correctionRegex.test(normalizedMessage)) {
    const last = sessionLastRegistered.get(userNorm);
    if (last && last.expiresAt > Date.now()) {
      await sendWA({
        messaging_product: "whatsapp",
        to: fromRaw,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: "O que deseja corrigir no último lançamento?" },
          action: {
            buttons: [
              { type: "reply", reply: { id: `CORR:VALOR:${last.rowId}`, title: "✏️ Editar valor" } },
              { type: "reply", reply: { id: `CORR:DESC:${last.rowId}`, title: "📝 Editar descrição" } },
              { type: "reply", reply: { id: `CORR:DELETE:${last.rowId}`, title: "🗑️ Excluir e refazer" } },
            ],
          },
        },
      });
      return;
    }
  }

  if (!userNorm || !isAdminUser(userNorm)) {
    let active = await isUsuarioAtivo(userNorm);
    if (!active) {
      const nome = getStoredFirstName(userNorm);
      const classification = await classifyInactiveUserMessage(trimmed);

      if (classification === "acredita_que_pagou") {
        const candidates = getUserCandidates(userNorm);
        candidates.forEach((c) => usuarioStatusCache.delete(c));
        active = await isUsuarioAtivo(userNorm);
        if (active) {
          console.log("[AccessRetry] Usuário reativado após cache clear:", userNorm);
        } else if (ADMIN_WA_NUMBER) {
          await sendText(ADMIN_WA_NUMBER,
            `⚠️ *Usuário diz que já pagou mas não está ativo*\n\n📱 Número: ${fromRaw}\n🔑 Normalizado: ${userNorm}\n💬 Mensagem: "${trimmed}"\n\n_Verifique a planilha e ative manualmente se necessário._`,
            { bypassWindow: true }
          );
        }
      }

      if (!active) {
        const response = buildInactiveUserResponse(classification, nome);
        await sendText(fromRaw, response, { bypassWindow: true });
        await sendSupportButton(fromRaw);
        return;
      }
    }
  }

  // 🚪 Interceptor global: palavras de escape cancelam o fluxo ativo e abrem o menu
  if (hasActiveSession(userNorm) && ESCAPE_REGEX.test(trimmed)) {
    resetSession(userNorm);
    if (NAVIGATE_REGEX.test(trimmed)) {
      await sendMainMenu(fromRaw);
    } else {
      await sendCancelMessage(fromRaw);
    }
    return;
  }

  // 🔀 Pivot: lançamento financeiro cancela silenciosamente qualquer sessão em andamento
  if (hasActiveSession(userNorm)) {
    const pivotIntent = await intentPromise;
    if (pivotIntent === "registrar_pagamento" || pivotIntent === "registrar_recebimento") {
      console.log("[Pivot] Sessão cancelada para registrar lançamento:", { userNorm, pivotIntent });
      resetSession(userNorm);
      // sem mensagem de cancelamento — fluxo continua para o handler de intenção abaixo
    }
  }

  // 📂 Fluxo de criação de categoria (multi-step)
  if (sessionNewCategory.has(userNorm)) {
    if (await handleNewCategoryFlow(fromRaw, userNorm, trimmed)) return;
  }

  // 📂 Intenções de categoria
  const addCatRegex = /(adicionar?|criar?|nova?|incluir?)\s+categori/i;
  const listCatRegex = /(ver|listar?|minha[s]?|mostrar?|quero\s+ver)\s+categori/i;

  if (listCatRegex.test(normalizedMessage)) {
    const cats = await loadCustomCategories(userNorm);
    if (!cats.length) {
      await sendText(fromRaw, "Você ainda não tem categorias personalizadas. 📂\n\nDigite *adicionar categoria* para criar uma!");
    } else {
      const list = cats.map((c) => `${c.emoji} *${c.label}*${c.keywords ? `\n_Palavras-chave: ${c.keywords}_` : ""}`).join("\n\n");
      await sendText(fromRaw, `📂 *Suas categorias personalizadas:*\n\n${list}\n\n_Digite *adicionar categoria* para criar uma nova._`);
    }
    return;
  }

  if (addCatRegex.test(normalizedMessage)) {
    sessionNewCategory.set(userNorm, { awaiting: "name", expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    await sendText(
      fromRaw,
      `📂 Vamos criar uma nova categoria!\n\n` +
      `Qual será o *nome* da categoria?\n` +
      `_Ex: Academia, Pets, Filhos, Streaming_`
    );
    return;
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
    await sendReceberHint(fromRaw, userNorm);
    return;
  }

  // Verificar se é uma conta fixa ANTES de detectar intenção
  const fixedLines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const fixedResults = fixedLines.map((l) => ({ line: l, parsed: parseFixedAccountCommand(l) })).filter((r) => r.parsed);
  if (fixedResults.length) {
    for (const { parsed } of fixedResults) {
      await registerFixedAccount(fromRaw, userNorm, parsed);
    }
    if (fixedResults.length > 1) {
      await sendText(fromRaw, `✅ ${fixedResults.length} contas fixas cadastradas com sucesso!`);
    }
    const failed = fixedLines.length - fixedResults.length;
    if (failed > 0 && fixedLines.length > 1) {
      const failedLines = fixedLines.filter((l) => !parseFixedAccountCommand(l));
      await sendText(fromRaw, `⚠️ Não consegui entender ${failed} linha(s):\n${failedLines.map((f) => `• ${f}`).join("\n")}\n\nEnvie no formato: Descrição Valor todo dia X`);
    }
    return;
  }

  // Aguardar resultado do detectIntent que foi iniciado em paralelo no início da função
  const intent = await intentPromise;
  switch (intent) {
    case "boas_vindas":
      console.log("[handleUserText] Intent boas_vindas → sendWelcomeList:", { fromRaw, userNorm, trimmed });
      await sendWelcomeList(fromRaw);
      break;
    case "mostrar_menu":
      console.log("[handleUserText] Intent mostrar_menu → sendMainMenu:", { fromRaw, userNorm, trimmed });
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
      await sendReceberHint(fromRaw, userNorm);
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
    case "ajuda_parcelamento":
      await sendText(
        fromRaw,
        `📦 *Parcelamento no FinPlanner IA*\n\nO bot não tem lançamento automático de parcelas por enquanto, mas é simples fazer manualmente:\n\n` +
        `1️⃣ Registre cada parcela separadamente com a data de vencimento de cada uma.\n` +
        `Exemplo:\n` +
        `• _"Parcela 1/3 notebook R$500 vence 10/05"_\n` +
        `• _"Parcela 2/3 notebook R$500 vence 10/06"_\n` +
        `• _"Parcela 3/3 notebook R$500 vence 10/07"_\n\n` +
        `2️⃣ Ou use *Contas fixas* para lançar um valor recorrente todo mês automaticamente.\n\n` +
        `Digite *menu* para ver todas as opções.`
      );
      break;
    default:
      if (extractAmountFromText(trimmed).amount) {
        await registerEntry(fromRaw, userNorm, text);
      } else if (!trimmed) {
        console.log("[handleUserText] Texto vazio recebido, ignorando.", { fromRaw, userNorm });
      } else {
        console.log("[handleUserText] Fallback contextual (intent desconhecido):", { fromRaw, userNorm, trimmed, intent });
        await sendText(
          fromRaw,
          `Não entendi exatamente o que você quer fazer. 🤔\n\n` +
          `Você pode:\n` +
          `• Digitar o valor direto: *"Paguei R$150 de mercado"*\n` +
          `• Digitar *saldo* para ver seu balanço do mês\n` +
          `• Digitar *menu* para ver todas as opções`
        );
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
    console.error("⚠️ Stripe webhook assinatura inválida:", {
      isBuffer: Buffer.isBuffer(req.body),
      contentType: req.headers["content-type"],
      error: err.message,
    });
    // Notifica admin — pode indicar STRIPE_WEBHOOK_SECRET errado (ex: test vs live)
    if (ADMIN_WA_NUMBER) {
      sendText(ADMIN_WA_NUMBER,
        `⚠️ *Stripe*: falha na verificação de assinatura do webhook.\n` +
        `Erro: ${err.message}\n\n` +
        `_Verifique se STRIPE_WEBHOOK_SECRET no .env corresponde ao segredo do endpoint no Stripe Dashboard (modo live vs test)._`,
        { bypassWindow: true }
      ).catch(() => {});
    }
    res.status(400).send(`Webhook error: ${err.message}`);
    return;
  }

  console.log("[STRIPE] Webhook recebido:", event.type, event.id);

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
        console.error("⚠️ Evento Stripe sem plano válido. planoRaw =", planoRaw, "priceId =", priceId);
        if (ADMIN_WA_NUMBER) {
          await sendText(ADMIN_WA_NUMBER,
            `⚠️ *Stripe*: checkout sem plano válido.\nSession: ${session.id}\nplanoRaw: ${planoRaw || "—"}\npriceId: ${priceId || "—"}\nEmail: ${session.customer_details?.email || "—"}`,
            { bypassWindow: true }
          );
        }
        return res.sendStatus(200);
      }

      // Busca whatsapp em múltiplas fontes (em ordem de preferência)
      let whatsapp = session.metadata?.whatsapp || subMeta?.whatsapp || "";
      let whatsappSource = whatsapp ? "metadata" : "";

      if (!whatsapp && session.customer_details?.phone) {
        whatsapp = session.customer_details.phone;
        whatsappSource = "customer_details.phone";
      }

      if (!whatsapp && Array.isArray(session.custom_fields)) {
        const phoneField = session.custom_fields.find((f) => {
          const key = String(f?.key || "").toLowerCase();
          return /whats|telefone|celular|phone/.test(key);
        });
        const fieldVal = phoneField?.text?.value || phoneField?.numeric?.value || "";
        if (fieldVal) {
          whatsapp = fieldVal;
          whatsappSource = `custom_fields.${phoneField.key}`;
        }
      }

      if (whatsappSource && whatsappSource !== "metadata") {
        console.log("📱 WhatsApp resolvido via fallback:", { whatsappSource, whatsapp });
      }

      if (!whatsapp) {
        console.error("⚠️ Evento Stripe sem whatsapp em nenhuma fonte. Session:", {
          id: session.id,
          metadata: session.metadata,
          customer_details: session.customer_details,
          custom_fields: session.custom_fields,
          subscription: session.subscription,
        });
        if (ADMIN_WA_NUMBER) {
          await sendText(ADMIN_WA_NUMBER,
            `⚠️ *Stripe*: checkout sem número de WhatsApp em nenhuma fonte.\nSession: ${session.id}\nPlano: ${plano}\nEmail: ${session.customer_details?.email || "—"}\nSubscription: ${session.subscription || "—"}\n\n_Ative manualmente na planilha._`,
            { bypassWindow: true }
          );
        }
        return res.sendStatus(200);
      }

      const userNorm = normalizeWhatsAppNumber(whatsapp);
      if (!userNorm) {
        console.error("⚠️ Stripe: whatsapp inválido no metadata:", whatsapp);
        if (ADMIN_WA_NUMBER) {
          await sendText(ADMIN_WA_NUMBER,
            `⚠️ *Stripe*: número de WhatsApp inválido no metadata.\nWhatsApp recebido: ${whatsapp}\nSession: ${session.id}`,
            { bypassWindow: true }
          );
        }
        return res.sendStatus(200);
      }

      const nome = session.customer_details?.name || session.customer_name || session.metadata?.nome || "";
      const email = session.customer_details?.email || session.customer_email || session.metadata?.email || "";

      // ✅ TRIAL: 3 dias de acesso gratuito a partir do checkout
      const trialDays = 3;
      const now = new Date();
      const trialVencimento = new Date(now);
      trialVencimento.setDate(trialVencimento.getDate() + trialDays);

      console.log("🧾 Upsert usuario (checkout + trial 3 dias):", {
        userNorm, plano, ativo: true,
        trialVencimento: formatISODate(trialVencimento),
      });

      await upsertUsuarioFromSubscription({
        userNorm,
        nome,
        plano,
        email,
        checkout_id: session.id || session.subscription || session.payment_intent || "",
        data_inicio: formatISODate(now),
        vencimento_trial: formatISODate(trialVencimento),
        ativo: true,
        extendVencimento: false, // Trial tem data fixa de 3 dias
      });

      // Notificar admin sobre novo usuário
      if (ADMIN_WA_NUMBER) {
        await sendText(ADMIN_WA_NUMBER,
          `🎉 Novo usuário registrado!\n\n👤 *${nome || userNorm}*\n📱 ${userNorm}\n📧 ${email || "—"}\n📋 Plano: ${plano}\n⏱️ Trial: ${trialDays} dias (até ${formatBRDate(formatISODate(trialVencimento))})`,
          { bypassWindow: true }
        );
      }

      // ── ONBOARDING DIA 1: Boas-vindas ao novo assinante ────────────
      try {
        const firstName = extractFirstName(nome) || "";
        const greeting = firstName ? `Olá, ${firstName}! 🎉` : "Olá! 🎉";
        const welcomeMsg =
          `${greeting} Seja bem-vindo(a) ao FinPlanner.\n\n` +
          `Estou aqui para te ajudar a organizar suas finanças de forma simples — ` +
          `é só me contar seus gastos e entradas no dia a dia, como numa conversa.\n\n` +
          `Que tal começar agora? Me conta um gasto que você teve hoje. 😊`;
        await sendText(userNorm, welcomeMsg, { bypassWindow: true });
        console.log("[ONBOARDING] Dia 1 enviado para", userNorm);
      } catch (onboardErr) {
        console.error("[ONBOARDING] Erro ao enviar boas-vindas Dia 1:", onboardErr.message);
      }
    }

    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;

      // Ignorar faturas de valor zero (ex: trial sem cobrança)
      if ((invoice.amount_paid || 0) === 0) {
        console.log("ℹ️ invoice.payment_succeeded ignorado (valor zero / trial):", { invoiceId: invoice.id });
        return res.sendStatus(200);
      }

      const subMeta = await getSubscriptionMetadata(stripe, invoice.subscription);
      const planoRaw = pickFirst(invoice.metadata?.plano, subMeta?.plano);
      const plano = normalizePlan(planoRaw);

      if (!plano) {
        console.log("⚠️ Evento Stripe sem plano válido. planoRaw =", planoRaw);
        return res.sendStatus(200);
      }

      let whatsapp = pickFirst(invoice.metadata?.whatsapp, subMeta?.whatsapp);
      if (!whatsapp && invoice.customer_phone) whatsapp = invoice.customer_phone;
      if (!whatsapp) {
        console.log("⚠️ invoice.payment_succeeded sem whatsapp em nenhuma fonte:", {
          invoiceId: invoice.id,
          metadata: invoice.metadata,
          subMeta,
          customer: invoice.customer,
        });
        if (ADMIN_WA_NUMBER) {
          await sendText(ADMIN_WA_NUMBER,
            `⚠️ *Stripe*: invoice ${invoice.id} sem WhatsApp.\nCustomer: ${invoice.customer || "—"}\nPlano: ${plano}\n\n_Ative/renove manualmente na planilha._`,
            { bypassWindow: true }
          ).catch(() => {});
        }
        return res.sendStatus(200);
      }

      const userNorm = normalizeWhatsAppNumber(whatsapp);
      if (!userNorm) {
        return res.sendStatus(200);
      }

      // Data do pagamento como base para cálculo do novo vencimento
      const paymentDate = invoice.status_transitions?.paid_at
        ? new Date(invoice.status_transitions.paid_at * 1000)
        : new Date();

      console.log("🧾 Upsert usuario (pagamento confirmado):", {
        userNorm, plano, ativo: true,
        invoiceId: invoice.id,
        billingReason: invoice.billing_reason,
        paymentDate: formatISODate(paymentDate),
      });

      await upsertUsuarioFromSubscription({
        userNorm,
        plano,
        ativo: true,
        data_inicio: formatISODate(paymentDate),
        extendVencimento: true, // Calcula novo vencimento baseado no plano
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
      const userNorm = normalizeWhatsAppNumber(whatsapp);
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
    console.error("Erro ao processar evento Stripe:", event?.type, error.message);
    if (ADMIN_WA_NUMBER) {
      sendText(ADMIN_WA_NUMBER,
        `🚨 *Stripe*: erro ao processar webhook *${event?.type || "desconhecido"}*.\n` +
        `Erro: ${error.message}\n` +
        `Event ID: ${event?.id || "—"}\n\n` +
        `_O usuário pode não ter sido ativado. Verifique os logs e ative manualmente se necessário._`,
        { bypassWindow: true }
      ).catch(() => {});
    }
  }

  res.sendStatus(200);
}

app.post("/webhook", webhookLimiter, async (req, res) => {
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
            if (status.status === "failed") {
              const errorTitle = status.errors?.[0]?.title || "";
              const errorCode = status.errors?.[0]?.code || "";
              const recipientId = status.recipient_id;

              // Log todos os erros para análise
              console.log("[Webhook] Message delivery failed:", {
                recipient: recipientId,
                error: errorTitle,
                code: errorCode,
                details: status.errors?.[0]
              });

              // Re-engagement errors são esperados (usuários inativos)
              // Não enviar notificação ao admin para evitar spam
              const isReengagementError =
                errorTitle.toLowerCase().includes("re-engagement") ||
                errorTitle.toLowerCase().includes("reengagement") ||
                errorCode === 131026; // Código oficial do WhatsApp para re-engagement

              if (!isReengagementError && ADMIN_WA_NUMBER) {
                await sendText(
                  ADMIN_WA_NUMBER,
                  `⚠️ Falha ao entregar mensagem para ${recipientId}: ${errorTitle}`
                );
              }
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
            } else if (type === "audio") {
              const mediaId = message.audio?.id;
              if (mediaId && openaiClient) {
                const transcribed = await transcribeAudio(mediaId);
                if (transcribed) {
                  await handleUserText(from, transcribed);
                } else {
                  await sendText(from, "Não consegui entender o áudio. Pode enviar como texto?");
                }
              } else {
                await sendText(from, "Para enviar mensagens de voz, ative a integração com IA nas configurações.");
              }
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
// ONBOARDING CRON (Dias 2 e 3)
// ============================
async function runOnboardingCron({ requestedBy = "cron", forceHour = false } = {}) {
  console.log(`[ONBOARDING] runOnboardingCron start requestedBy=${requestedBy} at ${new Date().toISOString()}`);

  // Guard de horário: só executa entre 07h e 09h (BRT = UTC-3)
  if (!forceHour && requestedBy !== "admin") {
    const nowUtc = new Date();
    const brazilHour = (nowUtc.getUTCHours() - 3 + 24) % 24;
    if (brazilHour < 7 || brazilHour >= 9) {
      console.log(`[ONBOARDING] Fora do horário permitido (hora BRT: ${brazilHour}h). Abortando.`);
      return { skipped: true, reason: "outside_allowed_hours", brazilHour };
    }
  }

  const results = { day2_sent: 0, day3_sent: 0, skipped: 0, errors: 0 };

  let usuariosRows;
  try {
    const sheet = await ensureSheetUsuarios();
    usuariosRows = await withRetry(() => sheet.getRows(), "get-usuarios-onboarding");
  } catch (err) {
    console.error("[ONBOARDING] Erro ao ler planilha Usuarios:", err.message);
    return { ...results, errors: 1 };
  }

  const today = startOfDay(new Date());

  for (const row of usuariosRows) {
    const rawUser = getVal(row, "user");
    const userNorm = normalizeUser(rawUser);
    if (!userNorm) { results.skipped += 1; continue; }

    if (!isTruthy(getVal(row, "ativo"))) { results.skipped += 1; continue; }

    const dataInicio = parseISODateSafe(getVal(row, "data_inicio"));
    if (!dataInicio) { results.skipped += 1; continue; }

    const daysSinceStart = Math.floor(
      (today.getTime() - startOfDay(dataInicio).getTime()) / (24 * 60 * 60 * 1000)
    );

    if (daysSinceStart === 1) {
      // ── DIA 2 ──────────────────────────────────────────────────────
      if (!shouldSendOnboarding(userNorm, 2)) { results.skipped += 1; continue; }
      try {
        const firstName = extractFirstName(getVal(row, "nome")) || getStoredFirstName(userNorm) || "";
        const greeting = firstName ? `Bom dia, ${firstName}! ☀️` : "Bom dia! ☀️";
        const yesterday = startOfDay(new Date(today.getTime() - 86400000));
        const allRows = await allRowsForUser(userNorm);
        const count = withinPeriod(allRows, yesterday, endOfDay(yesterday)).length;
        const label = count === 1 ? "lançamento" : "lançamentos";
        const msg = count > 0
          ? `${greeting}\n\nOntem você registrou *${count} ${label}*. Ótimo começo! 💪\n\nQue tal registrar o primeiro gasto de hoje?`
          : `${greeting}\n\nAinda não registrou nenhum gasto ontem. Tudo bem, vamos começar hoje — me conta um gasto que você já teve essa manhã. 😊`;
        await sendText(rawUser, msg, { bypassWindow: true });
        console.log("[ONBOARDING] Dia 2 enviado para", userNorm, { count });
        results.day2_sent += 1;
      } catch (err) {
        console.error("[ONBOARDING] Erro Dia 2 para", userNorm, ":", err.message);
        results.errors += 1;
      }

    } else if (daysSinceStart === 2) {
      // ── DIA 3 ──────────────────────────────────────────────────────
      if (!shouldSendOnboarding(userNorm, 3)) { results.skipped += 1; continue; }
      try {
        const firstName = extractFirstName(getVal(row, "nome")) || getStoredFirstName(userNorm) || "";
        const greeting = firstName ? `Bom dia, ${firstName}! 🌟` : "Bom dia! 🌟";
        const periodStart = startOfDay(dataInicio);
        const periodEnd = endOfDay(new Date(today.getTime() - 86400000));
        const allRows = await allRowsForUser(userNorm);
        const periodRows = withinPeriod(allRows, periodStart, periodEnd);
        const count = periodRows.length;
        const total = sumValues(periodRows);
        const totalFormatted = formatCurrencyBR(total);
        const categoryLines = count > 0 ? formatCategoryLines(periodRows) : "";

        const conclusion = count > 0
          ? `Excelente começo${firstName ? `, ${firstName}` : ""}! Continue registrando seus gastos para ter cada vez mais clareza sobre suas finanças. 💪`
          : `Não se preocupe${firstName ? `, ${firstName}` : ""}! Comece hoje mesmo — cada lançamento conta para o seu controle financeiro. 💪`;

        let msg = `${greeting}\n\nAqui está um mini relatório dos seus primeiros dias:\n\n`;
        if (count > 0 && categoryLines) {
          msg += `${categoryLines}\n\n💰 *Total: ${totalFormatted}*\n\n`;
        } else {
          msg += `_(Nenhum lançamento registrado ainda)_\n\n`;
        }
        msg += conclusion;

        await sendText(rawUser, msg, { bypassWindow: true });
        console.log("[ONBOARDING] Dia 3 enviado para", userNorm, { count, total });
        results.day3_sent += 1;
      } catch (err) {
        console.error("[ONBOARDING] Erro Dia 3 para", userNorm, ":", err.message);
        results.errors += 1;
      }
    }
  }

  console.log("[ONBOARDING] runOnboardingCron done", results);
  return results;
}

async function runReengagementCron({ requestedBy = "cron", forceHour = false } = {}) {
  console.log(`[REENGAGEMENT] start requestedBy=${requestedBy} at ${new Date().toISOString()}`);

  if (!forceHour && requestedBy !== "admin") {
    const nowUtc = new Date();
    const brazilHour = (nowUtc.getUTCHours() - 3 + 24) % 24;
    if (brazilHour < 7 || brazilHour >= 9) {
      console.log(`[REENGAGEMENT] Fora do horário permitido (${brazilHour}h BRT). Abortando.`);
      return { skipped: true, reason: "outside_allowed_hours" };
    }
  }

  const INACTIVE_MIN_DAYS = 6;   // Considera inativo após 6 dias sem uso
  const INACTIVE_MAX_DAYS = 30;  // Não tenta usuários sumidos há mais de 30 dias
  const results = { sent: 0, skipped: 0, errors: 0 };

  let usuariosRows;
  try {
    const sheet = await ensureSheetUsuarios();
    usuariosRows = await withRetry(() => sheet.getRows(), "get-usuarios-reengagement");
  } catch (err) {
    console.error("[REENGAGEMENT] Erro ao ler planilha:", err.message);
    return { ...results, errors: 1 };
  }

  const now = new Date();
  const nowMs = now.getTime();

  for (const row of usuariosRows) {
    const rawUser = getVal(row, "user");
    const userNorm = normalizeUser(rawUser);
    if (!userNorm) { results.skipped += 1; continue; }
    if (!isTruthy(getVal(row, "ativo"))) { results.skipped += 1; continue; }

    const lastIso = getVal(row, "last_interaction");
    if (!lastIso) { results.skipped += 1; continue; }

    const lastMs = new Date(lastIso).getTime();
    if (!lastMs || Number.isNaN(lastMs)) { results.skipped += 1; continue; }

    const daysSince = (nowMs - lastMs) / (24 * 60 * 60 * 1000);
    if (daysSince < INACTIVE_MIN_DAYS || daysSince > INACTIVE_MAX_DAYS) {
      results.skipped += 1;
      continue;
    }

    const withinWindow = nowMs - lastMs <= WA_SESSION_WINDOW_MS;

    // Skip se runAvisoCron já enviou para este usuário hoje (cross-cron dedup)
    if (!shouldNotifyAdminReminder(userNorm)) {
      console.log(`[REENGAGEMENT] Já recebeu lembrete hoje, pulando: ${userNorm}`);
      results.skipped += 1;
      continue;
    }

    const firstName = extractFirstName(getVal(row, "nome")) || getStoredFirstName(userNorm) || "";
    const greeting = firstName ? `Oi, ${firstName}! 👋` : "Oi! 👋";
    const days = Math.floor(daysSince);
    const diasStr = days === 1 ? "1 dia" : `${days} dias`;

    try {
      if (withinWindow) {
        const msg =
          `${greeting}\n\nFaz ${diasStr} que você não registra nada por aqui. Tudo bem?\n\n` +
          `Quando quiser retomar, é só me contar um gasto ou entrada do dia — estou aqui. 😊`;
        await sendText(rawUser, msg, { bypassWindow: true });
      } else {
        await sendTemplateReminderV2(rawUser, userNorm, {
          nameHint: firstName,
          pagarVencidas: 0, pagarHoje: 0,
          receberVencidas: 0, receberHoje: 0,
          total: "0,00",
        });
      }
      console.log(`[REENGAGEMENT] Enviado para ${userNorm} (${days} dias inativo, withinWindow=${withinWindow})`);
      results.sent += 1;
    } catch (err) {
      console.error(`[REENGAGEMENT] Erro para ${userNorm}:`, err.message);
      results.errors += 1;
    }
  }

  console.log("[REENGAGEMENT] done", results);
  return results;
}

let _avisoCronRunning = false;

const getTodayBRTKey = () => {
  const now = new Date();
  const brHour = (now.getUTCHours() - 3 + 24) % 24;
  const brt = new Date(now);
  brt.setUTCHours(brt.getUTCHours() - 3);
  if (brHour >= 21) brt.setUTCDate(brt.getUTCDate());
  return `${brt.getUTCFullYear()}-${String(brt.getUTCMonth() + 1).padStart(2, "0")}-${String(brt.getUTCDate()).padStart(2, "0")}`;
};

const AVISO_LOCK_DIR = process.env.AVISO_LOCK_DIR || "/tmp";

async function runAvisoCron({ requestedBy = "cron", dryRun = false, forceHour = false } = {}) {
  if (_avisoCronRunning) {
    console.log(`[CRON] runAvisoCron já em execução (requestedBy=${requestedBy}), ignorando chamada duplicada.`);
    return { skipped: true, reason: "already_running" };
  }

  const todayKey = getTodayBRTKey();
  const lockPath = `${AVISO_LOCK_DIR}/finplanner-aviso-${todayKey}.lock`;
  if (!forceHour && requestedBy !== "admin") {
    try {
      fs.writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()} ${requestedBy}\n`, { flag: "wx" });
      console.log(`[CRON] Lock adquirido: ${lockPath}`);
    } catch (err) {
      if (err.code === "EEXIST") {
        let lockInfo = "";
        try { lockInfo = fs.readFileSync(lockPath, "utf8").trim(); } catch {}
        console.log(`[CRON] Lock ${lockPath} já existe, outro processo rodou hoje. Info: ${lockInfo}. Ignorando (requestedBy=${requestedBy}).`);
        return { skipped: true, reason: "lock_exists", lockInfo };
      }
      console.warn(`[CRON] Erro ao criar lock ${lockPath}: ${err.message}. Prosseguindo sem lock.`);
    }
  }

  _avisoCronRunning = true;
  console.log(`[CRON] runAvisoCron start requestedBy=${requestedBy} at ${new Date().toISOString()}`);

  try {
  // 🕗 Guard de horário: só executa entre 07h e 09h (horário de Brasília, UTC-3)
  if (!forceHour && requestedBy !== "admin") {
    const nowUtc = new Date();
    const brazilHour = (nowUtc.getUTCHours() - 3 + 24) % 24;
    if (brazilHour < 7 || brazilHour >= 9) {
      console.log(`[CRON] Fora do horário permitido (hora BRT: ${brazilHour}h). Abortando.`);
      return { skipped: true, reason: "outside_allowed_hours", brazilHour };
    }
  }

  // Limpa cache de usuários para garantir dados frescos do cron
  usuarioStatusCache.clear();
  console.log("[CRON] Cleared usuarioStatusCache to ensure fresh data");

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
  let lastInteractionByUser = new Map();

  try {
    const sheet = await ensureSheet();
    lastInteractionByUser = await loadLastInteractionFromUsuarios();
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

      console.log("[CRON] Checking user:", {
        userNorm,
        to,
        itemsCount: items.length,
      });

      // 🔒 Validação de acesso: Admin tem bypass, outros precisam de plano ativo
      const userIsAdmin = isAdminUser(userNorm);
      if (!userIsAdmin) {
        const ativo = await isUsuarioAtivo(userNorm);
        if (!ativo) {
          console.log("⛔ Cron skip (plano inativo ou não cadastrado):", {
            userNorm,
            to,
            itens: items.length,
            reason: "isUsuarioAtivo returned false"
          });
          reasons.inactive_plan += 1;
          skippedCount += 1;
          continue;
        }
      }

      console.log("✅ User is active, preparing reminder:", { userNorm, to, isAdmin: userIsAdmin, willCheckWindow: true });

      const { message, pagar, receber } = buildCronMessage(items, todayMs);

      if (!message) {
        skippedCount += 1;
        continue;
      }
      const interactionInfo = getLastInteractionFromMap(userNorm, lastInteractionByUser);
      const nowMs = Date.now();
      const diffMinutes =
        typeof interactionInfo.lastMs === "number" ? Math.round((nowMs - interactionInfo.lastMs) / 60000) : null;
      // ✅ Cron usa janela REAL mesmo para admin (template funciona sempre)
      const withinWindow =
        typeof interactionInfo.lastMs === "number" && nowMs - interactionInfo.lastMs <= WA_SESSION_WINDOW_MS;
      console.log("[CRON] window check", {
        userNorm,
        canonicalUserId: interactionInfo.canonicalUserId,
        lastInteractionISO: interactionInfo.lastIso,
        diffMinutes,
        isAdmin: userIsAdmin,
        withinWindow,
      });
      console.log("⏰ Cron send attempt:", {
        userNorm,
        to,
        total: items.length,
        pagar: pagar.length,
        receber: receber.length,
        withinWindow,
        isAdmin: userIsAdmin,
      });
      // 🔒 Deduplicação diária: não envia mais de uma vez por dia por usuário
      if (!shouldNotifyAdminReminder(userNorm)) {
        console.log("[CRON] Lembrete já enviado hoje para:", userNorm);
        skippedCount += 1;
        continue;
      }

      // Calcula resumo comum para interactive e template
      const pagarVencidas   = items.filter((i) => i.kind === "pagar"   && i.dueMs < todayMs).length;
      const pagarHoje       = items.filter((i) => i.kind === "pagar"   && i.dueMs >= todayMs).length;
      const receberVencidas = items.filter((i) => i.kind === "receber" && i.dueMs < todayMs).length;
      const receberHoje     = items.filter((i) => i.kind === "receber" && i.dueMs >= todayMs).length;
      const totalValor = items.reduce((sum, item) => {
        const raw = (getVal(item.row, "valor") || "0").toString().replace(",", ".").replace(/[^\d.]/g, "");
        return sum + (parseFloat(raw) || 0);
      }, 0);
      const totalFormatted = totalValor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const reminderSummary = { pagarVencidas, pagarHoje, receberVencidas, receberHoje, total: totalFormatted };

      let delivered = false;
      let threw = false;
      let usedTemplate = false;
      let usedFallback = false;
      try {
        if (withinWindow) {
          delivered = await sendInteractiveReminder(to, userNorm, reminderSummary);
          if (delivered) {
            sentCount += 1;
            reasons.sent_ok += 1;
            reasons.sent_text_ok += 1;
          }
        } else if (SKIP_TEMPLATE_REMINDER) {
          // Custo reduzido: não envia template para usuários fora da janela
          console.log("[CRON] SKIP_TEMPLATE_REMINDER ativo — pulando usuário fora da janela:", userNorm);
          skippedCount += 1;
          continue;
        } else {
          usedTemplate = true;
          delivered = await sendTemplateReminderV2(to, userNorm, {
            nameHint: getStoredFirstName(userNorm),
            ...reminderSummary,
          });
          if (delivered) {
            sentCount += 1;
            reasons.sent_ok += 1;
            reasons.sent_template_ok += 1;
          }
        }

        // 🔧 FALLBACK CRÍTICO: Se template/interactive falhar, usa texto com bypassWindow
        // TODOS os usuários ativos receberão, não apenas admin
        if (!delivered) {
          console.log("🚨 Template/interactive failed, using text fallback with bypassWindow:", { userNorm, to, isAdmin: userIsAdmin });
          usedFallback = true;
          const fallbackSent = await sendText(to, message, { bypassWindow: true });
          if (fallbackSent && !fallbackSent.skipped) {
            delivered = true;
            sentCount += 1;
            reasons.sent_ok += 1;
            reasons.sent_text_ok += 1;
          }
        }
      } catch (error) {
        threw = true;
        errorCount += 1;
        reasons.send_error += 1;
        console.error("Erro no envio do CRON:", error.message);

        // 🔧 FALLBACK EM CASO DE ERRO: TODOS usuários ativos tentam fallback
        if (!delivered) {
          try {
            console.log("🚨 Error sending, trying text fallback:", { userNorm, to, isAdmin: userIsAdmin });
            usedFallback = true;
            const fallbackSent = await sendText(to, message, { bypassWindow: true });
            if (fallbackSent && !fallbackSent.skipped) {
              delivered = true;
              sentCount += 1;
              reasons.sent_ok += 1;
              reasons.sent_text_ok += 1;
              threw = false; // Reset error flag
            }
          } catch (fallbackError) {
            console.error("Erro no fallback do CRON:", { userNorm, to, error: fallbackError.message });
          }
        }
      }
      if (!delivered) {
        console.log("⚠️ Cron delivery failed:", { userNorm, to, delivered, withinWindow, usedTemplate, usedFallback, isAdmin: userIsAdmin });
        if (!threw) {
          errorCount += 1;
          reasons.send_error += 1;
        }
        skippedCount += 1;
        continue;
      }
      console.log("✅ Cron delivery ok:", { userNorm, to, via: usedFallback ? "text-fallback" : (usedTemplate ? "template" : "interactive") });

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
  } finally {
    _avisoCronRunning = false;
  }
}

// ============================
// Server
// ============================
const port = PORT || 10000;
const isCronAviso = process.argv.includes("--cron-aviso");
if (isCronAviso) {
  (async () => {
    console.log("[BOOT] cron-aviso mode");
    console.log(`[CRON] cron-aviso start at ${new Date().toISOString()}`);
    console.log("[CRON] env check", {
      hasGoogleEmail: !!GOOGLE_SERVICE_ACCOUNT_EMAIL,
      hasGoogleKey: !!GOOGLE_SERVICE_ACCOUNT_KEY,
    });
    try {
      await runAvisoCron({ requestedBy: "linux-cron" });
      await runOnboardingCron({ requestedBy: "linux-cron" });
      console.log(`[CRON] cron-aviso done at ${new Date().toISOString()}`);
      process.exit(0);
    } catch (error) {
      console.error("[CRON] cron-aviso error:", error);
      process.exit(1);
    }
  })();
} else {
  console.log("[BOOT] server starting on port", port);
  app.listen(port, () => {
    console.log(`FinPlanner IA (2025-10-23) rodando na porta ${port}`);
    migrateUserSheets();

    // Scheduler interno: dispara cron de lembretes e onboarding diariamente às 08:00 BRT
    cron.schedule("0 8 * * *", async () => {
      console.log("[INTERNAL-CRON] Disparando runAvisoCron às", new Date().toISOString());
      try {
        await runAvisoCron({ requestedBy: "internal-scheduler" });
      } catch (e) {
        console.error("[INTERNAL-CRON] Erro em runAvisoCron:", e.message);
        if (ADMIN_WA_NUMBER) {
          sendText(ADMIN_WA_NUMBER,
            `🚨 *Cron falhou* — runAvisoCron\nErro: ${e.message}\nHorário: ${new Date().toISOString()}\n\n_Verifique logs do PM2._`,
            { bypassWindow: true }
          ).catch(() => {});
        }
      }
      try {
        await runOnboardingCron({ requestedBy: "internal-scheduler" });
      } catch (e) {
        console.error("[INTERNAL-CRON] Erro em runOnboardingCron:", e.message);
        if (ADMIN_WA_NUMBER) {
          sendText(ADMIN_WA_NUMBER,
            `🚨 *Cron falhou* — runOnboardingCron\nErro: ${e.message}\nHorário: ${new Date().toISOString()}\n\n_Verifique logs do PM2._`,
            { bypassWindow: true }
          ).catch(() => {});
        }
      }
      try {
        await runReengagementCron({ requestedBy: "internal-scheduler" });
      } catch (e) {
        console.error("[INTERNAL-CRON] Erro em runReengagementCron:", e.message);
        if (ADMIN_WA_NUMBER) {
          sendText(ADMIN_WA_NUMBER,
            `🚨 *Cron falhou* — runReengagementCron\nErro: ${e.message}\nHorário: ${new Date().toISOString()}\n\n_Verifique logs do PM2._`,
            { bypassWindow: true }
          ).catch(() => {});
        }
      }
      console.log("[INTERNAL-CRON] Concluído às", new Date().toISOString());
    }, { timezone: "America/Sao_Paulo" });
    console.log("[BOOT] Scheduler interno configurado: cron diário às 08:00 BRT");

    // Após boot, verifica se o cron de hoje foi pulado (ex: PM2 reiniciou após 08:00)
    setTimeout(async () => {
      try {
        const now = new Date();
        const brHour = (now.getUTCHours() - 3 + 24) % 24;
        if (brHour < 8) return; // Ainda não deu 08:00 BRT hoje, nada a verificar

        const todayKey = getTodayBRTKey();
        const lockPath = `${AVISO_LOCK_DIR}/finplanner-aviso-${todayKey}.lock`;
        if (fs.existsSync(lockPath)) return; // Cron já rodou

        const inRecoveryWindow = brHour >= 8 && brHour < 12; // 08h-12h BRT
        console.warn(`[BOOT] ⚠️ Cron de hoje (${todayKey}) não rodou — lock ausente. brHour=${brHour}, autoRun=${inRecoveryWindow}`);

        if (inRecoveryWindow) {
          if (ADMIN_WA_NUMBER) {
            sendText(ADMIN_WA_NUMBER,
              `🔄 *Cron recuperado automaticamente*\n` +
              `Data: ${todayKey}\n` +
              `Boot: ${now.toISOString()} (${brHour}h BRT)\n\n` +
              `_Bot reiniciou após as 08:00, disparando runAvisoCron + runOnboardingCron agora._`,
              { bypassWindow: true }
            ).catch(() => {});
          }
          try {
            await runAvisoCron({ requestedBy: "boot-recovery" });
          } catch (e) {
            console.error("[BOOT-RECOVERY] Erro em runAvisoCron:", e.message);
            if (ADMIN_WA_NUMBER) {
              sendText(ADMIN_WA_NUMBER,
                `🚨 *Recovery falhou* — runAvisoCron\nErro: ${e.message}`,
                { bypassWindow: true }
              ).catch(() => {});
            }
          }
          try {
            await runOnboardingCron({ requestedBy: "boot-recovery" });
          } catch (e) {
            console.error("[BOOT-RECOVERY] Erro em runOnboardingCron:", e.message);
            if (ADMIN_WA_NUMBER) {
              sendText(ADMIN_WA_NUMBER,
                `🚨 *Recovery falhou* — runOnboardingCron\nErro: ${e.message}`,
                { bypassWindow: true }
              ).catch(() => {});
            }
          }
        } else if (ADMIN_WA_NUMBER) {
          // Fora da janela de recovery (>= 12h BRT) — só avisa, não dispara
          sendText(ADMIN_WA_NUMBER,
            `⚠️ *Cron pode ter sido pulado*\n` +
            `Data: ${todayKey}\n` +
            `Boot: ${now.toISOString()} (${brHour}h BRT)\n\n` +
            `_Fora da janela segura de auto-recovery (08h-12h). ` +
            `Mande "cron teste" pra disparar manualmente se desejar._`,
            { bypassWindow: true }
          ).catch(() => {});
        }
      } catch (e) {
        console.error("[BOOT] Erro ao verificar cron missed:", e.message);
      }
    }, 30_000); // 30s pra dar tempo do boot completar (sheets, migração, etc.)
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
  getCanonicalUserId,
  getLastInteractionInfo,
  recordUserInteraction,
  setLastInteractionForTest,
};
