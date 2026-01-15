// ============================
// FinPlanner IA - Bot do WhatsApp
// Versão: app.js v2025-10-23.1
// ============================

import express de "express";
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
const STRIPE_PRICE_MENSAL = process.env.STRIPE_PRICE_MENSAL;
const STRIPE_PRICE_TRIMESTRAL = process.env.STRIPE_PRICE_TRIMESTRAL;
const STRIPE_PRICE_ANUAL = process.env.STRIPE_PRICE_ANUAL;
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL;
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL;

const {
  PORTA,
  ID_DAS_PLANILHAS,
  E-MAIL DA CONTA DE SERVIÇO DO GOOGLE,
  GOOGLE_SERVICE_ACCOUNT_KEY: RAW_KEY = "",
  WA_TOKEN,
  WA_PHONE_NUMBER_ID,
  NÚMERO_ADMIN_WA,
  WEBHOOK_VERIFY_TOKEN,
  STRIPE_WEBHOOK_SECRET,
} = process.env;

const USE_OPENAI = (USE_OPENAI_RAW || "false").toLowerCase() === "true";
const DEBUG_SHEETS = (DEBUG_SHEETS_RAW || "false").toLowerCase() === "true";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const openaiClient = USE_OPENAI && OPENAI_API_KEY ? novo OpenAI ({apiKey: OPENAI_API_KEY }): nulo;
const OPENAI_INTENT_MODEL = process.env.OPENAI_INTENT_MODEL || "gpt-4o-mini";
const OPENAI_CATEGORY_MODEL = process.env.OPENAI_CATEGORY_MODEL || OPENAI_INTENT_MODEL;

se (USE_OPENAI && !openaiClient) {
  console.warn("OpenAI ativado, mas OPENAI_API_KEY não foi informado. Usando detecção heurística.");
}

const normalizePromptMessages = (input) => {
  if (!Array.isArray(input)) return [];
  return input.map((message) => {
    const parts = Array.isArray(message?.content) ? message.content : [message?.content];
    const texto = partes
      .map((part) => {
        se (!parte) retorne "";
        se (tipo de parte === "string") retorne parte;
        Se (typeof part?.text === "string") retornar part.text;
        return typeof part === "object" ? JSON.stringify(part) : "";
      })
      .filter(Boolean)
      .join("\n");
    return { role: message?.role || "user", content: text };
  });
};

const callOpenAI = async ({ model, input, temperature = 0, maxOutputTokens = 50 }) => {
  se (!openaiClient) retornar nulo;
  const mensagens = normalizarPromptMessages(entrada);
  tentar {
    const responsesClient = openaiClient.responses;
    se (responsesClient && typeof responsesClient.create === "function") {
      const response = await responsesClient.create({
        modelo,
        entrada,
        temperatura,
        max_output_tokens: maxOutputTokens,
      });
      retornar resposta?.texto_saída?.trim() || nulo;
    }
    const chatCompletionsClient = openaiClient.chat?.completions;
    se (chatCompletionsClient && typeof chatCompletionsClient.create === "function") {
      const response = await chatCompletionsClient.create({
        modelo,
        mensagens: mensagens.length ? mensagens : [{ role: "user", content: typeof input === "string" ? input : JSON.stringify(input) }],
        temperatura,
        max_tokens: maxOutputTokens,
      });
      retornar resposta?.escolhas?.[0]?.mensagem?.conteúdo?.trim() || nulo;
    }
    const completionsClient = openaiClient.completions;
    se (completionsClient && typeof completionsClient.create === "function") {
      const prompt = (messages.length ? messages : [{ role: "user", content: typeof input === "string" ? input : JSON.stringify(input) }])
        .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
        .join("\n\n");
      const response = await completionsClient.create({
        modelo,
        incitar,
        temperatura,
        max_tokens: maxOutputTokens,
      });
      retornar resposta?.escolhas?.[0]?.texto?.trim() || nulo;
    }
    console.warn("Cliente OpenAI inicializado, mas nenhum método compatível foi encontrado.");
  } catch (erro) {
    lançar erro;
  }
  retornar nulo;
};

// ============================
// Correção para autenticação do Google (suporta caracteres literais \n)
// ============================
let GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY || "";
se (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}

// ============================
// Aplicativo
// ============================
const app = express();

// Webhook do Stripe (corpo bruto) - endpoint: /webhook/stripe
// Eventos no Stripe Dashboard:
// - finalização de compra.sessão.concluída
// - invoice.payment_succeeded
// - invoice.payment_failed
// - assinatura do cliente excluída
app.post("/webhook/stripe", express.raw({ type: "application/json" }), handleStripeWebhook);

app.use(express.json());

app.get("/", (_req, res) => {
  res.send("FinPlanner IA ativo! 🚀");
});

app.post("/checkout", async (req, res) => {
  se (!listra) {
    return res.status(500).json({ error: "Stripe não configurado." });
  }
  const { plano, whatsapp, nome, email } = req.body || {};
  se (!whatsapp) {
    return res.status(400).json({ error: "whatsapp obrigatório." });
  }
  const planoNorm = normalizePlan(plano) || "mensal";
  const priceMap = {
    mensal: STRIPE_PRICE_MENSAL,
    trimestral: STRIPE_PRICE_TRIMESTRAL,
    anual: STRIPE_PRICE_ANNUAL,
  };
  const priceId = priceMap[planoNorm];
  se (!priceId) {
    return res.status(400).json({ error: "Plano inválido ou price não configurado." });
  }
  se (!STRIPE_SUCCESS_URL || !STRIPE_CANCEL_URL) {
    return res.status(500).json({ error: "URLs de checkout não configuradas." });
  }

  console.log("Checkout criar payload:", { plan: planNorm, whatsapp: !!whatsapp });

  tentar {
    const session = await stripe.checkout.sessions.create({
      modo: "assinatura",
      itens_da_linha: [{ preço: id_do_preço, quantidade: 1 }],
      URL de sucesso: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      dados_de_assinatura: {
        metadados: {
          WhatsApp: String(whatsapp || ""),
          plano: planoNorm,
          nome: String(nome || ""),
          email: String(email || ""),
        },
      },
      metadados: {
        WhatsApp: String(whatsapp || ""),
        plano: planoNorm,
      },
    });
    retornar res.status(200).json({ url: session.url });
  } catch (erro) {
    console.error("Erro ao criar checkout:", error.message);
    return res.status(500).json({ error: "Erro ao criar checkout." });
  }
});

// ============================
// Utilitários
// ============================
const normalizeUser = (num) => (num || "").replace(/\D/g, "");
const userFirstNames = novo Map();

const extractFirstName = (value) => {
  se (!valor) retorne "";
  const cleaned = value.toString().trim();
  se (!limpo) retorne "";
  const parts = cleaned.split(/\s+/);
  const first = parts[0] || "";
  retornar primeiro;
};

const rememberUserName = (userNorm, fullName) => {
  Se (!userNorm || !fullName) retorne;
  const first = extractFirstName(fullName);
  se (!primeiro) retornar;
  userFirstNames.set(userNorm, first);
};

const getStoredFirstName = (userNorm) => {
  se (!userNorm) retornar "";
  retornar userFirstNames.get(userNorm) || "";
};

const processedMessages = new Map();
const MESSAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const lastInboundInteraction = new Map();
const reminderAdminNotice = new Map();
const WA_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const userStatusCache = new Map();
const USER_CACHE_TTL_MS = 60*1000;

const recordUserInteraction = (userNorm) => {
  se (!userNorm) retornar;
  últimaInteraçãoDeEntrada.set(normaDoUsuário, Data.agora());
};

função hasRecentUserInteraction(userNorm) {
  se (!userNorm) retornar falso;
  const último = últimaInteraçãoDeEntrada.get(userNorm);
  return typeof last === "number" && Date.now() - last <= WA_SESSION_WINDOW_MS;
}

const shouldNotifyAdminReminder = (userNorm) => {
  se (!userNorm) retornar falso;
  const hoje = new Date().toISOString().split("T")[0];
  const key = reminderAdminNotice.get(userNorm);
  se (chave === hoje) retorne falso;
  avisoDoAdministradorDeLembrete.set(normaDoUsuário, hoje);
  retornar verdadeiro;
};

const isDuplicateMessage = (id) => {
  se (!id) retornar falso;
  const now = Date.now();
  para (const [storedId, ts] de processedMessages) {
    se (agora - ts > MESSAGE_CACHE_TTL_MS) {
      processedMessages.delete(storedId);
    }
  }
  se (processedMessages.has(id)) {
    retornar verdadeiro;
  }
  processedMessages.set(id, now);
  retornar falso;
};
const NUMBER_WORDS = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  três: 3,
  três: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  novo: 9,
  dez: 10,
  o nosso: 11,
  dose: 12,
  treze: 13,
  quatorze: 14,
  quatorze: 14,
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
  "e",
  "fazer",
  "o",
  "dos",
  "reais",
  "real",
  "centavos",
  "centavo",
  "R$",
]);

const normalizeDiacritics = (texto) =>
  (texto || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const escapeRegex = (value) => (value || "").replace(/([.*+?^${}()|\[\]\\])/g, "\\$1");

const parseNumberWordsTokens = (tokens) => {
  seja total = 0;
  seja atual = 0;
  para (const token de tokens) {
    se (!token) continue;
    se (NUMBER_CONNECTORS.has(token)) continue;
    se (token === "mil") {
      total += (atual || 1) * 1000;
      atual = 0;
      continuar;
    }
    const value = NUMBER_WORDS[token];
    se (tipo de valor === "número") {
      valor atual += valor;
    } outro {
      retornar nulo;
    }
  }
  retornar total + atual || nulo;
};

const extractNumberWords = (text) => {
  const normalizado = normalizarDiacritics(texto).toLowerCase();
  const tokens = normalized.split(/[^az$]+/).filter(Boolean);
  seja sequência = [];
  para (const token de tokens) {
    if (NUMBER_CONNECTORS.has(token) || NUMBER_WORDS[token] !== undefined || token === "mil") {
      sequência.push(token);
    } else if (sequence.length) {
      quebrar;
    }
  }
  Se (!sequence.length) retornar nulo;
  const parsed = parseNumberWordsTokens(sequence);
  se (!analisado) retorne nulo;
  retornar { quantidade: analisado, bruto: sequência.join(" ") };
};

const DATE_TOKEN_PATTERN = "\\b(\\d{1,2}[\\/-]\\d{1,2}(?:[\\/-]\\d{2,4})?)\\b";
const VALUE_TOKEN_PATTERN =
  "(?:R\\$?\\s*)?(?:\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)(?!\\s*[\\/-]\\d)";

const parseNumericToken = (rawToken) => {
  Se (rawToken === undefined || rawToken === null) retorne null;
  let token = rawToken.toString().trim().toLowerCase();
  se (!token) retornar nulo;

  token = token.replace(/^r\$/i, "");

  se (token.terminaCom("mil")) {
    const baseToken = token.slice(0, -3).trim();
    const baseValue = baseToken ? parseNumericToken(baseToken) : 1;
    retornar valorBase ? valorBase * 1000 : nulo;
  }

  seja multiplicador = 1;
  se (token.terminaCom("k")) {
    multiplicador = 1000;
    token = token.slice(0, -1);
  }

  token = token.replace(/^r\$/i, "").replace(/\s+/g, "");
  token = token.replace(/[^0-9.,-]/g, "");
  se (!token) retornar nulo;

  se (token.includes(".") && token.includes(",")) {
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
    se (decimais === 3 && token.replace(/[^0-9]/g, "").length > 3) {
      token = token.replace(/,/g, "");
    } outro {
      token = token.replace(/,/g, ".");
    }
  } else if (token.includes(".")) {
    const lastDot = token.lastIndexOf(".");
    const decimals = token.length - lastDot - 1;
    se (decimais === 3 && token.replace(/[^0-9]/g, "").length > 3) {
      token = token.replace(/\./g, "");
    }
  }

  const analisado = parseFloat(token);
  Se (!Number.isFinite(parsed)) retorne nulo;
  retornar multiplicador analisado;
};

const extractAmountFromText = (text) => {
  se (!texto) retorne { quantidade: 0 };
  const source = text.toString();

  const dataRegexGlobal = new RegExp(DATE_TOKEN_PATTERN, "g");
  const dateMatches = [...source.matchAll(dataRegexGlobal)];
  const spans = dateMatches.map((match) => ({
    início: match.index,
    fim: match.index + match[0].length,
  }));

  const inlineTrailingDateRegex = /[\/-]\s*\d{1,2}(?:[\/-]\d{2,4})?/g;
  deixe arrastando;
  enquanto ((trailing = inlineTrailingDateRegex.exec(source)) !== null) {
    const prevChar = source[trailing.index - 1];
    se (prevChar && /\d/.test(prevChar)) {
      spans.push({ start: trailing.index, end: trailing.index + trailing[0].length });
    }
  }

  spans.sort((a, b) => a.start - b.start);

  const valorRegexGlobal = new RegExp(VALUE_TOKEN_PATTERN, "gi");
  que combine;
  enquanto ((match = valorRegexGlobal.exec(source)) !== null) {
    const start = match.index;
    const fim = início + correspondência[0].comprimento;
    if (spans.some((span) => start < span.end && end > span.start)) continue;
    const raw = match[0];
    const value = parseNumericToken(raw);
    se (valor) retornar { quantidade: valor, bruto };
  }

  const palavras = extrairPalavrasNuméricas(fonte);
  se (palavras) retornar palavras;

  seja sanitizado = fonte;
  se (spans.length) {
    const chars = Array.from(source);
    spans.forEach(({ start, end }) => {
      para (seja i = início; i < fim; i += 1) {
        chars[i] = " ";
      }
    });
    sanitized = chars.join("");
  }
  const fallbackRegex = /\d+(?:[.,]\d+)?k|\d+/gi;
  enquanto ((match = fallbackRegex.exec(sanitized)) !== null) {
    const raw = match[0];
    const resto = sanitizado.slice(match.index + raw.length);
    const trailingDigits = remainder.match(/^\s*[\/-]\s*\d/);
    se (dígitos_traseiros) continuar;
    seja cursor = 0;
    enquanto (cursor < resto.comprimento && /\s/.teste(resto[cursor])) cursor += 1;
    se (cursor < resto.comprimento && /\d/.teste(resto[cursor])) continue;
    const value = parseNumericToken(raw);
    se (valor) retornar { quantidade: valor, bruto };
  }

  retornar { quantidade: 0 };
};

const toNumber = (valor) => {
  se (valor === indefinido || valor === nulo) retorne 0;
  Se (tipo de valor === "número") retornar valor;
  const result = extractAmountFromText(String(value));
  return Number.isFinite(result.amount) ? result.amount : 0;
};
const formatCurrencyBR = (valor) => {
  const num = Number(value || 0);
  retornar `R$${Math.abs(num).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const formatSignedCurrencyBR = (valor) => {
  const num = Number(value || 0);
  const formatted = formatCurrencyBR(Math.abs(num));
  retornar num < 0 ? `-${formatado}` : formatado;
};
const statusIconLabel = (status) => {
  const normalizado = (status || "").toString().toLowerCase();
  se (normalizado === "pago") retornar "✅ Pago";
  if (normalized === "recebido") return "✅ Recebido";
  return "⏳ Pendente";
};

const startOfDay = (d) => {
  const tmp = new Date(d);
  tmp.setHours(0, 0, 0, 0);
  retornar tmp;
};
const fimDoDia = (d) => {
  const tmp = new Date(d);
  tmp.setHours(23, 59, 59, 999);
  retornar tmp;
};
const startOfMonth = (y, m) => new Date(y, m, 1, 0, 0, 0, 0);
const fimDoMês = (y, m) => new Date(y, m + 1, 0, 23, 59, 59, 999);

const diasNoMês = (ano, índiceDoMês) => new Date(ano, índiceDoMês + 1, 0).getDate();
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const addDays = (date, days) => {
  const result = new Date(date);
  resultado.setDate(resultado.getDate() + dias);
  retornar resultado;
};

const nextMonthlyDate = (day, referenceDate, { inclusive = false } = {}) => {
  const referência = inícioDoDia(dataReferência);
  seja ano = referência.getFullYear();
  seja mês = referência.getMonth();
  const buildDate = (y, m) => {
    const safeDay = clamp(Math.round(day), 1, daysInMonth(y, m));
    const instance = new Date(y, m, safeDay);
    instância.setHours(0, 0, 0, 0);
    retornar instância;
  };
  seja candidato = dataDeConstrução(ano, mês);
  enquanto (inclusivo ? candidato < referência : candidato <= referência) {
    mês += 1;
    se (mês > 11) {
      mês = 0;
      ano += 1;
    }
    candidato = dataDeConstrução(ano, mês);
  }
  retornar candidato;
};

const nextIntervalDate = (intervalDays, startDate, fromDate = new Date()) => {
  const intervalo = Math.max(Math.round(intervaloDias), 1);
  const base = startOfDay(startDate);
  const from = startOfDay(fromDate);
  se (base.getTime() >= from.getTime()) retorne base;
  const diffMs = from.getTime() - base.getTime();
  const steps = Math.ceil(diffMs / (interval * 24 * 60 * 60 * 1000));
  const candidate = addDays(base, steps * interval);
  se (candidato.getTime() >= de.getTime()) retorne candidato;
  retornar adicionarDias(candidato, intervalo);
};

const formatBRDate = (d) => {
  se (!d) retorne "";
  tentar {
    retornar novo Date(d).toLocaleDateString("pt-BR");
  } catch (e) {
    retornar "";
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
  retornar String(n)
    .dividir("")
    .map((d) => map[d] || d)
    .juntar("");
};

const withinRange = (dt, start, end) => {
  se (!dt) retornar falso;
  const time = new Date(dt).getTime();
  retornar tempo >= início.getTime() && tempo <= fim.getTime();
};

const parseDateToken = (token) => {
  se (!token) retornar nulo;
  const lower = token.toLowerCase();
  se (lower === "hoje") retorne new Date();
  if (lower === "amanha" || lower === "amanhã") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    retornar d;
  }
  se (inferior === "ontem") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    retornar d;
  }
  const match = token.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
  se (correspondência) {
    const dia = Número(match[1]);
    const mês = Número(match[2]) - 1;
    const currentYear = new Date().getFullYear();
    seja ano = anoAtual;
    se (match[3]) {
      ano = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    } outro {
      const tentative = new Date(currentYear, month, day);
      const now = new Date();
      se (tentativo < inícioDoDia(agora)) {
        ano = anoAtual + 1;
      }
    }
    const d = new Date(ano, mês, dia);
    if (!Número.isNaN(d.getTime())) return d;
  }
  retornar nulo;
};

const DEFINIÇÕES_DE_CATEGÓRIA = [
  {
    slug: "mercado",
    rótulo: "Mercado / Supermercado",
    emoji: "🛒",
    description: "Compras de supermercado, feira e itens de despensa para casa.",
    Palavras-chave: [
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
      "estrada básica",
    ],
    aliases: ["supermercado", "mercado_supermercado"],
  },
  {
    slug: "alimentacao",
    label: "Alimentação",
    emoji: "🍽️",
    description: "Refeições prontas, lanches e alimentação fora de casa.",
    Palavras-chave: [
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
      "entrega",
      "comida pronta",
      "quentinha",
      "espetinho",
    ],
  },
  {
    lesma: "bebidas",
    rótulo: "Bebidas",
    emoji: "🍹",
    description: "Bebidas alcoólicas ou não alcoólicas compradas separadamente da refeição.",
    Palavras-chave: [
      "bebida",
      "cerveja",
      "refrigerante",
      "vinho",
      "bebida",
      "bebidas",
      "bar",
      "chopp",
      "suco",
      "água",
      "água",
      "uísque",
      "Gin",
      "café",
      "café",
      "enérgico",
      "enérgico",
    ],
  },
  {
    slug: "higiene_pessoal",
    label: "Higiene Pessoal",
    emoji: "🧴",
    description: "Produtos de cuidado pessoal, higiene e cosméticos.",
    Palavras-chave: [
      "higiene",
      "sabonete",
      "xampu",
      "condicionador",
      "creme",
      "desodorante",
      "perfume",
      "escova",
      "massa",
      "fio dental",
      "absorvente",
      "barbeador",
      "cotonete",
      "higiene pessoal",
      "cosmético",
      "cosmético",
    ],
  },
  {
    slug: "utilitários",
    rótulo: "Serviços públicos",
    emoji: "🔌",
    description: "Contas essenciais como luz, água e gás.",
    keywords: ["luz", "energia", "água", "agua", "gás", "gas", "conta de luz", "conta de agua"],
  },
  {
    slug: "internet_telefonia",
    Rótulo: "Internet / Telefonia"
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
    lesma: "transporte",
    label: "Transporte",
    emoji: "🚗",
    description: "Deslocamentos, combustível, pedágios e manutenção de veículos.",
    Palavras-chave: [
      "uber",
      "99",
      "gasolina",
      "combustível",
      "combustivel",
      "passagem",
      "ônibus",
      "todos",
      "transporte",
      "estacionamento",
      "pedágio",
      "pedagio",
      "manutenção carro",
      "manutencao carro",
    ],
  },
  {
    lesma: "salsicha",
    label: "Saúde",
    emoji: "💊",
    description: "Cuidados com saúde, planos, exames e medicamentos.",
    Palavras-chave: [
      "academia",
      "plano",
      "consulta",
      "dentista",
      "farmácia",
      "farmácia",
      "remédio",
      "remédio",
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
    lesma: "laser",
    rótulo: "Laser",
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
    lesma: "outros",
    label: "Outros",
    emoji: "🧩",
    description: "Despesas ou receitas que não se encaixam nas demais categorias.",
    palavras-chave: [],
  },
];

const sanitizeCategoryKey = (valor) => {
  se (!valor) retorne "";
  retornar normalizarDiacritics(valor.toString().toLowerCase())
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
};

const CATEGORIA_POR_SLUG = novo Mapa();
DEFINIÇÕES_DE_CATEGÓRIA.paraCada((categoria) => {
  categoria.palavras-chave normalizadas = (categoria.palavras-chave || []).map((kw) => normalizarDiacritics(kw));
  const keys = new Set([
    sanitizeCategoryKey(category.slug),
    sanitizeCategoryKey(category.label),
  ]);
  (category.aliases || []).forEach((alias) => keys.add(sanitizeCategoryKey(alias)));
  keys.forEach((key) => {
    se (chave) CATEGORIA_POR_SLUG.definir(chave, categoria);
  });
});

const getCategoryDefinition = (slug) => {
  const key = sanitizeCategoryKey(slug);
  se (!chave) retornar nulo;
  retornar CATEGORY_BY_SLUG.get(chave) || nulo;
};

const humanizeCategorySlug = (valor) => {
  const raw = (value || "").toString().trim();
  se (!raw) retornar "";
  const parts = raw.split(/[_-]+/).filter(Boolean);
  se (!parts.length) retorne bruto;
  return parts.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" / ");
};

const detectarHeurísticaDeCategoria = (descrição, tipo) => {
  const normalizado = normalizarDiacritics((descrição || "").toLowerCase());
  para (const categoria de DEFINIÇÕES_DE_CATEGORIA) {
    const keywords = category.normalizedKeywords || [];
    se (palavras-chave.algumas((kw) => kw && normalized.includes(kw))) {
      retornar { slug: categoria.slug, emoji: categoria.emoji };
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
  se (!rótulo || rótulo === "—") {
    retornar ícone ? `${icon} —` : "—";
  }
  retornar ícone ? `${ícone} ${rótulo}` : rótulo;
};

const CATEGORY_PROMPT_HINT = CATEGORY_DEFINITIONS.map((category) => {
  const samples = (category.keywords || []).slice(0, 5);
  const detail = category.description ? ` - ${category.description}` : "";
  const sampleText = samples.length ? ` Exemplos: ${samples.join(", ")}.` : "";
  retornar `${category.slug}: ${category.label}${detail}${sampleText}`;
}).join("\n");

const truncateForPrompt = (value, max = 200) => {
  se (!valor) retorne "";
  const str = value.toString().trim();
  se (str.length <= max) retorne str;
  retornar `${str.slice(0, max - 1)}…`;
};

const buildCategoryPrompt = (descrição, tipo) => [
  {
    função: "sistema",
    contente: [
      {
        tipo: "texto",
        texto:
          "Você é um classificador de categorias financeiras. Responda apenas com um dos slugs informados, sem explicações.",
      },
    ],
  },
  {
    função: "usuário",
    contente: [
      {
        tipo: "texto",
        text: `Categorias disponíveis:\n${CATEGORY_PROMPT_HINT}\n\nDescrição do lançamento: "${truncateForPrompt(
          descrição,
        )}"\nTipo do lançamento: ${tipo === "conta_receber" ? "recebimento" : "pagamento"}\nResponda apenas com o slug mais adequado.`,
      },
    ],
  },
];

const resolveCategory = async (description, tipo) => {
  const fallback = detectCategoryHeuristic(descrição, tipo);
  if (!description || !description.toString().trim() || !openaiClient) return fallback;
  tentar {
    const output = await callOpenAI({
      modelo: OPENAI_CATEGORY_MODEL,
      entrada: buildCategoryPrompt(descrição, tipo),
      temperatura: 0,
      maxOutputTokens: 50,
    });
    const predicted = output?.trim();
    const def = getCategoryDefinition(previsto);
    se (!def && previsto) {
      const pieces = predicted.split(/\s|,|;|\n/).filter(Boolean);
      para (const pedaço de pedaços) {
        const candidate = getCategoryDefinition(piece);
        se (candidato) {
          retornar { slug: candidate.slug, emoji: candidate.emoji };
        }
      }
    }
    se (def) retornar { slug: def.slug, emoji: def.emoji };
  } catch (erro) {
    console.error("Falha ao consultar OpenAI para categoria:", error?.message || error);
  }
  retornar opção alternativa;
};

// ============================
// Auxiliares do WhatsApp
// ============================
const WA_API_VERSION = "v17.0";
const WA_API = `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
const WA_TEXT_LIMIT = 4000;
const TEMPLATE_REMINDER_NAME = "lembrete_finplanner_1";
const TEMPLATE_REMINDER_BUTTON_ID = "REMINDERS_VIEW";
const ADMIN_NUMBER_NORM = ADMIN_WA_NUMBER ? normalizeUser(ADMIN_WA_NUMBER) : null;

const splitLongMessage = (texto, limite = WA_TEXT_LIMIT) => {
  se (!texto) retorne [];
  se (texto.comprimento <= limite) retorne [texto];
  const parts = [];
  seja o restante = texto;
  enquanto (comprimento restante > limite) {
    let sliceIndex = remaining.lastIndexOf("\n", limit);
    se (sliceIndex === -1 || sliceIndex < limite * 0,5) {
      const spaceIndex = remaining.lastIndexOf(" ", limit);
      se (spaceIndex > sliceIndex) {
        sliceIndex = spaceIndex;
      }
    }
    se (sliceIndex === -1 || sliceIndex === 0) {
      sliceIndex = limite;
    }
    const chunk = remaining.slice(0, sliceIndex).trimEnd();
    se (pedaço) {
      partes.empurrar(pedaço);
    }
    restante = restante.fatia(índiceDaFatia).trimStart();
    se (!restante) {
      quebrar;
    }
    se (comprimento restante <= limite) {
      partes.empurrar(restante);
      devolver peças;
    }
  }
  se (restante && restante.comprimento <= limite) {
    partes.empurrar(restante);
  }
  devolver peças;
};

função assíncrona enviarWA(carga útil) {
  tentar {
    aguarde axios.post(WA_API, payload, {
      cabeçalhos: {
        Autorização: `Portador ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    retornar verdadeiro;
  } catch (erro) {
    console.error("Erro WA:", error.response?.data || error.message);
    retornar falso;
  }
}

const sendTemplateReminder = async (to, userNorm, nameHint = "") => {
  const firstName = (nameHint || getStoredFirstName(userNorm) || "").trim();
  const payload = {
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "modelo",
    modelo: {
      nome: TEMPLATE_REMINDER_NAME,
      idioma: { código: "pt_BR" },
      componentes: [
        {
          tipo: "corpo",
          parâmetros: [{ tipo: "texto", texto: nome }],
        },
        {
          tipo: "botão",
          sub_tipo: "resposta_rápida",
          índice: "0",
          parâmetros: [{ tipo: "payload", payload: TEMPLATE_REMINDER_BUTTON_ID }],
        },
      ],
    },
  };
  const sucesso = await sendWA(payload);
  se (sucesso) {
    console.log("✅ Template de reengajamento enviado para", to);
  }
  retorno bem-sucedido;
};

const ensureSessionWindow = async ({ to, userNorm, nameHint, bypassWindow = false }) => {
  se (!para) retornar falso;
  se (bypassWindow) retornar verdadeiro;
  se (userNorm && ADMIN_NUMBER_NORM && userNorm === ADMIN_NUMBER_NORM) {
    retornar verdadeiro;
  }
  se (hasRecentUserInteraction(userNorm)) {
    retornar verdadeiro;
  }
  aguarde sendTemplateReminder(to, userNorm, nameHint);
  retornar falso;
};

const sendText = async (to, body, options = {}) => {
  se (!para || !corpo) retorne falso;
  const userNorm = normalizeUser(to);
  const nameHint = options.nameHint || getStoredFirstName(userNorm);
  const canSend = await ensureSessionWindow({
    para,
    userNorm,
    Dica de nome,
    bypassWindow: options.bypassWindow || false,
  });
  Se (!canSend) retornar falso;
  const segmentos = splitLongMessage(corpo);
  seja allDelivered = verdadeiro;
  const total = segmentos.comprimento || 1;
  se (total === 0) retorne falso;
  para (seja índice = 0; índice < segmentos.comprimento; índice += 1) {
    const segment = segments[index];
    const sucesso = aguardar enviarWA({
      produto_de_mensagens: "whatsapp",
      para,
      tipo: "texto",
      texto: { corpo: segmento },
    });
    se (sucesso) {
      const sufixo = total > 1 ? ` (parte ${index + 1}/${total})` : "";
      console.log("💬 Mensagem enviada normalmente para", to, suffix);
    } outro {
      todosEntregues = falso;
      quebrar;
    }
  }
  retornar todos os entregues;
};

const sendCopyButton = (to, title, code, btnTitle) => {
  se (!código) retornar;
  const safeTitle = btnTitle.length > 20 ? `${btnTitle.slice(0, 17)}...` : btnTitle;
  retornar sendWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "botão",
      corpo: { texto: título },
      Ação: {
        botões: [
          {
            tipo: "código_de_cópia",
            copy_code: código,
            título: safeTitle,
          },
        ],
      },
    },
  });
};

// ============================
// Auxiliares do Google Sheets
// ============================
const SHEET_HEADERS = [
  "row_id",
  "carimbo de data/hora",
  "usuário",
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
  "tipo_de_recorrência",
  "valor_de_recorrência",
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
const CONFIG_HEADERS = ["chave", "valor"];
const SHEET_READ_BACKOFF_MS = [1000, 2000, 4000, 8000, 12000];
const USER_SHEET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const userSheetCache = novo Map();

deixe o doc;

função assíncrona ensureAuth() {
  se (doc) retorne doc;
  const auth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    chave: GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
    escopos: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  doc = new GoogleSpreadsheet(SHEETS_ID, auth);
  aguarde doc.loadInfo();
  retornar documento;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async (fn, label) => {
  para (seja tentativa = 0; tentativa < SHEET_READ_BACKOFF_MS.length; tentativa += 1) {
    tentar {
      retornar await fn();
    } catch (erro) {
      const status = error?.response?.status || error?.code;
      se (status === 429 || status === 403) {
        const delay = SHEET_READ_BACKOFF_MS[attempt] + Math.floor(Math.random() * 250);
        console.warn(`🔁 Sheets retry (${label}) tenta ${attempt + 1}: aguardando ${delay}ms`);
        aguardar sleep(atraso);
      } outro {
        lançar erro;
      }
    }
  }
  retornar nulo;
};

função assíncrona ensureSheet() {
  aguarde garantirAuth();
  let sheet = doc.sheetsByTitle["finplanner"];
  se (!folha) {
    planilha = await withRetry(() => doc.addSheet({ title: "finplanner", headerValues: SHEET_HEADERS }), "add-sheet");
  } outro {
    await withRetry(() => sheet.loadHeaderRow(), "load-header-finplanner");
    const current = sheet.headerValues ​​|| [];
    const normalized = current.map((header) => (header || "").trim());
    const hasDuplicate = new Set(normalized.filter(Boolean)).size !== normalized.filter(Boolean).length;
    const missing = SHEET_HEADERS.filter((header) => !normalized.includes(header));
    const orderMismatch = SHEET_HEADERS.some((header, index) => normalized[index] !== header);

    se (hasDuplicate || missing.length || orderMismatch || normalized.length !== SHEET_HEADERS.length) {
      await withRetry(() => sheet.setHeaderRow(SHEET_HEADERS), "set-header-finplanner");
    }
  }
  folha de devolução;
}

função assíncrona ensureSheetUsuarios() {
  aguarde garantirAuth();
  let sheet = doc.sheetsByTitle["Usuarios"];
  se (!folha) {
    planilha = await withRetry(() => doc.addSheet({ title: "Usuários", headerValues: USUARIOS_HEADERS }), "add-usuários");
  } outro {
    await withRetry(() => sheet.loadHeaderRow(), "load-header-usuarios");
    const current = (sheet.headerValues ​​|| []).map((header) => (header || "").trim());
    const filtered = current.filter(Boolean);
    const hasDuplicate = new Set(filtered).size !== filtered.length;
    const missing = USUARIOS_HEADERS.filter((header) => !current.includes(header));
    const orderMismatch = USUARIOS_HEADERS.some((header, index) => current[index] !== header);
    se (hasDuplicate || missing.length || orderMismatch || current.length !== USUARIOS_HEADERS.length) {
      await withRetry(() => sheet.setHeaderRow(USUARIOS_HEADERS), "set-header-usuarios");
    }
  }
  console.log("📄 Cabeçalhos de usuários:", sheet.headerValues);
  folha de devolução;
}

const getUserSheetName = (userNorm) => {
  const base = `Usuario_${userNorm || "desconhecido"}`.replace(/[\\/*?:[\]]/g, "_");
  return base.length > 100 ? base.slice(0, 100) : base;
};

função assíncrona ensureUserSheet(userNorm) {
  aguarde garantirAuth();
  const title = getUserSheetName(userNorm);
  const cached = userSheetCache.get(userNorm);
  se (em cache && cached.expiresAt > Date.now() && cached.title === title) {
    console.log("📌 Cache aba usuário:", { userNorm, title });
  }
  let sheet = doc.sheetsByTitle[title];
  se (!folha) {
    planilha = await withRetry(() => doc.addSheet({ title, headerValues: USER_LANC_HEADERS }), "add-user-sheet");
  } outro {
    await withRetry(() => sheet.loadHeaderRow(), "load-header-user-sheet");
    const current = (sheet.headerValues ​​|| []).map((header) => (header || "").trim());
    const filtered = current.filter(Boolean);
    const hasDuplicate = new Set(filtered).size !== filtered.length;
    const missing = USER_LANC_HEADERS.filter((header) => !current.includes(header));
    const orderMismatch = USER_LANC_HEADERS.some((header, index) => current[index] !== header);
    se (hasDuplicate || missing.length || orderMismatch || current.length !== USER_LANC_HEADERS.length) {
      await withRetry(() => sheet.setHeaderRow(USER_LANC_HEADERS), "set-header-user-sheet");
    }
  }
  userSheetCache.set(userNorm, { title, expiresAt: Date.now() + USER_SHEET_CACHE_TTL_MS });
  folha de devolução;
}

função assíncrona ensureConfigSheet() {
  aguarde garantirAuth();
  let sheet = doc.sheetsByTitle["CONFIG"];
  se (!folha) {
    planilha = await withRetry(() => doc.addSheet({ title: "CONFIG", headerValues: CONFIG_HEADERS }), "add-config");
  } outro {
    await withRetry(() => sheet.loadHeaderRow(), "load-header-config");
    const current = (sheet.headerValues ​​|| []).map((header) => (header || "").trim());
    const filtered = current.filter(Boolean);
    const hasDuplicate = new Set(filtered).size !== filtered.length;
    const missing = CONFIG_HEADERS.filter((header) => !current.includes(header));
    const orderMismatch = CONFIG_HEADERS.some((header, index) => current[index] !== header);
    se (hasDuplicate || missing.length || orderMismatch || current.length !== CONFIG_HEADERS.length) {
      await withRetry(() => sheet.setHeaderRow(CONFIG_HEADERS), "set-header-config");
    }
  }
  folha de devolução;
}

const getConfigValue = async (key) => {
  const sheet = await ensureConfigSheet();
  const rows = await withRetry(() => sheet.getRows(), "get-config");
  const encontrado = linhas?.find((linha) => getVal(linha, "chave") === chave);
  retornar encontrado ? getVal(encontrado, "valor") : "";
};

const setConfigValue = async (key, value) => {
  const sheet = await ensureConfigSheet();
  const rows = await withRetry(() => sheet.getRows(), "get-config");
  const encontrado = linhas?.find((linha) => getVal(linha, "chave") === chave);
  se (encontrado) {
    definirValor(encontrado, "valor", valor);
    await withRetry(() => found.save(), "save-config");
  } outro {
    await withRetry(() => sheet.addRow({ key, value }), "add-config-row");
  }
};

const getVal = (linha, chave) => {
  se (!linha) retornar indefinido;
  if (typeof row.get === "function") return row.get(key);
  se (chave na linha) retorne linha[chave];
  se (row._rawData && row._sheet?.headerValues) {
    const index = row._sheet.headerValues.indexOf(key);
    se (índice >= 0) retorne linha._dadosBruto[índice];
  }
  retornar indefinido;
};

const setVal = (linha, chave, valor) => {
  se (!linha) retornar;
  if (typeof row.set === "function") row.set(key, value);
  senão linha[chave] = valor;
};

const buildUserSheetRow = (entry) => {
  const tipo = getVal(entry, "tipo");
  const valor = getVal(entry, "valor");
  retornar {
    row_id: getVal(entry, "row_id"),
    tipo,
    descricao: getVal(entry, "descricao"),
    categoria: getVal(entrada, "categoria"),
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
  Se (!userNorm || !rowId) retorne;
  const sheet = await ensureUserSheet(userNorm);
  se (skipCheck) {
    await withRetry(() => sheet.addRow(buildUserSheetRow(entry)), "append-user-sheet");
    retornar;
  }
  const rows = await withRetry(() => sheet.getRows(), "get-user-rows");
  const exists = rows?.find((row) => getVal(row, "row_id") === rowId);
  se (existir) retornar;
  await withRetry(() => sheet.addRow(buildUserSheetRow(entry)), "append-user-sheet");
};

função normalizarPlano(entrada) {
  se (!entrada) retorne nulo;
  const p = String(input).trim().toLowerCase();

  se (p === "mensal" || p.includes("mensal") || p === "monthly" || p === "month") retorne "mensal";
  se (p === "trimestral" || p.includes("trim") || p === "quarterly" || p === "quarter") retorne "trimestral";
  se (p === "anual" || p.includes("anual") || p.includes("anu") || p === "yearly" || p === "annual" || p === "year")
    retornar "anual";

  retornar nulo;
}

função escolherPrimeiro(...vals) {
  para (const v de vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  retornar "";
}

função assíncrona getSubscriptionMetadata(stripeClient, subscriptionId) {
  se (!subscriptionId) retornar {};
  tentar {
    const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
    retornar sub?.metadata || {};
  } catch (e) {
    console.error("Erro ao buscar subscription metadata:", e?.message || e);
    retornar {};
  }
}

função isTruthy(v) {
  se (v === verdadeiro) retorne verdadeiro;
  se (v === falso || v == nulo) retorne falso;
  const s = String(v).trim().toLowerCase();
  return ["true", "1", "yes", "y", "sim", "s", "verdadeiro", "ativo", "on"].includes(s);
}

função parseDateLoose(v) {
  se (!v) retornar nulo;
  const s = String(v).trim();
  se (!s) retornar nulo;
  se (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = novo Date(s);
    retornar número. isNaN(d.getTime())? nulo: d;
  }
  se (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split("/").map(Number);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    retornar número. isNaN(d.getTime())? nulo: d;
  }
  const d = novo Date(s);
  retornar número. isNaN(d.getTime())? nulo: d;
}

função obterCandidatosUsuários(normaUsuário) {
  const candidates = new Set();
  se (userNorm) candidatos.adicionar(userNorm);
  const dígitos = String(userNorm || "").replace(/\D/g, "");
  se (digits.startsWith("55") && digits.length === 13 && digits[4] === "9") {
    candidatos.adicionar(dígitos.fatia(0, 4) + dígitos.fatia(5));
  }
  se (digits.startsWith("55") && digits.length === 12) {
    candidatos.adicionar(dígitos.fatia(0, 4) + "9" + dígitos.fatia(4));
  }
  retornar Array.from(candidatos);
}

const adicionarMesesSeguros = (data, meses) => {
  Se (!date || Number.isNaN(date.getTime?.())) retornar nulo;
  const dia = data.getDate();
  const base = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  retornar novo Date(base.getFullYear(), base.getMonth(), Math.min(day, daysInMonth));
};

const formatISODate = (date) => {
  Se (!date || Number.isNaN(date.getTime?.())) retornar "";
  retornar date.toISOString().split("T")[0];
};

const parseISODateSafe = (valor) => {
  Se (!valor) retornar nulo;
  const raw = value.toString().trim();
  se (!raw) retornar nulo;
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = isoMatch ? new Date(`${raw}T00:00:00`) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

const computeNewVencimento = (currentVencISO, plan, baseDate) => {
  const planKey = normalizePlan(plano);
  se (!planKey) retornar nulo;
  const planMonths = { mensal: 1, trimestral: 3, anual: 12 };
  const hoje = inícioDoDia(novo Date());
  const currentDate = parseISODateSafe(currentVencISO);
  base constante =
    currentDate && startOfDay(currentDate).getTime() >= today.getTime()
      ? dataAtual
      : dataBase || novo Date();
  const next = addMonthsSafe(base, planMonths[planKey]);
  retornar formatISODate(próximo);
};

const upsertUsuarioFromSubscription = async ({
  userNorm,
  nome,
  plano,
  e-mail,
  checkout_id,
  data_inicial,
  ativo,
  extendVencimento = false,
}) => {
  if (!userNorm) throw new Error("Usuário inválido.");
  const sheet = await ensureSheetUsuarios();
  const rows = await withRetry(() => sheet.getRows(), "get-usuarios");
  const target = rows.find((row) => normalizeUser(getVal(row, "user")) === userNorm);
  const planoNormalizado = normalizarPlano(plano) || normalizarPlano(obterValor(alvo, "plano"));
  const existingDataInicio = parseISODateSafe(getVal(target, "data_inicio"));
  const payloadDataInicio = parseISODateSafe(data_inicio);
  const baseDataInicio = payloadDataInicio || existingDataInicio || new Date();
  const existingVencimento = getVal(target, "vencimento_plano");
  const vencimento = extendVencimento
    ? computeNewVencimento(existingVencimento, normalizedPlan, baseDataInicio) || existingVencimento
    : existingVencimento || formatISODate(baseDataInicio);
  const nowIso = formatISODate(new Date());
  const atualização = {
    usuário: userNorm,
    plano: planoNormalizado || obterValor(alvo, "plano") || "",
    ativo: ativo ? "true" : "false",
    data_inicio: formatoISODate(baseDataInicio),
    vencimento_plano: vencimento || "",
    email: email || getVal(target, "email") || "",
    nome: nome || getVal(target, "nome") || "",
    checkout_id: checkout_id || getVal(target, "checkout_id") || "",
  };

  se (alvo) {
    Object.entries(update).forEach(([key, value]) => setVal(target, key, value));
    aguarde target.save();
  } outro {
    aguarde sheet.addRow(atualizar);
  }
  const candidates = getUserCandidates(userNorm);
  candidates.forEach((candidate) => usuarioStatusCache.delete(candidate));
  console.log("✅ Usuario atualizado:", userNorm, update.plano, update.ativo);
  retornar atualização;
};

const isUsuarioAtivo = async (userNorm) => {
  se (!userNorm) retornar falso;
  const cached = usuarioStatusCache.get(userNorm);
  Se (em cache && cached.expiresAt > Date.now()) retorne cached.value;
  const sheet = await ensureSheetUsuarios();
  const rows = await withRetry(() => sheet.getRows(), "get-usuarios");
  const candidates = getUserCandidates(userNorm);
  const exact = rows.find((row) => normalizeUser(getVal(row, "user")) === userNorm);
  const candidateMatches = exato
    ? [exato]
    : rows.filter((row) => candidates.includes(normalizeUser(getVal(row, "user"))));
  const pickMostRecent = (lista) =>
    lista
      .fatiar()
      .sort((a, b) => {
        const dateA = parseDateLoose(getVal(a, "data_inicio")) || parseDateLoose(getVal(a, "vencimento_plano")) || new Date(0);
        const dateB = parseDateLoose(getVal(b, "data_inicio")) || parseDateLoose(getVal(b, "vencimento_plano")) || new Date(0);
        retornar dateB.getTime() - dateA.getTime();
      })[0];
  const alvo = exato || escolherMaisRecente(correspondênciasCandidatas);

  se (!alvo) {
    console.log("🔐 Verificação de Acesso:", {
      fromRaw: userNorm,
      userNorm,
      candidatos,
      encontrado: falso,
      ativoVal: nulo,
      ativoOk: false,
      expirationVal: nulo,
      vencOk: falso,
      planoVal: nulo,
    });
    userStatusCache.set(userNorm, { value: false, expiresAt: Date.now() + USER_CACHE_TTL_MS });
    retornar falso;
  }
  console.log("🔎 Linha correspondente:", {
    userNorm,
    candidatos,
    matchedUser: getVal(target, "user"),
    ativoVal: getVal(target, "ativo"),
    planoVal: getVal(target, "plano"),
    vencimentoVal: getVal(target, "vencimento_plano"),
  });
  const ativoRaw = getVal(target, "ativo");
  const ativoOk = isTruthy(ativoRaw);
  se (!ativoOk) {
    console.log("🔐 Verificação de Acesso:", {
      fromRaw: userNorm,
      userNorm,
      candidatos,
      encontrado: verdadeiro,
      activeVal: activeRaw,
      ativoOk: false,
      vencimentoVal: getVal(target, "vencimento_plano"),
      vencOk: falso,
      planoVal: getVal(target, "plano"),
    });
    userStatusCache.set(userNorm, { value: false, expiresAt: Date.now() + USER_CACHE_TTL_MS });
    retornar falso;
  }
  const vencimentoRaw = getVal(target, "vencimento_plano");
  const vencimentoDate = parseDateLoose(vencimentoRaw);
  const hoje = inícioDoDia(novo Date());
  const vencOk = vencimentoDate ? startOfDay(vencimentoDate).getTime() >= today.getTime() : true;
  const planoVal = getVal(target, "plano");
  const active = Boolean(ativoOk && vencOk);
  console.log("🔐 Verificação de Acesso:", {
    fromRaw: userNorm,
    userNorm,
    candidatos,
    encontrado: verdadeiro,
    activeVal: activeRaw,
    ativoOk,
    vencimentoVal: vencimentoRaw,
    vencOk,
    planoVal,
  });
  userStatusCache.set(userNorm, { value: active, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  retornar ativo;
};

const saveRow = (row) => (typeof row.save === "function" ? row.save() : Promise.resolve());

const getEffectiveDate = (row) => {
  const iso = getVal(row, "vencimento_iso");
  const ts = getVal(row, "timestamp");
  se (iso) retorne novo Date(iso);
  se (ts) retorne novo Date(ts);
  retornar nulo;
};

const getRowIdentifier = (row) => (getVal(row, "row_id") || getVal(row, "timestamp") || "").toString();

função assíncrona todasAsLinhasParaUsuário(userNorm) {
  const sheet = await ensureSheet();
  const rows = await withRetry(() => sheet.getRows(), "get-finplanner");
  retornar rows.filter((row) => normalizeUser(getVal(row, "user")) === userNorm);
}

const findRowById = async (userNorm, rowId) => {
  Se (!rowId) retornar nulo;
  const linhas = await todasAsLinhasParaUsuário(userNorm);
  const target = rowId.toString();
  retornar rows.find((row) => getRowIdentifier(row) === target);
};

const withinPeriod = (rows, start, end) => rows.filter((row) => withinRange(getEffectiveDate(row), start, end));
const sumValues ​​= (rows) => rows.reduce((acc, row) => acc + toNumber(getVal(row, "valor")), 0);

// ============================
// Auxiliares de renderização
// ============================
const isRowFixed = (row) => String(getVal(row, "fixa") || "").toLowerCase() === "sim";

const describeRecurrence = (linha) => {
  se (!isRowFixed(linha)) retorne "";
  const tipo = (getVal(row, "recorrencia_tipo") || "").toString().toLowerCase();
  const valorRaw = Number(getVal(row, "recorrencia_valor"));
  se (tipo === "mensal") {
    const reference = getVal(row, "vencimento_iso") || getVal(row, "timestamp");
    const baseDate = reference ? new Date(reference) : new Date();
    const day = Number.isFinite(valorRaw) && valorRaw > 0 ? valorRaw : baseDate.getDate();
    const safeDay = Math.min(Math.max(Math.round(day), 1), 31);
    return `Todo dia ${String(safeDay).padStart(2, "0")} do mês`;
  }
  se (tipo === "intervalo") {
    const days = Number.isFinite(valorRaw) && valorRaw > 0 ? Math.round(valorRaw) : 0;
    se (!dias) retorne "";
    if (days === 7) return "Toda semana";
    if (days === 15) return "A cada 15 dias";
    se (dias % 7 === 0) {
      const semanas = dias / 7;
      return weeks === 1 ? "Toda semana" : `A cada ${weeks} semanas`;
    }
    return `A cada ${days} dias`;
  }
  retornar "";
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
  const campos = [
    `📝 Descrição: ${descricao}`,
    `📂 Categoria: ${categoriaLabel}`,
    `💰 Valor: ${valor}`,
    `📅 Data: ${date}`,
    `🏷 Status: ${statusLabel}`,
    `🔁 Tipo: ${labelType}`,
  ];
  se (isRowFixed(linha)) {
    const recurrenceLabel = describeRecurrence(linha);
    if (recurrenceLabel) fields.push(`🔄 Recorrência: ${recurrenceLabel}`);
  }
  se (rótulo do cabeçalho) {
    retornar `${headerLabel}\n\n${fields.join("\n")}`;
  }
  se (tipo de índice === "número") {
    const numberLine = numberToKeycapEmojis(index);
    retornar [numberLine, "", ...campos].join("\n");
  }
  return `📘 Lançamento\n\n${fields.join("\n")}`;
};

const formatEntrySummary = (row, options = {}) =>
  formatEntryBlock(row, { ...options, headerLabel: options.headerLabel || "📘 Resumo do lançamento" });

const aggregateCategoryTotals = (linhas) => {
  const totais = novo Mapa();
  para (const linha de linhas) {
    const amount = toNumber(getVal(row, "valor"));
    se (!quantidade) continue;
    let slug = (getVal(row, "categoria") || "").toString();
    let emoji = getVal(row, "categoria_emoji");
    se (!slug) {
      const fallback = detectCategoryHeuristic(getVal(row, "descricao") || getVal(row, "conta"), getVal(row, "tipo"));
      slug = fallback.slug;
      emoji = emoji || fallback.emoji;
    }
    const def = getCategoryDefinition(slug) || getCategoryDefinition("outros");
    const key = def?.slug || slug || "outros";
    const label = formatCategoryLabel(key, emoji || def?.emoji);
    const entry = totals.get(key) || { key, label, total: 0 };
    entrada.total += quantidade;
    entrada.rótulo = rótulo;
    totais.definir(chave, entrada);
  }
  return Array.from(totals.values()).sort((a, b) => b.total - a.total);
};

const formatCategoryLines = (linhas) => {
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
const SEÇÕES_DO_MENU_PRINCIPAL = [
  {
    title: "Lançamentos e Contas",
    linhas: [
      { id: "MENU:registrar_pagamento", title: "💰 Registrar pagamento", description: "Adicionar um novo gasto." },
      { id: "MENU:registrar_recebimento", title: "💵 Registrar recebimento", description: "Adicionar uma entrada." },
      { id: "MENU:contas_pagar", title: "📅 Contas a pagar", description: "Ver e confirmar pagamentos pendentes." },
      { id: "MENU:contas_fixas", title: "♻️ Contas fixas", description: "Cadastrar ou excluir contas recorrentes." },
    ],
  },
  {
    title: "Relatórios e Histórico",
    linhas: [
      { id: "MENU:relatorios", title: "📊 Relatórios", description: "Gerar por categoria e período." },
      { id: "MENU:lancamentos", title: "🧾 Meus lançamentos", description: "Ver por mês ou período personalizado." },
    ],
  },
  {
    title: "Ajustes e Ajuda",
    linhas: [
      { id: "MENU:editar", title: "✏️ Editar lançamentos", description: "Alterar registros por número." },
      { id: "MENU:excluir", title: "🗑️ Excluir lançamento", description: "Excluir último ou escolher por número." },
      { id: "MENU:ajuda", title: "⚙️ Ajuda e exemplos", description: "Como usar a FinPlanner IA." },
    ],
  },
];

const sendMainMenu = (to, { greeting = false } = {}) =>
  enviarWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "lista",
      corpo: {
        texto: saudação
          ? `👋 Olá! Eu sou a FinPlanner IA.\n\n💡 Organizo seus pagamentos, ganhos e gastos de forma simples e automática.\n\nToque em *Abrir menu* ou digite o que deseja fazer.`
          : "Toque em *Abrir menu* ou digite o que deseja fazer.",
      },
      Ação: {
        botão: "Abrir menu",
        seções: SEÇÕES_DO_MENU_PRINCIPAL,
      },
    },
  });

const sendWelcomeList = (to) => sendMainMenu(to, { greeting: true });

const sendRelatoriosButtons = (para) =>
  enviarWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "lista",
      body: { text: "📊 Qual relatório você deseja gerar?" },
      Ação: {
        button: "Abrir opções",
        seções: [
          {
            title: "Tipos de relatório",
            linhas: [
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

const sendPeriodoButtons = (para, prefixo) =>
  enviarWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "botão",
      body: { text: "🗓️ Escolha o período:" },
      Ação: {
        botões: [
          { type: "reply", reply: { id: `${prefix}:mes_atual`, title: "Mês atual" } },
          { type: "reply", reply: { id: `${prefix}:todo_periodo`, title: "Todo período" } },
          { type: "reply", reply: { id: `${prefix}:personalizado`, title: "Data personalizada" } },
        ],
      },
    },
  });

const sendLancPeriodoButtons = (para) =>
  enviarWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "botão",
      body: { text: "🧾 Escolha o período:" },
      Ação: {
        botões: [
          { type: "reply", reply: { id: `LANC:PER:hoje`, title: "Hoje" } },
          { type: "reply", reply: { id: `LANC:PER:mes_atual`, title: "Mês atual" } },
          { type: "reply", reply: { id: `LANC:PER:personalizado`, title: "Data personalizada" } },
        ],
      },
    },
  });

const sendDeleteMenu = (para) =>
  enviarWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "botão",
      body: { text: "🗑️ Como deseja excluir?" },
      Ação: {
        botões: [
          { type: "reply", reply: { id: "DEL:LAST", title: "Último lançamento" } },
          { type: "reply", reply: { id: "DEL:LIST", title: "Listar lançamentos" } },
        ],
      },
    },
  });

const sendContasFixasMenu = (para) =>
  enviarWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "botão",
      body: { text: "Escolha uma opção:" },
      Ação: {
        botões: [
          { type: "reply", reply: { id: "CFIX:CAD", title: "Cadastrar fixa" } },
          { type: "reply", reply: { id: "CFIX:LIST", title: "Listar correções" } },
          { type: "reply", reply: { id: "CFIX:DEL", title: "Excluir fixações" } },
        ],
      },
    },
  });

const sendCadastrarContaFixaMessage = (para) =>
  enviarTexto(
    para,
    `♻ Cadastro de conta fixa\n\nEnvie tudo em uma única mensagem neste formato:\n\n📝 Descrição: Nome da conta\n(ex: Internet, Academia, Aluguel)\n\n💰 Valor: Valor fixo da conta\n(ex: 120,00)\n\n🔁 Recorrência: Informe o intervalo\n(ex: todo dia 05, a cada 15 dias, semanal, quinzenal)\n\n💡 Exemplos:\n➡ Internet 120 todo dia 05\n➡ Aluguel 150 a cada 15 dias\n➡ Academia 90 semanal\n\nDigite *cancelar* para sair.`
  );

const sendListarContasFixasMessage = async (to, userNorm) => {
  const fixed = await getFixedAccounts(userNorm);
  se (!comprimento.fixo) {
    await sendText(to, "Você ainda não possui contas fixas cadastradas.");
    retornar;
  }
  const deduped = dedupeFixedAccounts(fixed);
  const pendente = deduplicado
    .filter((row) => (getVal(row, "status") || "").toString().toLowerCase() !== "pago")
    .sort((a, b) => getEffectiveDate(a) - getEffectiveDate(b));
  se (!pending.length) {
    await sendText(to, "🎉 Todas as suas contas fixas estão em dia no momento!");
    retornar;
  }
  const lista = construirListaDeContasFixas(pendente);
  sessionPayConfirm.delete(userNorm);
  setPayState(userNorm, {
    aguardando: "índice",
    linhas: pendentes,
    fila: [],
    currentIndex: 0,
    currentRowId: nulo,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  aguardar enviarTexto(
    para,
    `♻️ *Contas fixas pendentes*\n\n${list}\n\n✅ Para confirmar pagamento, envie o número da conta.\nExemplo: Confirmar 1 ou Confirmar 1,2,3.`
  );
};

const buildFixedAccountList = (linhas) =>
  linhas
    .map((linha, índice) => {
      retornar formatEntryBlock(linha, {
        índice: índice + 1,
      });
    })
    .join("\n\n");

const isFixedAccount = (row) => isRowFixed(row);

const getFixedAccounts = async (userNorm) => {
  const linhas = await todasAsLinhasParaUsuário(userNorm);
  retornar rows.filter((row) => isFixedAccount(row));
};

const dedupeFixedAccounts = (linhas) => {
  const byParent = new Map();
  const prioridade = (linha) => {
    const status = (getVal(row, "status") || "").toString().toLowerCase();
    status de retorno === "pago" || status === "recebido" ? 1 : 0;
  };
  linhas.forEach((linha) => {
    const parent = getVal(row, "fix_parent_id") || getVal(row, "row_id") || getRowIdentifier(row);
    se (!pai) retornar;
    const existing = byParent.get(parent);
    se (!existir) {
      porParent.set(parent, linha);
      retornar;
    }
    const prioridadeAtual = prioridade(linha);
    const existingPriority = priority(existing);
    se (prioridadeAtual < prioridadeExistente) {
      porParent.set(parent, linha);
      retornar;
    }
    se (prioridadeAtual === prioridadeExistente) {
      const existingDate = getEffectiveDate(existing);
      const candidateDate = getEffectiveDate(row);
      se (!existingDate || (candidateDate && candidateDate < existingDate)) {
        porParent.set(parent, linha);
      }
    }
  });
  retornar [...porParent.values()];
};

função assíncrona enviarExcluirContaFixaMessage(para, userNorm) {
  const fixed = dedupeFixedAccounts(await getFixedAccounts(userNorm));
  se (!comprimento.fixo) {
    sessionFixedDelete.delete(userNorm);
    await sendText(to, "Você ainda não possui contas fixas cadastradas.");
    retornar;
  }
  const sorted = fixo
    .fatiar()
    .sort((a, b) => {
      const dataA = getEffectiveDate(a);
      const dateB = getEffectiveDate(b);
      if (dataA && dataB) retornar dataA - dataB;
      se (dataA) retorne -1;
      se (dateB) retorne 1;
      const contaA = (getVal(a, "conta") || "").toString().toLowerCase();
      const countB = (getVal(b, "count") || "").toString().toLowerCase();
      retornar accountA.localCompare(accountB);
    });
  sessionFixedDelete.set(userNorm, { awaiting: "index", rows: sorted });
  const lista = construirListaDeContasFixas(ordenada);
  const message = `🗑 Excluir conta fixa\n\nPara remover uma conta recorrente, digite o número de qual deseja excluir:\n\n${list}\n\nEnvie o número da conta fixa que deseja excluir.`;
  aguardar sendText(para, mensagem);
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
const sessionPayConfirm = novo Map();

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
// Operações com planilhas
// ============================
const createRow = async (payload) => {
  const sheet = await ensureSheet();
  if (DEBUG_SHEETS) console.log("[Sheets] Adicionando linha", payload);
  await withRetry(() => sheet.addRow(payload), "append-finplanner");
  await upsertUserSheetEntry(payload, { skipCheck: true });
};

const deleteRow = async (row) => {
  se (!linha) retornar;
  if (DEBUG_SHEETS) console.log("[Sheets] Removendo linha", getVal(row, "row_id"));
  if (typeof row.delete === "function") await row.delete();
};

const generateRowId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const buildCronBuckets = (rows, todayMs) => {
  const dueByUser = new Map();
  const enqueueReminder = (row, kind) => {
    const dueIso = getVal(row, "vencimento_iso");
    const dueBr = getVal(row, "vencimento_br");
    const dueDate = dueIso ? new Date(dueIso) : parseDateToken(dueBr);
    se (!dueDate || Number.isNaN(dueDate.getTime())) {
      console.log("⚠️ Cron skip (data inválida):", {
        usuário: getVal(linha, "usuário") || getVal(linha, "usuário_bruto"),
        tipo: getVal(linha, "tipo"),
        vencimento_iso: dueIso,
        vencimento_br: dueBr,
      });
      retornar;
    }
    const dueMs = startOfDay(dueDate).getTime();
    se (dueMs > todayMs) {
      console.log("ℹ️ Cron skip (vencimento futuro):", {
        usuário: getVal(linha, "usuário") || getVal(linha, "usuário_bruto"),
        tipo: getVal(linha, "tipo"),
        vencimento_iso: dueIso,
        vencimento_br: dueBr,
      });
      retornar;
    }
    const toRaw = getVal(row, "user_raw") || getVal(row, "user");
    const userNorm = normalizeUser(getVal(row, "user") || getVal(row, "user_raw"));
    se (!toRaw || !userNorm) {
      console.log("⚠️ Cron skip (usuário inválido):", {
        usuário: getVal(linha, "usuário") || getVal(linha, "usuário_bruto"),
        tipo: getVal(linha, "tipo"),
      });
      retornar;
    }
    const bucket = dueByUser.get(userNorm) || { to: toRaw, items: [] };
    se (!bucket.to) bucket.to = toRaw;
    bucket.items.push({ row, kind, dueMs });
    dueByUser.set(userNorm, bucket);
  };

  para (const linha de linhas) {
    const tipo = (getVal(row, "tipo") || "").toString().toLowerCase();
    const status = (getVal(row, "status") || "").toString().toLowerCase();
    if (tipo === "conta_pagar" && status !== "pago") enqueueReminder(row, "pagar");
    if (tipo === "conta_receber" && !["pago", "recebido"].includes(status)) enqueueReminder(row, "receber");
  }

  retornar devidoPeloUsuário;
};

const buildCronMessage = (items, todayMs) => {
  const pagar = items.filter((item) => item.kind === "pagar").sort((a, b) => a.dueMs - b.dueMs);
  const receber = items.filter((item) => item.kind === "receber").sort((a, b) => a.dueMs - b.dueMs);
  const sections = [];
  seja contador = 1;

  se (comprimento da cerca) {
    const blocks = pagar.map((item) => {
      const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
      const dueLabel = dueRaw || "—";
      const label = item.dueMs < todayMs ? `${dueLabel} (atrasado)` : dueLabel;
      retornar formatEntryBlock(item.row, { index: counter++, dateText: label });
    });
    sections.push(`💸 *Pagamentos pendentes*\n\n${blocks.join("\n\n")}`);
  }

  se (receber.length) {
    const blocks = receber.map((item) => {
      const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
      const dueLabel = dueRaw || "—";
      const label = item.dueMs < todayMs ? `${dueLabel} (atrasado)` : dueLabel;
      retornar formatEntryBlock(item.row, { index: counter++, dateText: label });
    });
    sections.push(`💵 *Recebimentos pendentes*\n\n${blocks.join("\n\n")}`);
  }

  if (!sections.length) return { message: "", pagar, receber };
  return { message: `⚠️ *Lembrete FinPlanner IA*\n\n${sections.join("\n\n")}`, pagar, receber };
};

const sendCronReminderForUser = async (userNorm, to, { bypassWindow = false } = {}) => {
  const sheet = await ensureSheet();
  const rows = await withRetry(() => sheet.getRows(), "get-finplanner-cron");
  const hoje = inícioDoDia(novo Date());
  const dueByUser = buildCronBuckets(rows, today.getTime());
  const bucket = dueByUser.get(userNorm);
  se (!bucket || !bucket.items.length) {
    await sendText(to, "ℹ️ Nenhum lembrete pendente para este usuário.", { bypassWindow: true });
    retornar;
  }
  const { message, pagar, receber } = buildCronMessage(bucket.items, today.getTime());
  se (!mensagem) {
    await sendText(to, "ℹ️ Nenhum lembrete pendente para este usuário.", { bypassWindow: true });
    retornar;
  }
  console.log("🧪 Cron manual (admin):", { userNorm, to, total: bucket.items.length, pagar: pagar.length, receber: receber.length });
  await sendText(to, message, { bypassWindow });
};

const migrateUserSheets = async () => {
  tentar {
    const sheet = await ensureSheet();
    const batchSize = 100;
    const cursorRaw = await getConfigValue("user_sheet_cursor");
    const cursor = Number.parseInt(cursorRaw || "0", 10) || 0;
    const rows = await withRetry(() => sheet.getRows({ offset: cursor, limit: batchSize }), "get-finplanner-batch");
    se (!linhas || linhas.comprimento === 0) {
      console.log("ℹ️ Migração de lançamentos: nada novo para migrar.", { cursor });
      retornar;
    }
    seja migrado = 0;
    para (const linha de linhas) {
      await upsertUserSheetEntry(row, { skipCheck: true });
      migrado += 1;
    }
    const nextCursor = cursor + rows.length;
    await setConfigValue("user_sheet_cursor", String(nextCursor));
    console.log("✅ Migração de lançamentos concluída:", { total: migrated, cursor: nextCursor });
  } catch (erro) {
    console.error("Erro ao migrar lançamentos para abas de usuário:", error.message);
  }
};

// ============================
// Parse de lançamento
// ============================
const parseRegisterText = (texto) => {
  const original = (texto || "").toString();
  const normalizado = normalizarDiacritics(original).toLowerCase();
  const isReceber = /\b(receb|receita|entrada|venda|vendi|ganhei)\b/.test(normalized);
  const tipo = isReceber ? "conta_receber" : "conta_pagar";

  let status = "pendente";
  let statusDetectado = falso;
  const receivedRegex = /\b(recebid[oa]?|recebi|recebemos|creditad[oa]|caiu|confirmad[oa])\b/;
  const pendingRegex = /\b(pendente|a pagar|pagar|a receber|aguardando|em aberto)\b/;
  const paidRegex = /\b(pag[ouei]|paguei|quitad[oa]|liquidad[oa]|transferi|transferido|pix)\b/;
  se (recebidoRegex.teste(normalizado)) {
    status = "recebido";
    statusDetectado = verdadeiro;
  } else if (pendingRegex.test(normalized)) {
    status = "pendente";
    statusDetectado = verdadeiro;
  } else if (paidRegex.test(normalized)) {
    status = "aldeia";
    statusDetectado = verdadeiro;
  }
  if (tipo === "conta_receber" && status === "pago") status = "recebido";
  if (tipo === "conta_pagar" && status === "recebido") status = "pago";

  const amountInfo = extractAmountFromText(original);
  const valor = amountInfo.amount || 0;

  seja data = nulo;
  const dateMatch = original.match(new RegExp(`(hoje|amanh[ãa]|ontem|${DATE_TOKEN_PATTERN})`, "i"));
  if (dateMatch) dados = parseDateToken(dateMatch[1]);

  se (!dados) {
    const valueDateMatch = original.match(/(\d{3,})[\/-](\d{1,2})(?:\b|$)/);
    se (valueDateMatch) {
      const dia = Número(valorDateMatch[2]);
      se (dia >= 1 && dia <= 31) {
        const now = new Date();
        const candidate = new Date(now.getFullYear(), now.getMonth(), day);
        candidato.setHours(0, 0, 0, 0);
        se (candidato < inícioDoDia(agora)) {
          candidato.setMonth(candidato.getMonth() + 1, dia);
        }
        dados = candidato;
      }
    }
  }

  let descricao = original;
  se (amountInfo.raw) {
    const rawEscaked = escapeRegex(amountInfo.raw);
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
    .aparar();

  if (descricao) {
    const tokens = descricao.split(/\s+/);
    const filtered = tokens.filter((token) => {
      const tokenNormalizado = normalizarDiacritics(token).toLowerCase();
      Se (NUMBER_CONNECTORS.has(normalizedToken)) retorne falso;
      se (NUMBER_WORDS[normalizedToken] !== undefined) retorne falso;
      se (normalizedToken === "mil") retornar falso;
      retornar verdadeiro;
    });
    descricao = filtered.join(" ");
  }

  descricao = descricao.trim();
  if (!descricao) descricao = tipo === "conta_receber" ? "Recebimento" : "Pagamento";

  let tipoPagamento = "";
  se (/\bpix\b/.test(normalizado)) tipoPagamento = "pix";
  else if (/\bboleto\b/.test(normalized)) tipoPagamento = "boleto";
  senão se (/\b(cart[aã]o\s*de\s*cr[eé]dito|cart[aã]o\s*cr[eé]dito|cr[eé]dito\s*no?\s*cart[aã]o|credito\b.*cartao)\b/.test(normalized))
    tipoPagamento = "cartao_credito";
  senão se (/\b(cart[aã]o\s*de\s*d[eé]bito|cart[aã]o\s*d[eé]bito|d[eé]bito\s*no?\s*cart[aã]o|debito\b.*cartao)\b/.test(normalized))
    tipoPagamento = "cartao_debito";
  else if (/\bdinheiro\b/.test(normalized)) tipoPagamento = "dinheiro";
  else if (/\btransfer/i.test(normalized)) tipoPagamento = "transferência";

  retornar {
    tipo,
    valor,
    dados: dados || novo Date(),
    status,
    statusDetectado,
    descricao,
    tipoPagamento,
  };
};

// ============================
// Fluxos de mensagens
// ============================
função assíncrona mostrarRelatórioPorCategoria(deRaw, userNorm, categoria, intervalo) {
  const linhas = await todasAsLinhasParaUsuário(userNorm);
  const { início, fim } = intervalo;
  const inRange = withinPeriod(rows, start, end);

  const statusOf = (row) => (getVal(row, "status") || "").toString().toLowerCase();
  const isPaid = ( linha ) => statusOf ( linha ) === " pagamento " ;
  const isReceived = (row) => {
    const status = statusOf(linha);
    status de retorno === "recebido" || status === "pago";
  };

  se (categoria === "cp") {
    const expenses = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar");
    const pendente = despesas.filter((linha) => !isPaid(linha));
    const pago = despesas.filter(éPago);
    const totalPending = sumValues(pending);
    const totalPago = somaValores(pago);
    const totalDespesas = somaValores(despesas);
    let message = "📊 *Relatório • Contas a pagar*";
    se (!expenses.length) {
      message += "\n\n✅ Nenhuma conta encontrada para o período selecionado.";
    } outro {
      se (pendente.comprimento) {
        mensagem += `\n\n📂 Categorias pendentes:\n${formatCategoryLines(pending)}`;
      }
      se (pago.comprimento) {
        mensagem += `\n\n✅ Categorias pagas:\n${formatCategoryLines(paid)}`;
      }
      mensagem += `\n\n🔸 Total pendente: ${formatCurrencyBR(totalPending)}`;
      mensagem += `\n✅ Total pago: ${formatCurrencyBR(totalPaid)}`;
      message += `\n💰 Total geral: ${formatCurrencyBR(totalExpenses)}`;
    }
    aguardar sendText(fromRaw, mensagem);
    retornar;
  }

  se (categoria === "rec") {
    const receipts = inRange.filter((row) => getVal(row, "tipo") === "conta_receber");
    const confirmado = recibos.filter(éRecebido);
    const pending = receipts.filter((row) => !isReceived(row));
    const totalRecebido = somaValores(confirmado);
    const totalPending = sumValues(pending);
    const totalReceipts = sumValues(receipts);
    let message = "📊 *Relatório • Recebimentos*";
    se (!recibos.comprimento) {
      message += "\n\n✅ Nenhum recebimento encontrado para o período selecionado.";
    } outro {
      mensagem += `\n\n📂 Categorias:\n${formatCategoryLines(recibos)}`;
      message += `\n\n💵 Total recebido: ${formatCurrencyBR(totalReceived)}`;
      mensagem += `\n⏳ Total pendente: ${formatCurrencyBR(totalPending)}`;
      message += `\n💰 Total geral: ${formatCurrencyBR(totalReceipts)}`;
    }
    aguardar sendText(fromRaw, mensagem);
    retornar;
  }

  se (categoria === "pag") {
    const expenses = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar");
    const pago = despesas.filter(éPago);
    const pendente = despesas.filter((linha) => !isPaid(linha));
    const totalPago = somaValores(pago);
    const totalPending = sumValues(pending);
    let message = "📊 *Relatório • Pagamentos*";
    se (!paid.length) {
      message += "\n\n✅ Nenhum pagamento confirmado no período.";
      se (pendente.comprimento) {
        mensagem += `\n\n⏳ Contas pendentes: ${formatCurrencyBR(totalPending)}`;
      }
      aguardar sendText(fromRaw, mensagem);
      retornar;
    }
    mensagem += `\n\n📂 Categorias pagas:\n${formatCategoryLines(paid)}`;
    mensagem += `\n\n💸 Total pago: ${formatCurrencyBR(totalPaid)}`;
    se (pendente.comprimento) {
      mensagem += `\n⏳ Contas pendentes: ${formatCurrencyBR(totalPending)}`;
    }
    message += `\n💰 Total geral: ${formatCurrencyBR(totalPaid)}`;
    aguardar sendText(fromRaw, mensagem);
    retornar;
  }

  se (categoria === "todas") {
    const receipts = inRange.filter((row) => getVal(row, "tipo") === "conta_receber");
    const expenses = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar");
    const recibosConfirmados = recibos.filter(éRecebido);
    const pendingReceipts = receipts.filter((row) => !isReceived(row));
    const paidExpenses = expenses.filter(isPaid);
    const pendingExpenses = expenses.filter((row) => !isPaid(row));
    const totalRecebido = sumValues(recibosConfirmados);
    const totalReceipts = sumValues(receipts);
    const totalPago = somaValores(despesasPagas);
    const totalPendingExpenses = sumValues(pendingExpenses);
    const totalRecebimentosPendentes = sumValores(recebimentospendentes);
    let message = "📊 *Relatório • Completo*";
    se (!recibos.comprimento && !despesas.comprimento) {
      message += "\n\n✅ Nenhum lançamento encontrado para o período selecionado.";
    } outro {
      se (recibos.comprimento) {
        message += `\n\n💵 Recebimentos:\n${formatCategoryLines(receipts)}`;
        message += `\n\n💵 Total recebido: ${formatCurrencyBR(totalReceived)}`;
        mensagem += `\n⏳ Total pendente: ${formatCurrencyBR(totalPendingReceipts)}`;
        message += `\n💰 Total geral: ${formatCurrencyBR(totalReceipts)}`;
      }
      se (despesaspendentes.comprimento) {
        mensagem += `\n\n⏳ Contas a pagar:\n${formatCategoryLines(pendingExpenses)}`;
        mensagem += `\n\n⏳ Total pendência: ${formatCurrencyBR(totalPendingExpenses)}`;
      }
      se (despesaspagas.comprimento) {
        mensagem += `\n\n✅ Contas Pagas:\n${formatCategoryLines(paidExpenses)}`;
        mensagem += `\n\n✅ Total pago: ${formatCurrencyBR(totalPaid)}`;
      }
      const saldo = formatoBalanceLine(totalRecebido, totalPago);
      mensagem += `\n\n${saldo}`;
    }
    aguardar sendText(fromRaw, mensagem);
  }
}

função assíncrona showLancamentos(fromRaw, userNorm, range) {
  const linhas = await todasAsLinhasParaUsuário(userNorm);
  const filtered = withinPeriod(rows, range.start, range.end)
    .filter((row) => toNumber(getVal(row, "valor")) > 0)
    .sort((a, b) => getEffectiveDate(a) - getEffectiveDate(b));
  se (!filtered.length) {
    await sendText(fromRaw, "✅ Nenhum lançamento encontrado para o período selecionado.");
    retornar;
  }
  const blocks = filtered.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  const message = `🧾 *Meus lançamentos*\n\n${blocks.join("\n\n")}`;
  aguardar sendText(fromRaw, mensagem);
}

função assíncrona listarPagamentosPendentes(deRaw, userNorm) {
  const linhas = await todasAsLinhasParaUsuário(userNorm);
  const pending = rows.filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") !== "pago");
  se (!pending.length) {
    await sendText(fromRaw, "🎉 Você não possui contas pendentes no momento!");
    retornar;
  }
  const blocks = pending.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  mensagem constante =
    `📅 *Contas a pagar em aberto*\n\n${blocks.join("\n\n")}` +
    `\n\n✅ Para confirmar pagamento, envie o número da conta.\nExemplo: Confirmar 1 ou Confirmar 1,2,3.`;
  sessionPayConfirm.delete(userNorm);
  setPayState(userNorm, {
    aguardando: "índice",
    linhas: pendentes,
    fila: [],
    currentIndex: 0,
    currentRowId: nulo,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  aguardar sendText(fromRaw, mensagem);
}

função assíncrona listRowsForSelection(fromRaw, userNorm, mode) {
  const linhas = await todasAsLinhasParaUsuário(userNorm);
  const sorted = linhas
    .fatiar()
    .sort((a, b) => getEffectiveDate(b) - getEffectiveDate(a))
    .slice(0, 15);
  se (!sorted.length) {
    await sendText(fromRaw, "Não encontrei lançamentos recentes.");
    retornar;
  }
  const blocks = sorted.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  se (modo === "editar") {
    const message = `✏️ Selecione o lançamento que deseja editar:\n\n${blocks.join("\n\n")}\n\nEnvie o número correspondente (1-${sorted.length}).`;
    sessionEdit.set(userNorm, { awaiting: "index", rows: sorted, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    aguardar sendText(fromRaw, mensagem);
  } outro {
    mensagem constante =
      "📋 Selecione o lançamento que deseja excluir:\n\n" +
      `${blocks.join("\n\n")}\n\n📋 Selecione os lançamentos que deseja excluir:\n\nEnvie os números separados por vírgula ou espaço.\nExemplo: 1, 3, 5 ou 2 4 6`;
    sessionDelete.set(userNorm, { awaiting: "index", rows: sorted, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    aguardar sendText(fromRaw, mensagem);
  }
}

const SESSION_TIMEOUT_MS = 2 * 60 * 1000;

const selectionStopWords = novo Set(
  [
    "excluir",
    "exclua",
    "removedor",
    "remova",
    "apagar",
    "apague",
    "deletar",
    "excluir",
    "editar",
    "editor",
    "lancamento",
    "lancamentos",
    "número",
    "números",
    "número",
    "números",
    "item",
    "itens",
    "selecionar",
    "selecione",
    "seleção",
    "escolher",
    "escolha",
    "confirmar",
    "confirmar",
    "quero",
    "para",
    "pra",
    "de",
    "fazer",
    "e",
    "dos",
    "o",
    "o",
    "um",
    "os",
    "como",
    "um",
    "uma",
  ].map((palavra) => normalizeDiacritics(palavra))
);

const cleanSelectionTerms = (normalizedText) =>
  texto normalizado
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !selectionStopWords.has(token))
    .juntar(" ");

const parseSelectionIndexes = (text, max) => {
  const normalizado = normalizarDiacritics(texto).toLowerCase();
  const indexes = novo Set();
  const rangeRegex = /(\d+)\s*(?:a|ate|até|ate|ao|à|\-|–|—)\s*(\d+)/g;
  deixe rangeMatch;
  enquanto ((rangeMatch = rangeRegex.exec(normalizado))) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    se (!Número.éFinite(início) || !Número.éFinite(fim)) continue;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    para (seja i = de; i <= até; i += 1) {
      índices.adicionar(i);
    }
  }
  const numberRegex = /\b\d+\b/g;
  que combine;
  enquanto ((match = numberRegex.exec(normalizado))) {
    índices.adicionar(Número(correspondência[0]));
  }
  const filtered = [...indexes].filter((idx) => Number.isFinite(idx) && idx >= 1 && idx <= max);
  filtrado.ordenar((a, b) => a - b);
  retornar filtrado;
};

const parseSelectionByDescription = (text, rows) => {
  const normalizado = normalizarDiacritics(texto).toLowerCase();
  const cleaned = cleanSelectionTerms(normalized).replace(/\d+/g, " ").trim();
  se (!limpo) retorne [];
  const palavras = limpo.split(/\s+/).filter(Boolean);
  se (!words.length) retorne [];
  const matches = [];
  linhas.forEach((linha, idx) => {
    const base = normalizeDiacritics(
      `${getVal(row, "descricao") || ""} ${getVal(row, "conta") || ""}`
    )
      .paraLowerCase()
      .replace(/\s+/g, " ");
    se (palavras.cada((palavra) => base.inclui(palavra))) {
      matches.push(idx + 1);
    }
  });
  retornar correspondências;
};

const resolveSelectionIndexes = (text, rows) => {
  const indexes = parseSelectionIndexes(text, rows.length);
  Se (indexes.length) retornar índices;
  const byDescription = parseSelectionByDescription(text, rows);
  retornar por descrição;
};

const uniqueSelections = (selections) => {
  const visto = novo Conjunto();
  const lista = [];
  para (item constante de seleções) {
    se (!item || !item.linha) continue;
    const rowId = getVal(item.row, "row_id") || getVal(item.row, "timestamp") || `${item.displayIndex}-${Math.random()}`;
    se (visto.tem(rowId)) continue;
    visto.adicionar(rowId);
    lista.push(item);
  }
  retornar lista;
};

const setDeleteState = (userNorm, state) => {
  const current = sessionDelete.get(userNorm) || {};
  sessionDelete.set(userNorm, { ...current, ...state });
};

const resetDeleteTimeout = (state) => ({ ...state, expiresAt: Date.now() + SESSION_TIMEOUT_MS });

const deleteStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

função assíncrona promptNextDeleteConfirmation(para, userNorm) {
  const state = sessionDelete.get(userNorm);
  if (!state || !Array.isArray(state.queue) || !state.queue.length) return;
  const currentIndex = state.currentIndex || 0;
  const currentItem = state.queue[currentIndex];
  se (!currentItem || !currentItem.row) {
    sessionDelete.delete(userNorm);
    retornar;
  }
  const summary = formatEntrySummary(currentItem.row, { headerLabel: "🧾 Lançamento selecionado:" });
  const body = `⚠ Confirmar exclusão do lançamento:\n\n${summary}\n\nDeseja realmente excluir este lançamento?`;
  const nextState = resetDeleteTimeout({ ...state, awaiting: "confirm", currentIndex });
  sessionDelete.set(userNorm, nextState);
  aguardar sendWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "botão",
      corpo: { texto: corpo },
      Ação: {
        botões: [
          { type: "reply", reply: { id: "DEL:CONFIRM:YES", title: "✅ Sim, excluir" } },
          { type: "reply", reply: { id: "DEL:CONFIRM:NO", title: "❌ Cancelar" } },
        ],
      },
    },
  });
}

função assíncrona confirmDeleteRows(fromRaw, userNorm, selections) {
  const validSelections = uniqueSelections(selections || []);
  Se (!validSelections.length) retornar;
  setDeleteState(userNorm, {
    aguardando: "confirmar",
    fila: seleções válidas,
    currentIndex: 0,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  aguardar promptNextDeleteConfirmation(fromRaw, userNorm);
}

função assíncrona finalizarConfirmaçãoDeExclusão(deRaw, userNorm, confirmado) {
  const state = sessionDelete.get(userNorm);
  Se (!estado || estado.aguardando !== "confirmar") retornar falso;
  se (deleteStateExpired(state)) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    retornar verdadeiro;
  }
  se (!confirmado) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada.");
    retornar verdadeiro;
  }
  const currentIndex = state.currentIndex || 0;
  const currentItem = state.queue?.[currentIndex];
  se (!currentItem || !currentItem.row) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Nenhum lançamento selecionado para excluir.");
    retornar verdadeiro;
  }
  aguarde deleteRow(currentItem.row);
  aguardar enviarTexto(
    do Raw,
    "🗑 Lançamento excluído com sucesso!\n\n💡 Dica: envie *Meus lançamentos* para visualizar sua lista atualizada."
  );
  const nextIndex = currentIndex + 1;
  se (!state.queue || nextIndex >= state.queue.length) {
    sessionDelete.delete(userNorm);
    retornar verdadeiro;
  }
  setDeleteState(userNorm, {
    fila: state.queue,
    currentIndex: nextIndex,
    aguardando: "confirmar",
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  aguardar promptNextDeleteConfirmation(fromRaw, userNorm);
  retornar verdadeiro;
}

função assíncrona handleDeleteConfirmation(fromRaw, userNorm, text) {
  const normalizado = normalizeDiacritics(texto).toLowerCase().trim();
  se (!normalizado) retorne falso;
  se (/^(s|sim)(\b|\s)/.test(normalizado) || /excluir/.test(normalizado) || /confirmar/.test(normalizado)) {
    retornar finalizeDeleteConfirmation(fromRaw, userNorm, true);
  }
  se (/^(nao|não|n)(\b|\s)/.test(normalized) || /cancel/.test(normalized) || /parar/.test(normalized)) {
    retornar finalizeDeleteConfirmation(fromRaw, userNorm, false);
  }
  retornar falso;
}

função assíncrona handleEditFlow(fromRaw, userNorm, text) {
  const state = sessionEdit.get(userNorm);
  se (!estado) retorne falso;
  se (state.expiresAt && Date.now() > state.expiresAt) {
    sessionEdit.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    retornar verdadeiro;
  }
  se (estado.aguardando === "índice") {
    const indexes = resolveSelectionIndexes(text, state.rows || []);
    se (!indexes.length) {
      await sendText(fromRaw, "Não entendi qual lançamento deseja editar. Informe o número ou o nome.");
      retornar verdadeiro;
    }
    const seleções = índices
      .map((idx) => ({ row: state.rows[idx - 1], displayIndex: idx }))
      .filter((item) => item.row);
    se (!selections.length) {
      await sendText(fromRaw, "Não encontrei os lançamentos informados. Tente novamente.");
      retornar verdadeiro;
    }
    const first = selections[0];
    sessionEdit.set(userNorm, {
      aguardando: "campo",
      linhas: estado.linhas,
      fila: seleções,
      currentIndex: 0,
      linha: primeira.linha,
      displayIndex: primeiro.displayIndex,
      expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    });
    const summary = formatEntrySummary(first.row, { headerLabel: "🧾 Lançamento selecionado:" });
    aguardar enviarTexto(
      do Raw,
      `${summary}\n\n✏ Editar lançamento\n\nEscolha o que deseja alterar:\n\n🏷 Conta\n📝 Descrição\n💰 Valor\n📅 Data\n📌 Status\n📂 Categoria\n\n💡 Dica: Digite exatamente o nome do item que deseja editar.\n(ex: valor, data, categoria...)`
    );
    retornar verdadeiro;
  }
  se (estado.aguardando === "campo") {
    const field = text.trim().toLowerCase();
    se (/^cancelar/.test(campo)) {
      sessionEdit.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      retornar verdadeiro;
    }
    const valid = ["conta", "descricao", "valor", "data", "status", "categoria"];
    se (!valid.includes(campo)) {
      await sendText(fromRaw, "Campo inválido. Tente novamente.");
      retornar verdadeiro;
    }
    sessionEdit.set(userNorm, {
      ...estado,
      aguardando: "valor",
      campo,
      expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    });
    se (campo === "status") {
      await sendText(fromRaw, "Digite a nova situação para status.");
    } outro {
      await sendText(fromRaw, `Digite o novo valor para *${field}*.`);
    }
    retornar verdadeiro;
  }
  se (estado.aguardando === "valor") {
    se (/^cancelar/i.test(text.trim())) {
      sessionEdit.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      retornar verdadeiro;
    }
    const { linha, campo } = estado;
    se (campo === "valor") {
      setVal(linha, "valor", toNumber(texto));
    } else if (field === "data") {
      const date = parseDateToken(text.trim());
      se (!data) {
        await sendText(fromRaw, "Data inválida. Use dd/mm/aaaa ou palavras como hoje/amanhã.");
        retornar verdadeiro;
      }
      const iso = date.toISOString();
      setVal(row, "vencimento_iso", iso);
      setVal(row, "vencimento_br", formatBRDate(date));
      setVal(linha, "timestamp", date.toISOString());
    } else if (field === "status") {
      const lower = text.trim().toLowerCase();
      const validStatus = ["pago", "pendente", "recebido"];
      se (!validStatus.include(lower)) {
        await sendText(fromRaw, "Status inválido. Use pago, pendente ou recebido.");
        retornar verdadeiro;
      }
      definirValor(linha, "status", inferior);
    } else if (field === "categoria") {
      const categoria = texto.trim();
      const detected = await resolveCategory(categoria, getVal(row, "tipo"));
      setVal(linha, "categoria", detected.slug);
      setVal(row, "categoria_emoji", detected.emoji);
    } outro {
      setVal(row, field === "conta" ? "conta" : "descricao", text.trim());
    }
    aguardar salvarLinha(linha);
    await sendText(fromRaw, "✅ Lançamento atualizado com sucesso!");
    const fila = estado.fila || [];
    const nextIndex = (state.currentIndex || 0) + 1;
    se (queue.length && nextIndex < queue.length) {
      const next = fila[nextIndex];
      sessionEdit.set(userNorm, {
        ...estado,
        aguardando: "campo",
        currentIndex: nextIndex,
        linha: próxima.linha,
        displayIndex: próximo.displayIndex,
        campo: indefinido,
        expiresAt: Date.now() + SESSION_TIMEOUT_MS,
      });
      const summary = formatEntrySummary(next.row, { headerLabel: "🧾 Lançamento selecionado:" });
      aguardar enviarTexto(
        do Raw,
        `${summary}\n\n✏ Editar lançamento\n\nEscolha o que deseja alterar:\n\n🏷 Conta\n📝 Descrição\n💰 Valor\n📅 Data\n📌 Status\n📂 Categoria\n\n💡 Dica: Digite exatamente o nome do item que deseja editar.\n(ex: valor, data, categoria...)`
      );
    } outro {
      sessionEdit.delete(userNorm);
    }
    retornar verdadeiro;
  }
  retornar falso;
}

função assíncrona handleFixedDeleteFlow(fromRaw, userNorm, text) {
  const state = sessionFixedDelete.get(userNorm);
  Se (!estado || estado.aguardando !== "índice") retorne falso;
  const idx = Number(text.trim());
  se (!idx || idx < 1 || idx > state.rows.length) {
    await sendText(fromRaw, "Número inválido. Tente novamente.");
    retornar verdadeiro;
  }
  const row = state.rows[idx - 1];
  sessionFixedDelete.delete(userNorm);
  const parentId = getVal(row, "fix_parent_id") || getVal(row, "row_id");
  const allRows = await allRowsForUser(userNorm);
  const related = allRows.filter(
    (candidato) =>
      isFixedAccount(candidate) && (getVal(candidate, "fix_parent_id") || getVal(candidate, "row_id")) === parentId
  );
  se (related.length > 1) {
    await sendText(fromRaw, "A exclusão removerá todas as recorrências desta conta fixa.");
  }
  const selections = related.map((item) => ({ row: item, displayIndex: idx }));
  aguardar confirmDeleteRows(fromRaw, userNorm, selections);
  retornar verdadeiro;
}

função assíncrona handleFixedRegisterFlow(fromRaw, userNorm, text) {
  const state = sessionFixedRegister.get(userNorm);
  se (!estado) retorne falso;
  se (state.expiresAt && Date.now() > state.expiresAt) {
    sessionFixedRegister.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    retornar verdadeiro;
  }
  const aparado = (texto || "").aparar();
  se (!aparado) {
    await sendText(fromRaw, "Envie os detalhes da conta fixa ou escreva cancelar.");
    retornar verdadeiro;
  }
  se (/^cancelar/i.test(aparado)) {
    sessionFixedRegister.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada.");
    retornar verdadeiro;
  }
  const analisado = analisarComandoContaFixada(texto);
  se (!analisado) {
    aguardar enviarTexto(
      do Raw,
      "Não consegui entender. Informe algo como \"Internet 120 todo dia 05\" ou \"Aluguel 150 a cada 15 dias\"."
    );
    sessionFixedRegister.set(userNorm, { expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    retornar verdadeiro;
  }
  sessionFixedRegister.delete(userNorm);
  aguardar registroFixedAccount(fromRaw, userNorm, parsed);
  retornar verdadeiro;
}

função assíncrona handleDeleteFlow(fromRaw, userNorm, text) {
  const state = sessionDelete.get(userNorm);
  se (!estado) retorne falso;
  se (deleteStateExpired(state)) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    retornar verdadeiro;
  }
  se (estado.aguardando === "índice") {
    const indexes = resolveSelectionIndexes(text, state.rows || []);
    se (!indexes.length) {
      await sendText(fromRaw, "Não entendi quais lançamentos você deseja excluir. Informe os números ou o nome.");
      retornar verdadeiro;
    }
    const seleções = índices
      .map((idx) => ({ row: state.rows[idx - 1], displayIndex: idx }))
      .filter((item) => item.row);
    se (!selections.length) {
      await sendText(fromRaw, "Não encontrei os lançamentos informados. Tente novamente.");
      retornar verdadeiro;
    }
    aguardar confirmDeleteRows(fromRaw, userNorm, selections);
    retornar verdadeiro;
  }
  se (estado.aguardando === "confirmar") {
    retornar handleDeleteConfirmation(fromRaw, userNorm, text);
  }
  retornar falso;
}

// ============================
// Registro de lançamentos helpers
// ============================
const setStatusState = (userNorm, estado) => {
  const current = sessionStatusConfirm.get(userNorm) || {};
  sessionStatusConfirm.set(userNorm, { ...current, ...state });
};

const statusStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

função assíncrona enviarPromptDeConfirmaçãoDeStatus(para) {
  aguardar sendWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "botão",
      body: { text: "Esse lançamento já foi pago ou ainda está pendente?" },
      Ação: {
        botões: [
          { type: "reply", reply: { id: "REG:STATUS:PAGO", title: "Pago" } },
          { type: "reply", reply: { id: "REG:STATUS:PENDENTE", title: "Pendente" } },
        ],
      },
    },
  });
}

const sendRegistrationEditPrompt = async (to, rowId, statusLabel) => {
  se (!rowId) retornar;
  aguardar sendWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "botão",
      body: { text: `Status identificado automaticamente: ${statusLabel}.\n\nDeseja editar este lançamento?` },
      Ação: {
        botões: [{ tipo: "responder", resposta: { id: `REG:EDIT:${rowId}`, título: "✏ Editar" } }],
      },
    },
  });
};

const setPaymentCodeState = (userNorm, state) => {
  const current = sessionPaymentCode.get(userNorm) || {};
  sessionPaymentCode.set(userNorm, { ...atual, ...estado });
};

const paymentCodeStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

const promptAttachPaymentCode = async (to, userNorm, entry, statusSource) => {
  const method = (entry.tipo_pagamento || "").toLowerCase();
  if (!["pix", "boleto"].includes(method)) return;
  setPaymentCodeState(userNorm, {
    aguardando: "escolha",
    rowId: entry.row_id,
    método: método,
    statusSource,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  aguardar sendWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "botão",
      body: { text: "💳 Deseja anexar o código do Pix ou boleto para facilitar o pagamento?" },
      Ação: {
        botões: [
          { type: "reply", reply: { id: `PAYCODE:ADD:${entry.row_id}`, title: "🔗 Adicionar código" } },
          { type: "reply", reply: { id: `PAYCODE:SKIP:${entry.row_id}`, title: "🚫 Popular" } },
        ],
      },
    },
  });
};

função assíncrona agendarPróximaOcorrênciaFixa(linha) {
  se (!isRowFixed(linha)) retorne;
  const recType = (getVal(row, "recorrencia_tipo") || "").toString().toLowerCase();
  se (!recType) retornar;
  const userRaw = getVal(row, "user_raw") || getVal(row, "user");
  const userNorm = normalizeUser(getVal(row, "user"));
  Se (!userRaw || !userNorm) retorne;
  const currentDueIso = getVal(row, "vencimento_iso");
  const currentDue = currentDueIso ? new Date(currentDueIso) : new Date();
  seja nextDue = nulo;
  se (recType === "mensal") {
    const storedDay = Number(getVal(row, "recorrencia_valor"));
    const dia = Number.isFinite(storedDay) && storedDay > 0 ? storedDay : currentDue.getDate();
    próximoDue = próximaDataMensal(dia, adicionarDias(currentDue, 1), { inclusive: true });
  } else if (recType === "interval") {
    const stored = Number(getVal(row, "recorrencia_valor"));
    const dias = Number.isFinite(armazenado) && armazenado > 0 ? Math.round(armazenado) : 0;
    se (dias > 0) próximoDia = adicionarDias(inícioDoDia(diaAtualDia), dias);
  }
  se (!nextDue) retornar;

  let qualSlug = getVal(row, "categoria");
  let categoriaEmoji = getVal(row, "categoria_emoji");
  se (!categoriaSlug) {
    const detected = await resolveCategory(
      getVal(row, "descricao") || getVal(row, "conta"),
      getVal(row, "tipo") || "conta_pagar",
    );
    CategoriaSlug = slug detectado;
    categoriaEmoji = detectado.emoji;
  }

  const parentId = getVal(row, "fix_parent_id") || getVal(row, "row_id");
  const novaLinha = {
    row_id: gerarIdDaLinha(),
    timestamp: new Date().toISOString(),
    usuário: getVal(linha, "usuário"),
    user_raw: userRaw,
    tipo: getVal(row, "tipo") || "conta_pagar",
    conta: getVal(row, "conta"),
    valor: getVal(linha, "valor"),
    vencimento_iso: nextDue.toISOString(),
    vencimento_br: formatBRDate(nextDue),
    tipo_pagamento: getVal(row, "tipo_pagamento") || "",
    codigo_pagamento: "",
    status: "pendente",
    fixa: "sim",
    fix_parent_id: parentId,
    vencimento_dia: nextDue.getDate(),
    categoria: lesma,
    categoria_emoji: categoriaEmoji,
    descricao: getVal(row, "descricao") || getVal(row, "conta") || "Conta fixa",
    tipo_de_recorrência: recType,
    valor_recurso: getVal(linha, "valor_recurso") || (recType === "monthly" ? String(nextDue.getDate()) : ""),
  };
  aguardar criarLinha(novaLinha);
  const resumo = formatEntrySummary(newRow, { headerLabel: "📘 Próximo lançamento fixo:" });
  await sendText(userRaw, `♻ Próxima cobrança gerada automaticamente!\n\n${resumo}`);
  if (["pix", "boleto"].includes((newRow.tipo_pagamento || "").toLowerCase())) {
    aguarde promptAttachPaymentCode(userRaw, userNorm, newRow, "fixed_cycle");
  }
}

const setPayState = (userNorm, state) => {
  const current = sessionPayConfirm.get(userNorm) || {};
  sessionPayConfirm.set(userNorm, { ...atual, ...estado });
};

const payStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

função assíncrona promptNextPaymentConfirmation(para, userNorm) {
  const state = sessionPayConfirm.get(userNorm);
  if (!state || !Array.isArray(state.queue) || !state.queue.length) return;
  const currentIndex = state.currentIndex || 0;
  const currentItem = state.queue[currentIndex];
  se (!currentItem || !currentItem.row) {
    sessionPayConfirm.delete(userNorm);
    retornar;
  }
  const summary = formatEntrySummary(currentItem.row, { headerLabel: "🧾 Lançamento selecionado:" });
  const rowId = getRowIdentifier(currentItem.row);
  const code = (getVal(currentItem.row, "codigo_pagamento") || "").toString().trim();
  const metodo = (getVal(currentItem.row, "tipo_pagamento") || "").toLowerCase();
  const buttons = [{ type: "reply", reply: { id: `PAY:MARK:${rowId}`, title: "✅ Pago" } }];
  se (código) {
    const copyTitle = metodo === "boleto" ? "📋 Copiar boleto" : "📋 Copiar Pix";
    buttons.push({ type: "responder", reply: { id: `PAGAR:CÓPIA:${rowId}`, title: copyTitle } });
  }
  buttons.push({ type: "reply", reply: { id: "PAY:CANCEL", title: "❌ Cancelar" } });
  setPayState(userNorm, {
    ...estado,
    aguardando: "confirmar",
    índiceAtual,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    currentRowId: rowId,
  });
  const body = `✅ Confirmar pagamento?\n\n${summary}\n\nDeseja marcar como pago agora?`;
  aguardar sendWA({
    produto_de_mensagens: "whatsapp",
    para,
    tipo: "interativo",
    interativo: {
      tipo: "botão",
      corpo: { texto: corpo },
      ação: { botões },
    },
  });
}

função assíncrona finalizeRegisterEntry(fromRaw, userNorm, entry, options = {}) {
  const statusSource = options.statusSource || "auto";
  aguardar criarLinha(entrada);
  const resumo = formatEntrySummary(entry);
  const statusLabel = statusIconLabel(entry.status);
  if (entry.type === "conta_receber") {
    let message = `💵 Recebimento registrado com sucesso!\n\n${resumo}\n\n🎯 O saldo foi atualizado automaticamente, refletindo sua nova entrada.`;
    se (opções.autoStatus) {
      mensagem += `\n\nStatus identificado automaticamente: ${statusLabel}.`;
    }
    aguardar sendText(fromRaw, mensagem);
  } outro {
    let message = `✅ Pagamento registrado com sucesso!\n\n${resumo}\n\n💡 A FinPlanner IA já atualizou seu saldo e adicionou este pagamento ao relatório do período.`;
    se (opções.autoStatus) {
      mensagem += `\n\nStatus identificado automaticamente: ${statusLabel}.`;
    }
    aguardar sendText(fromRaw, mensagem);
  }

  se (opções.autoStatus) {
    await sendRegistrationEditPrompt(fromRaw, entry.row_id, statusLabel);
  }

  se (
    entry.tipo === "conta_pagar" &&
    entry.status === "pendente" &&
    ["pix", "boleto"].includes((entry.tipo_pagamento || "").toLowerCase()) &&
    (options.autoStatus || statusSource === "user_confirm")
  ) {
    aguarde promptAttachPaymentCode(fromRaw, userNorm, entry, statusSource);
  }

  aguardar sendMainMenu(fromRaw);
}

função assíncrona handleStatusSelection(fromRaw, userNorm, selectedStatus) {
  const state = sessionStatusConfirm.get(userNorm);
  se (!estado) retornar;
  se (statusStateExpired(state)) {
    sessionStatusConfirm.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    retornar;
  }
  const entry = { ...state.entry };
  se (!entrada) {
    sessionStatusConfirm.delete(userNorm);
    retornar;
  }
  seja status = selectedStatus;
  if (entry.type === "conta_receber" && status === "pago") status = "recebido";
  entrada.status = status;
  entry.timestamp = new Date().toISOString();
  sessionStatusConfirm.delete(userNorm);
  await finalizeRegisterEntry(fromRaw, userNorm, entry, { statusSource: "user_confirm", autoStatus: false });
}

função assíncrona handleStatusConfirmationFlow(fromRaw, userNorm, text) {
  const state = sessionStatusConfirm.get(userNorm);
  se (!estado) retorne falso;
  se (statusStateExpired(state)) {
    sessionStatusConfirm.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    retornar verdadeiro;
  }
  const normalizado = normalizeDiacritics(texto).toLowerCase().trim();
  se (!normalizado) {
    await sendText(fromRaw, "Não entendi. Toque em Pago ou Pendente para continuar.");
    retornar verdadeiro;
  }
  se (/\b(pago|pagou|paguei|pagamos|recebido|recebi|quitado|liquidado)\b/.test(normalizado)) {
    aguardar handleStatusSelection(fromRaw, userNorm, "pago");
    retornar verdadeiro;
  }
  if (/\b(pendente|a pagar|pagar|em aberto)\b/.test(normalized)) {
    aguardar handleStatusSelection(fromRaw, userNorm, "pendente");
    retornar verdadeiro;
  }
  await sendText(fromRaw, "Por favor, informe se o lançamento está Pago ou Pendente.");
  retornar verdadeiro;
}

função assíncrona handlePaymentCodeFlow(fromRaw, userNorm, text) {
  const state = sessionPaymentCode.get(userNorm);
  se (!estado) retorne falso;
  se (paymentCodeStateExpired(state)) {
    sessionPaymentCode.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    retornar verdadeiro;
  }
  se (state.awaiting !== "input") retornar falso;
  const code = text.trim();
  se (!código) {
    await sendText(fromRaw, "Não entendi o código. Envie novamente ou escreva cancelar.");
    retornar verdadeiro;
  }
  se (/^cancelar/i.test(código)) {
    sessionPaymentCode.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada.");
    retornar verdadeiro;
  }
  const row = await findRowById(userNorm, state.rowId);
  se (!linha) {
    sessionPaymentCode.delete(userNorm);
    await sendText(fromRaw, "Não encontrei o lançamento para salvar o código.");
    retornar verdadeiro;
  }
  setVal(row, "codigo_pagamento", code);
  aguardar salvarLinha(linha);
  sessionPaymentCode.delete(userNorm);
  const descricao = getVal(row, "descricao") || getVal(row, "conta") || "Lançamento";
  aguardar enviarTexto(
    do Raw,
    `✅ Código anexado com sucesso!\n\nDescrição do lançamento\n\n📝 Descrição: ${descricao}\n📎 Código armazenado com segurança.`
  );
  retornar verdadeiro;
}

função assíncrona handlePaymentConfirmFlow(fromRaw, userNorm, text) {
  const state = sessionPayConfirm.get(userNorm);
  se (!estado) retorne falso;
  se (payStateExpired(estado)) {
    sessionPayConfirm.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    retornar verdadeiro;
  }
  const textoNormalizado = normalizarDiacritics(texto).toLowerCase().trim();
  se (estado.aguardando === "índice") {
    se (/cancelar/.teste(textonormalizado)) {
      sessionPayConfirm.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      retornar verdadeiro;
    }
    const indexes = resolveSelectionIndexes(text, state.rows || []);
    se (!indexes.length) {
      await sendText(fromRaw, "Não entendi quais contas deseja confirmar. Informe os números.");
      retornar verdadeiro;
    }
    const seleções = índices
      .map((idx) => ({ row: state.rows[idx - 1], displayIndex: idx }))
      .filter((item) => item.row);
    se (!selections.length) {
      await sendText(fromRaw, "Não encontrei os lançamentos informados. Tente novamente.");
      retornar verdadeiro;
    }
    setPayState(userNorm, {
      linhas: estado.linhas,
      fila: seleções,
      currentIndex: 0,
      aguardando: "confirmar",
      expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    });
    aguardar confirmação de pagamento futura (de Raw, userNorm);
    retornar verdadeiro;
  }
  se (estado.aguardando === "confirmar") {
    se (!textonormalizado) {
      await sendText(fromRaw, "Responda com Pago ou Cancelar para continuar.");
      retornar verdadeiro;
    }
    se (/pago|confirmar/.teste(textonormalizado)) {
      const current = state.queue?.[state.currentIndex || 0];
      se (!atual || !atual.linha) {
        sessionPayConfirm.delete(userNorm);
        retornar verdadeiro;
      }
      aguarde marcarPagamentoComoPago(deRaw, userNorm, linhaAtual);
      retornar verdadeiro;
    }
    se (/cancelar/.teste(textonormalizado)) {
      sessionPayConfirm.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      retornar verdadeiro;
    }
    se (/copiar|código|boleto|pix/.test(textonormalizado)) {
      const current = state.queue?.[state.currentIndex || 0];
      se (linha atual?) {
        aguardar sendPaymentCode(fromRaw, current.row);
        setPayState(userNorm, { ...state, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      }
      retornar verdadeiro;
    }
    await sendText(fromRaw, "Responda com Pago ou escolha uma opção nos botões.");
    retornar verdadeiro;
  }
  retornar falso;
}

função assíncrona enviarCódigoDePagamento(para, linha) {
  const code = (getVal(row, "codigo_pagamento") || "").toString().trim();
  se (!código) {
    await sendText(to, "Não há código salvo para este lançamento.");
    retornar;
  }
  const metodo = (getVal(row, "tipo_pagamento") || "").toLowerCase();
  const label = metodo === "boleto" ? "código de barras" : "chave Pix";
  await sendText(to, `📎 Aqui está o ${label}:\n${code}`);
}

função assíncrona marcarPagamentoComoPago(deRaw, userNorm, linha) {
  se (!linha) retornar;
  setVal(linha, "status", "pago");
  setVal(row, "timestamp", new Date().toISOString());
  aguardar salvarLinha(linha);
  await sendText(fromRaw, `✅ Pagamento confirmado com sucesso!\n\n${formatEntrySummary(row)}`);
  aguardar agendamentoNextFixedOccurrence(linha);
  const state = sessionPayConfirm.get(userNorm);
  se (!estado) {
    sessionPayConfirm.delete(userNorm);
    retornar;
  }
  const nextIndex = (state.currentIndex || 0) + 1;
  se (!state.queue || nextIndex >= state.queue.length) {
    sessionPayConfirm.delete(userNorm);
    retornar;
  }
  setPayState(userNorm, {
    ...estado,
    currentIndex: nextIndex,
    aguardando: "confirmar",
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  aguardar confirmação de pagamento futura (de Raw, userNorm);
}

// ============================
// Registro de lançamentos
// ============================
função assíncrona registerEntry(fromRaw, userNorm, text, tipoPreferencial) {
  const parsed = parseRegisterText(text);
  se (tipoPreferencial) analisado.tipo = tipoPreferencial;
  se (!parsed.valor) {
    await sendText(fromRaw, "Não consegui identificar o valor. Informe algo como 150, R$150,00 ou \"cem reais\".");
    retornar;
  }
  let data = parsed.data instanceof Date ? parsed.data : null;
  if (!data || Number.isNaN(data.getTime())) data = new Date();
  const iso = data.toISOString();
  const categoria = await resolveCategory(parsed.descricao, parsed.tipo);
  const payload = {
    row_id: gerarIdDaLinha(),
    timestamp: new Date().toISOString(),
    usuário: userNorm,
    user_raw: fromRaw,
    tipo: tipo analisado,
    conta: parsed.descricao,
    valor: analisado.valor,
    vencimento_iso: iso,
    vencimento_br: formatBRDate(data),
    tipo_pagamento: parsed.tipoPagamento || "",
    codigo_pagamento: "",
    status: parsed.status || "pendente",
    fixa: "nao",
    fix_parent_id: "",
    vencimento_dia: data.getDate(),
    tipo_de_recorrência: "",
    valor_de_recorrência: "",
    categoria: categoria.slug,
    categoria_emoji: categoria.emoji,
    descricao: parsed.descricao,
  };
  se (!parsed.statusDetectado) {
    payload.status = "pendente";
    setStatusState(userNorm, { entry: { ...payload }, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    aguarde sendStatusConfirmationPrompt(fromRaw);
    retornar;
  }

  await finalizeRegisterEntry(fromRaw, userNorm, payload, { autoStatus: true, statusSource: "auto" });
}

const computeInitialFixedDueDate = (recurrence, startDate) => {
  se (!recorrência) retorne nulo;
  const now = startOfDay(new Date());
  se (recorrência.tipo === "mensal") {
    base constante =
      startDate instanceof Date && !Number.isNaN(startDate?.getTime()) && startOfDay(startDate).getTime() >= now.getTime()
        ? data de início
        : agora;
    retornar nextMonthlyDate(recurrence.value, base, { inclusive: true });
  }
  se (recorrência.tipo === "intervalo") {
    se (startDate instanceof Date && !Number.isNaN(startDate?.getTime())) {
      retornar nextIntervalDate(recursão.valor, startDate, agora);
    }
    retornar adicionarDias(agora, recorrência.valor);
  }
  retornar nulo;
};

const parseFixedAccountCommand = (texto) => {
  const original = (texto || "").toString();
  Se (!original.trim()) retorne nulo;
  const amountInfo = extractAmountFromText(original);
  Se (!amountInfo.amount) retornar nulo;
  const normalizado = normalizarDiacritics(original).toLowerCase();

  const removalPatterns = [];
  const addRemoval = (match) => {
    if (match && match[0]) removalPatterns.push(match[0]);
  };

  seja recorrência = nula;
  const dayMatch = normalized.match(/todo\s+dia\s+(\d{1,2})/);
  se (diaMatch) {
    recorrência = { tipo: "mensal", valor: Number(dayMatch[1]) };
    adicionarRemoção(diaMatch);
  }
  se (!recorrência) {
    const monthMatch = normalized.match(/(?:todo|cada)\s+(?:o\s+)?mes(?:\s+dia\s*(\d{1,2}))?/);
    se (mêsMatch) {
      recorrência = { tipo: "mensal", valor: monthMatch[1] ? Número(monthMatch[1]) : nulo };
      adicionarRemoção(correspondência de mês);
    }
  }
  se (!recorrência && /\bmensal\b/.test(normalizado)) {
    recorrência = { tipo: "mensal", valor: nulo };
    removalPatterns.push("mensal");
  }
  se (!recorrência) {
    const eachDays = normalized.match(/a\s+cada\s+(\d+)\s+dias?/);
    se (cadaDia) {
      recorrência = { tipo: "intervalo", valor: Número(cadaDia[1]) };
      adicionarRemoção(cadaDia);
    }
  }
  se (!recorrência) {
    const eachWeeks = normalized.match(/a\s+cada\s+(\d+)\s+semanas?/);
    se (cadaSemana) {
      recorrência = { tipo: "intervalo", valor: Número(cadaSemana[1]) * 7 };
      adicionarRemoção(cadaSemana);
    }
  }
  se (!recorrência && /\bsemanal\b/.test(normalizado)) {
    recorrência = { tipo: "intervalo", valor: 7 };
    removalPatterns.push("semanal");
  }
  se (!recorrência && /toda\s+semana/.test(normalizado)) {
    recorrência = { tipo: "intervalo", valor: 7 };
    removalPatterns.push("toda semana");
  }
  se (!recorrência && /\bquinzenal\b/.test(normalizado)) {
    recorrência = { tipo: "intervalo", valor: 15 };
    removalPatterns.push("quinzenal");
  }

  se (!recorrência) retorne nulo;

  const dateMatch = original.match(new RegExp(`(hoje|amanh[ãa]|ontem|${DATE_TOKEN_PATTERN})`, "i"));
  const datainicial=dataMatch? parseDateToken(dateMatch[1]) : null;

  se (recorrência.tipo === "mensal") {
    seja dia = Número(recorrência.valor);
    se (!Número.éFinite(dia) || dia <= 0) {
      se (startDate instanceof Date && !Number.isNaN(startDate?.getTime())) {
        dia = dataInicial.getDate();
      } outro {
        const extra = normalized.match(/dia\s+(\d{1,2})/);
        se (dia extra) = Número(extra[1]);
      }
    }
    if (!Number.isFinite(day) || day <= 0) day = new Date().getDate();
    recorrência.valor = clamp(Math.round(dia), 1, 31);
  } else if (recurrence.type === "interval") {
    const dias = Número(recorrência.valor);
    Se (!Number.isFinite(days) || days <= 0) retorne nulo;
    recorrência.valor = Math.max(Math.round(dias), 1);
  }

  const dueDate = computeInitialFixedDueDate(recurrence, startDate);
  se (!dueDate) retornar nulo;

  let descricao = original;
  se (amountInfo.raw) {
    const rawRegex = new RegExp(escapeRegex(amountInfo.raw), "i");
    descricao = descricao.replace(rawRegex, " ");
  }
  if (dateMatch && dateMatch[1]) {
    const dateRegex = new RegExp(escapeRegex(dateMatch[1]), "i");
    descricao = descricao.replace(dateRegex, " ");
  }
  removalPatterns.forEach((pattern) => {
    se (!padrão) retornar;
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
    .aparar();
  if (!descricao) descricao = "Conta fixa";

  let tipoPagamento = "";
  se (/\bpix\b/.test(normalizado)) tipoPagamento = "pix";
  else if (/\bboleto\b/.test(normalized)) tipoPagamento = "boleto";
  senão se (/\b(cart[aã]o\s*de\s*cr[eé]dito|cart[aã]o\s*cr[eé]dito|cr[eé]dito\s*no?\s*cart[aã]o)\b/.test(normalized))
    tipoPagamento = "cartao_credito";
  senão se (/\b(cart[aã]o\s*de\s*d[eé]bito|cart[aã]o\s*d[eé]bito|d[eé]bito\s*no?\s*cart[aã]o)\b/.test(normalized))
    tipoPagamento = "cartao_debito";

  retornar {
    descricao,
    valor: amountInfo.amount,
    recorrência,
    data de vencimento,
    tipoPagamento,
  };
};

função assíncrona registerFixedAccount(fromRaw, userNorm, parsed) {
  se (!analisado) retorne;
  const categoria = await resolveCategory(parsed.descricao, "conta_pagar");
  const rowId = generateRowId();
  const due = parsed.dueDate instanceof Date ? parsed.dueDate : new Date();
  const payload = {
    id_da_linha: id_da_linha,
    timestamp: new Date().toISOString(),
    usuário: userNorm,
    user_raw: fromRaw,
    tipo: "conta_pagar",
    conta: parsed.descricao,
    valor: analisado.valor,
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
    tipo_de_recorrência: tipo.de.recorrência.analisado,
    recorrencia_valor: parsed.recurrence.value?.toString() || "",
  };
  aguardar criarLinha(carga útil);
  const resumo = formatEntrySummary(payload);
  const recurrenceLabel = describeRecurrence(payload);
  let message = `♻ Conta fixa cadastrada com sucesso!\n\n${resumo}`;
  if (recurrenceLabel) message += `\n\n🔄 Recorrência: ${recurrenceLabel}`;
  message += `\n\n📅 Próximo vencimento: ${formatBRDate(due)}.`;
  message += `\n\n✅ Para confirmar pagamento depois, envie "Confirmar 1".`;
  aguardar sendText(fromRaw, mensagem);
  if (["pix", "boleto"].includes((parsed.tipoPagamento || "").toLowerCase())) {
    aguarde promptAttachPaymentCode(fromRaw, userNorm, payload, "fixed_register");
  }
  aguardar sendMainMenu(fromRaw);
}

// ============================
// Detecção de intenção
// ============================
const INTENÇÕES_CONHECIDAS = novo Conjunto([
  "boas_vindas",
  "mostrar_menu",
  "relatórios_menu",
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

const detectarHeurísticaDeIntenção = (texto) => {
  const lower = (texto || "").toLowerCase();
  const normalizado = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
  se (/\brelat[óo]rios?\b/.test(lower)) retorne "relatorios_menu";
  if (/\brelat[óo]rio\s+completo\b/.test(lower) || /\bcompleto\b/.test(lower)) return "relatorio_completo";
  if (/\blan[cç]amentos\b|extrato/.test(lower)) return "listar_lancamentos";
  if (/contas?\s+a\s+pagar|pendentes|a pagar/.test(lower)) return "listar_pendentes";
  if (/contas?\s+fixas?/.test(lower)) return "contas_fixas";
  if (/edit lan[cc]amento?/.test(lower)) return "edit";
  if (/excluir lan[cç]amentos?/.test(lower)) return "excluir";
  if (/registrar recebimento|\brecebimento\b/.test(lower)) return "registrar_recebimento";
  if (/registrar pagamento|\bpagamento\b|\bpagar\b/.test(lower)) return "registrar_pagamento";
  return "desconhecido";
};

const normalizeIntent = (valor) => {
  Se (!valor) retornar nulo;
  const formatado = valor
    .toString()
    .paraLowerCase()
    .aparar()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_{2,}/g, ​​"_")
    .replace(/^_|_$/g, "");
  retornar INTENÇÕES_CONHECIDAS.tem(formatado) ? formatado : nulo;
};

const buildIntentPrompt = (texto) => {
  const options = Array.from(KNOWN_INTENTS).join(", ");
  retornar [
    {
      função: "sistema",
      contente: [
        {
          tipo: "texto",
          texto:
            "Você é um classificador de intenções para um assistente financeiro no WhatsApp. Responda apenas com uma das intenções disponíveis, sem explicações.",
        },
      ],
    },
    {
      função: "usuário",
      contente: [
        {
          tipo: "texto",
          texto:
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

const detectarIntenção = async (texto) => {
  const fallback = detectIntentHeuristic(texto);
  se (!texto) retornar fallback;
  se (!openaiClient) retornar fallback;
  tentar {
    const output = await callOpenAI({
      modelo: OPENAI_INTENT_MODEL,
      entrada: buildIntentPrompt(texto),
      temperatura: 0,
      maxOutputTokens: 50,
    });
    const predicted = normalizeIntent(output);
    se (previsto) retornar previsto;
  } catch (erro) {
    console.error("Falha ao consultar OpenAI para intenção:", error?.message || error);
  }
  retornar opção alternativa;
};

// ============================
// Webhook
// ============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const desafio = req.query["hub.desafio"];
  se (modo === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    retornar res.status(200).send(challenge);
  }
  retornar res.sendStatus(403);
});

função assíncrona handleInteractiveMessage(de, payload) {
  const { tipo } = payload;
  const userNorm = normalizeUser(from);
  registrarInteraçãoDoUsuário(normaDoUsuário);
  se (tipo === "botão_responder") {
    const id = payload.button_reply.id;
    const payloadId = payload.button_reply?.payload;
    const title = payload.button_reply?.title?.toLowerCase?.() || "";
    se (
      id === TEMPLATE_REMINDER_BUTTON_ID ||
      payloadId === TEMPLATE_REMINDER_BUTTON_ID ||
      title === "ver meus lembretes"
    ) {
      aguardar listPendingPayments(de, userNorm);
      retornar;
    }
    se (id === "REG:STATUS:PAGO") {
      aguardar handleStatusSelection(de, userNorm, "pago");
      retornar;
    }
    se (id === "REG:STATUS:PENDENTE") {
      aguardar handleStatusSelection(de, userNorm, "pendente");
      retornar;
    }
    se (id.startsWith("REG:EDIT:")) {
      const [, , rowId] = id.split(":");
      const row = await findRowById(userNorm, rowId);
      se (!linha) {
        await sendText(from, "Não encontrei o lançamento para editar.");
        retornar;
      }
      sessionEdit.set(userNorm, {
        aguardando: "campo",
        linhas: [linha],
        fila: [{ linha, displayIndex: 1 }],
        currentIndex: 0,
        linha,
        displayIndex: 1,
        expiresAt: Date.now() + SESSION_TIMEOUT_MS,
      });
      const summary = formatEntrySummary(row, { headerLabel: "🧾 Lançamento selecionado:" });
      aguardar enviarTexto(
        de,
        `${summary}\n\n✏ Editar lançamento\n\nEscolha o que deseja alterar:\n\n🏷 Conta\n📝 Descrição\n💰 Valor\n📅 Data\n📌 Status\n📂 Categoria\n\n💡 Dica: Digite exatamente o nome do item que deseja editar.\n(ex: valor, data, categoria...)`
      );
      retornar;
    }
    se (id.startsWith("PAYCODE:ADD:")) {
      const [, , rowId] = id.split(":");
      const state = sessionPaymentCode.get(userNorm);
      se (estado && estado.rowId === rowId) {
        setPaymentCodeState(userNorm, { awaiting: "input", rowId, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      } outro {
        setPaymentCodeState(userNorm, { awaiting: "input", rowId, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      }
      await sendText(from, "🔗 Envie o código do Pix (cópia e cola ou chave Pix) ou o código de barras do boleto.");
      retornar;
    }
    se (id.startsWith("PAYCODE:SKIP:")) {
      sessionPaymentCode.delete(userNorm);
      await sendText(from, "Tudo bem! Se precisar anexar depois, é só me avisar.");
      retornar;
    }
    se (id.startsWith("PAY:MARK:")) {
      const [, , rowId] = id.split(":");
      const state = sessionPayConfirm.get(userNorm);
      const current = state?.queue?.[state.currentIndex || 0];
      se (linha atual && obterIdentificadorDaLinha(linha atual) === rowId) {
        aguarde marcarPagamentoComoPago(de, userNorm, linhaAtual);
      } outro {
        await sendText(from, "Não encontrei o lançamento selecionado para confirmar.");
      }
      retornar;
    }
    se (id === "PAGAR:CANCELAR") {
      sessionPayConfirm.delete(userNorm);
      await sendText(from, "Operação cancelada.");
      retornar;
    }
    se (id.startsWith("PAY:COPY:")) {
      const [, , rowId] = id.split(":");
      const row = await findRowById(userNorm, rowId);
      se (linha) {
        aguardar sendPaymentCode(de, linha);
      } outro {
        await sendText(from, "Não encontrei um código salvo para este lançamento.");
      }
      const state = sessionPayConfirm.get(userNorm);
      se (estado) definirPayState(userNorm, { ...estado, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      retornar;
    }
    se (id === "DEL:CONFIRM:SIM") {
      const handled = await finalizeDeleteConfirmation(from, userNorm, true);
      se (!tratado) {
        await sendText(from, "Nenhum lançamento selecionado para excluir.");
      }
      retornar;
    }
    se (id === "DEL:CONFIRM:NO") {
      aguardar finalizeDeleteConfirmation(de, userNorm, falso);
      retornar;
    }
    se (id.startsWith("REL:CAT:")) {
      const [, , cat] = id.split(":");
      aguardar iniciarReportCategoryFlow(de, userNorm, cat);
      retornar;
    }
    se (id.startsWith("REL:PER:")) {
      const [, , cat, opt] = id.split(":");
      const now = new Date();
      se (opt === "mes_atual") {
        const range = {
          início: inícioDoMês(agora.obterAnoCompleto(), agora.obterMês()),
          fim: fimDoMês(agora.obterAnoCompleto(), agora.obterMês()),
        };
        aguardar showReportByCategory(de, userNorm, cat, range);
        sessionPeriod.delete(userNorm);
      }
      se (opt === "todo_periodo") {
        const linhas = await todasAsLinhasParaUsuário(userNorm);
        seja min = nulo;
        linhas.forEach((linha) => {
          const dt = getEffectiveDate(row);
          se (dt && (!min || dt < min)) min = dt;
        });
        const início = min? startOfDay(min): startOfDay(new Date());
        const end = endOfDay(new Date());
        await showReportByCategory(from, userNorm, cat, { start, end });
        sessionPeriod.delete(userNorm);
      }
      se (opt === "personalizado") {
        sessionPeriod.set(userNorm, { mode: "report", category: cat, awaiting: "range" });
        aguardar enviarTexto(
          de,
          `🗓️ *Selecione um período personalizado*\n\nEnvie no formato:\n01/10/2025 a 31/10/2025\n\n💡 Dica: você pode usar "a", "-", "até".`
        );
      }
      retornar;
    }
    se (id.startsWith("LANC:PER:")) {
      const [, , opt] = id.split(":");
      const now = new Date();
      se (opt === "hoje") {
        const start = startOfDay(now);
        const end = fimDoDia(agora);
        await showLancamentos(from, userNorm, { start, end });
      } else if (opt === "mes_atual") {
        const range = {
          início: inícioDoMês(agora.obterAnoCompleto(), agora.obterMês()),
          fim: fimDoMês(agora.obterAnoCompleto(), agora.obterMês()),
        };
        aguardar showLancamentos(de, userNorm, intervalo);
      } else if (opt === "custom") {
        sessionPeriod.set(userNorm, { mode: "lanc", awaiting: "range" });
        aguardar enviarTexto(
          de,
          `🗓️ *Selecione um período personalizado*\n\nEnvie no formato:\n01/10/2025 a 31/10/2025\n\n💡 Dica: você pode usar "a", "-", "até".`
        );
      }
      retornar;
    }
    se (id === "DEL:ÚLTIMO") {
      const linhas = await todasAsLinhasParaUsuário(userNorm);
      const sorted = rows.sort((a, b) => new Date(getVal(b, "timestamp")) - new Date(getVal(a, "timestamp")));
      const último = classificado[0];
      se (!último) {
        await sendText(from, "Não há lançamentos para excluir.");
        retornar;
      }
      await confirmDeleteRows(from, userNorm, [{ row: last, displayIndex: 1 }]);
      retornar;
    }
    se (id === "DEL:LIST") {
      await listRowsForSelection(from, userNorm, "delete");
      retornar;
    }
    se (id === "CFIX:CAD") {
      sessionFixedRegister.set(userNorm, { expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      aguardar sendCadastrarContaFixaMessage(de);
      retornar;
    }
    se (id === "CFIX:LIST") {
      await sendListarContasFixasMessage(from, userNorm);
      retornar;
    }
    se (id === "CFIX:DEL") {
      aguardar envioExcluirContaFixaMessage(de, userNorm);
      retornar;
    }
  }

  se (tipo === "lista_resposta") {
    const id = payload.list_reply.id;
    se (id.startsWith("REL:CAT:")) {
      const [, , cat] = id.split(":");
      aguardar iniciarReportCategoryFlow(de, userNorm, cat);
      retornar;
    }
    if (id === "MENU:cadastro_pagamento") {
      sessionRegister.set(userNorm, { tipo: "conta_pagar" });
      aguardar enviarTexto(
        de,
        `💰 Novo lançamento de pagamento ou gasto\n\nInforme os detalhes abaixo para registrar corretamente:\n\n📝 Descrição: O que foi pago?\n(ex: Conta de luz, Internet, Academia)\n\n💰 Valor: Quanto custou?\n(ex: 120,00)\n\n📅 Data: Quando foi pago ou deve ser pago?\n(ex: hoje, amanhã ou 25/10/2025)\n\n🏷 Status: Já foi pago ou ainda está pendente?\n(ex: pago / pendente)\n\n📂 Categoria: (opcional)\nA FinPlanner identifica automaticamente, mas você pode informar (ex: Internet, Energia, Alimentação).\n\n💡 Dica: Você também pode escrever tudo em uma linha!\nExemplo:\n➡ Pagar internet 120 amanhã\n➡ Academia 80,00 pago hoje`
      );
      retornar;
    }
    if (id === "MENU:registrar_recebimento") {
      sessionRegister.set(userNorm, { tipo: "conta_receber" });
      aguardar enviarTexto(
        de,
        `💵 Novo lançamento de recebimento\n\nInforme os detalhes abaixo para registrar sua entrada de dinheiro:\n\n📝 Descrição: O que você recebeu?\n(ex: Venda de peças, Salário, Reembolso)\n\n💰 Valor: Quanto foi recebido?\n(ex: 300,00)\n\n📅 Data: Quando foi ou será recebido?\n(ex: hoje, amanhã ou 30/10/2025)\n\n🏷 Status: Já recebeu ou ainda está pendente?\n(ex: recebido / pendente)\n\n📂 Categoria: (opcional)\nA FinPlanner identifica automaticamente (ex: Venda, Salário, Transferência).\n\n💡 Dica: Você pode enviar tudo de uma vez!\nExemplo:\n➡ Receber venda 300 amanhã\n➡ Pix recebido cliente 150 hoje`
      );
      retornar;
    }
    if (id === "MENU:contas_pagar") {
      aguardar listPendingPayments(de, userNorm);
      retornar;
    }
    if (id === "MENU:contas_fixas") {
      aguardar enviarContasFixasMenu(de);
      retornar;
    }
    if (id === "MENU:relatórios") {
      aguardar sendRelatóriosButtons(de);
      retornar;
    }
    if (id === "MENU:lancamentos") {
      aguardar sendLancPeriodoButtons(de);
      retornar;
    }
    se (id === "MENU:editar") {
      aguarde listRowsForSelection(from, userNorm, "edit");
      retornar;
    }
    se (id === "MENU:excluir") {
      aguardar sendDeleteMenu(de);
      retornar;
    }
    se (id === "MENU:ajuda") {
      aguardar enviarTexto(
        de,
        `⚙️ *Ajuda & Exemplos*\n\n🧾 Registrar pagamento\nEx.: Internet 120 pago hoje\n\n💵 Registrar recebimento\nEx.: Venda curso 200 recebido hoje\n\n📊 Relatórios\nToque em Relatórios → escolha *Contas a pagar*, *Recebimentos* ou *Pagamentos* → selecione o período.\n\n🧾 Meus lançamentos\nToque em Meus lançamentos → escolha *Mês atual* ou *Data personalizada*.\n\n✏️ Editar lançamentos\nToque em Editar lançamentos → escolha pelo número → selecione o que deseja alterar.\n\n🗑️ Excluir lançamento\nToque em Excluir lançamento → Último lançamento ou Listar lançamentos.`
      );
      retornar;
    }
  }
}

função parseRangeMessage(texto) {
  const match = text.match(/(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}).*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/);
  se (!match) retorne nulo;
  const start = parseDateToken(match[1]);
  const end = parseDateToken(match[2]);
  se (!início || !fim) retorne nulo;
  retornar { início: inícioDoDia(início), fim: fimDoDia(fim) };
}

função assíncrona handleUserText(fromRaw, texto) {
  const userNorm = normalizeUser(fromRaw);
  console.log("📩 Entrada:", { fromRaw, userNorm });
  registrarInteraçãoDoUsuário(normaDoUsuário);
  const aparado = (texto || "").aparar();
  const mensagemNormalizada = normalizarDiacritics(trimmed).toLowerCase();

  se (userNorm && ADMIN_NUMBER_NORM && userNorm === ADMIN_NUMBER_NORM) {
    if (/^(cron teste|teste cron|cron agora|aviso cron)$/i.test(normalizedMessage)) {
      await sendCronReminderForUser(userNorm, fromRaw, { bypassWindow: true });
      retornar;
    }
  }

  se (!userNorm || userNorm !== ADMIN_NUMBER_NORM) {
    const active = await isUsuarioAtivo(userNorm);
    se (!ativo) {
      const nome = getStoredFirstName(userNorm);
      const saudacaoNome = nome ? `Olá, ${nome}!` : "Olá!";
      aguardar enviarTexto(
        do Raw,
        `${saudacaoNome} Eu sou a FinPlanner IA. Para usar os recursos, você precisa de um plano ativo. Conheça e contrate em: www.finplanneria.com.br`,
        { bypassWindow: true }
      );
      retornar;
    }
  }

  if (await handlePaymentCodeFlow(fromRaw, userNorm, trimmed)) return;
  se (aguardar handleStatusConfirmationFlow(fromRaw, userNorth, trimmed)) retornar;
  if (await handlePaymentConfirmFlow(fromRaw, userNorm, trimmed)) return;
  se (aguardar handleFixedDeleteFlow(fromRaw, userNorm, trimmed)) retornar;
  se (aguardar handleFixedRegisterFlow(fromRaw, userNorm, trimmed)) retornar;
  se (aguardar handleEditFlow(fromRaw, userNorm, trimmed)) retornar;
  se (aguardar handleDeleteFlow(fromRaw, userNorm, trimmed)) retornar;

  const regState = sessionRegister.get(userNorm);
  se (regState) {
    await registerEntry(fromRaw, userNorm, text, regState.tipo);
    sessionRegister.delete(userNorm);
    retornar;
  }

  const perState = sessionPeriod.get(userNorm);
  se (porEstado && porEstado.aguardando === "intervalo") {
    intervalo const = parseRangeMessage(trimmed.replace(/até/gi, "-").replace(/a/gi, "-"));
    se (!intervalo) {
      await sendText(fromRaw, "Formato inválido. Use 01/10/2025 a 31/10/2025.");
      retornar;
    }
    se (perState.mode === "report") {
      aguardar showReportByCategory(fromRaw, userNorm, perState.category, range);
    } else if (perState.mode === "lanc") {
      aguardar showLancamentos(fromRaw, userNorm, range);
    }
    sessionPeriod.delete(userNorm);
    retornar;
  }

  se (
    normalizedMessage === "ver meus lembretes" ||
    normalizedMessage === "meus lembretes" ||
    normalizedMessage.startsWith("ver meus lembretes")
  ) {
    aguardar listPendingPayments(fromRaw, userNorm);
    retornar;
  }

  const intent = await detectIntent(trimmed);
  switch (intent) {
    case "boas_vindas":
      aguardar sendWelcomeList(fromRaw);
      quebrar;
    case "mostrar_menu":
      aguardar sendMainMenu(fromRaw);
      quebrar;
    caso "relatorios_menu":
      aguardar sendRelatóriosButtons(fromRaw);
      quebrar;
    case "relatorio_pagamentos_mes": {
      const now = new Date();
      const range = {
        início: inícioDoMês(agora.obterAnoCompleto(), agora.obterMês()),
        fim: fimDoMês(agora.obterAnoCompleto(), agora.obterMês()),
      };
      aguardar showReportByCategory(fromRaw, userNorm, "pag", range);
      quebrar;
    }
    case "relatorio_recebimentos_mes": {
      const now = new Date();
      const range = {
        início: inícioDoMês(agora.obterAnoCompleto(), agora.obterMês()),
        fim: fimDoMês(agora.obterAnoCompleto(), agora.obterMês()),
      };
      aguardar showReportByCategory(fromRaw, userNorm, "rec", range);
      quebrar;
    }
    case "relatorio_contas_pagar_mes": {
      const now = new Date();
      const range = {
        início: inícioDoMês(agora.obterAnoCompleto(), agora.obterMês()),
        fim: fimDoMês(agora.obterAnoCompleto(), agora.obterMês()),
      };
      aguardar showReportByCategory(fromRaw, userNorm, "cp", range);
      quebrar;
    }
    case "relatorio_completo": {
      const now = new Date();
      const range = {
        início: inícioDoMês(agora.obterAnoCompleto(), agora.obterMês()),
        fim: fimDoMês(agora.obterAnoCompleto(), agora.obterMês()),
      };
      aguardar showReportByCategory(fromRaw, userNorm, "all", range);
      quebrar;
    }
    case "listar_lancamentos":
      aguardar sendLancPeriodoButtons(fromRaw);
      quebrar;
    case "listar_pendentes":
      aguardar listPendingPayments(fromRaw, userNorm);
      quebrar;
    case "contas_fixas":
      aguardar sendContasFixasMenu(fromRaw);
      quebrar;
    case "editar":
      aguarde listRowsForSelection(fromRaw, userNorm, "edit");
      quebrar;
    case "excluir":
      aguardar sendDeleteMenu(fromRaw);
      quebrar;
    case "registrar_recebimento":
      await registerEntry(fromRaw, userNorm, text, "conta_receber");
      quebrar;
    case "registrar_pagamento":
      await registerEntry(fromRaw, userNorm, text, "conta_pagar");
      quebrar;
    padrão:
      const fixoParsed = parseFixedAccountCommand(texto);
      se (fixedParsed) {
        aguardar registroFixedAccount(fromRaw, userNorm, fixedParsed);
      } else if (extractAmountFromText(trimmed).amount) {
        aguarde registrarEntrada(deRaw, userNorm, texto);
      } outro {
        aguardar sendMainMenu(fromRaw);
      }
      quebrar;
  }
}

função assíncrona handleStripeWebhook(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.error("Stripe não configurado corretamente.");
    res.sendStatus(200);
    retornar;
  }

  const sig = req.headers["stripe-signature"];
  se (!sig) {
    console.error("assinatura stripe ausente");
    res.sendStatus(400);
    retornar;
  }
  se (!Buffer.isBuffer(req.body)) {
    console.error("Webhook Stripe sem raw Buffer — verifique se a rota está antes do express.json()");
    res.sendStatus(400);
    retornar;
  }
  deixe o evento;

  tentar {
    evento = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (erro) {
    console.error("⚠️ Stripe raw body inválido:", {
      isBuffer: Buffer.isBuffer(req.body),
      contentType: req.headers["content-type"],
      erro: err.message,
    });
    res.status(400).send(`Erro no webhook: ${err.message}`);
    retornar;
  }

  tentar {
    se (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const subMeta = await getSubscriptionMetadata(stripe, session.subscription);
      const planoRaw = pickFirst(session.metadata?.plano, subMeta?.plano);
      deixe plano = normalizePlan(planoRaw);
      seja priceId = "";

      se (!plano) {
        tentar {
          const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
          preçoId = lineItems?.dados?.[0]?.preço?.id || "";
          console.log("🔎 Itens da linha Stripe:", { sessionId: session.id, priceId });
          se (priceId) {
            if (priceId === STRIPE_PRICE_MENSAL) plano = "mensal";
            senão se (priceId === STRIPE_PRICE_TRIMESTRAL) plano = "trimestral";
            else if (priceId === STRIPE_PRICE_ANUAL) plano = "anual";
          }
          se (plano) {
            console.log("✅ Plano resolvido via priceId:", { plano, priceId });
          }
        } catch (erro) {
          console.error("Erro ao buscar line items do Stripe:", error.message);
        }
      }

      se (!plano) {
        console.log("⚠️ Evento Stripe sem plano válido. planoRaw =", planoRaw, "priceId =", priceId);
        retornar res.sendStatus(200);
      }

      const whatsapp = session.metadata?.whatsapp;
      se (!whatsapp) {
        console.log("⚠️ Evento Stripe sem whatsapp metadata.");
        retornar res.sendStatus(200);
      }

      const userNorm = normalizeUser(whatsapp);
      se (!userNorm) {
        retornar res.sendStatus(200);
      }

      const nome = session.customer_details?.name || session.customer_name || session.metadata?.nome || "";
      const email = session.customer_details?.email || session.customer_email || session.metadata?.email || "";
      console.log("🧾 Upsert usuario:", { userNorm, plano, ativo: true });
      aguarde upsertUsuarioFromSubscription({
        userNorm,
        nome,
        plano,
        e-mail,
        checkout_id: session.id || session.subscription || session.payment_intent || "",
        data_inicio: formatoISODate(nova Data()),
        ativo: true,
        estenderVencimento: verdadeiro,
      });
    }

    se (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const subMeta = await getSubscriptionMetadata(stripe, invoice.subscription);
      const planoRaw = pickFirst(subMeta?.plano);
      const plane = normalizePlan(planeRaw);

      se (!plano) {
        console.log("⚠️ Evento Stripe sem plano válido. planoRaw =", planoRaw);
        retornar res.sendStatus(200);
      }

      const whatsapp = subMeta?.whatsapp;
      se (!whatsapp) {
        console.log("⚠️ Evento Stripe sem whatsapp metadata.");
        retornar res.sendStatus(200);
      }

      const userNorm = normalizeUser(whatsapp);
      se (!userNorm) {
        retornar res.sendStatus(200);
      }

      console.log("🧾 Upsert usuario:", { userNorm, plano, ativo: true });
      aguarde upsertUsuarioFromSubscription({
        userNorm,
        plano,
        ativo: true,
        estenderVencimento: verdadeiro,
      });
    }

    se (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
      const payload = event.data.object || {};
      const subMeta = await getSubscriptionMetadata(stripe, payload.subscription);
      const whatsapp = pickFirst(payload.metadata?.whatsapp, subMeta?.whatsapp);
      se (!whatsapp) {
        console.log("⚠️ Evento Stripe sem whatsapp metadata.");
        retornar res.sendStatus(200);
      }
      const userNorm = normalizeUser(whatsapp);
      se (!userNorm) {
        retornar res.sendStatus(200);
      }
      console.log("🧾 Upsert usuario:", { userNorm, plano: null, ativo: false });
      aguarde upsertUsuarioFromSubscription({
        userNorm,
        ativo: false,
        extendVencimento: false,
      });
    }
  } catch (erro) {
    console.error("Erro ao processar evento Stripe:", error.message);
  }

  res.sendStatus(200);
}

app.post("/webhook", async (req, res) => {
  tentar {
    const body = req.body;
    se (body?.object === "whatsapp_business_account") {
      const entrada = corpo.entrada || [];
      para (constante de entrada) {
        const changes = ent.changes || [];
        para (const mudança de mudanças) {
          const value = change.value || {};
          const mensagens = valor.mensagens || [];
          const statuses = value.statuses || [];
          const contatos = valor.contatos || [];

          para (constante contato de contatos) {
            const waId = normalizeUser(contact.wa_id || contact.waId || contact.id || contact.input);
            const displayName =
              contact.profile?.name || contact.profile?.pushname || contact.profile?.display_name || contact.profile?.first_name;
            se (waId) lembre-se do nome de usuário (waId, nome de exibição);
          }

          para (const status de statuses) {
            se (status.status === "falhou" && ADMIN_WA_NUMBER) {
              aguardar enviarTexto(
                NÚMERO_ADMIN_WA,
                `⚠️ Falha ao entregar mensagem para ${status.recipient_id}: ${status.errors?.[0]?.title || ""}`
              );
            }
          }

          para (constante mensagem de mensagens) {
            const from = mensagem.from;
            const messageId = message.id;
            se (isDuplicateMessage(messageId)) {
              if (DEBUG_SHEETS) console.log(`[Webhook] Ignorando mensagem duplicada ${messageId}`);
              continuar;
            }
            const type = message.type;
            const fromNorm = normalizeUser(from);
            const profileName =
              mensagem.profile?.nome || mensagem.profile?.pushname || mensagem.profile?.display_name || mensagem.profile?.first_name;
            se (fromNorm) lembre-se do nome de usuário (fromNorm, nome do perfil);
            se (tipo === "texto") {
              await handleUserText(from, message.text?.body || "");
            } senão se (tipo === "interativo") {
              await handleInteractiveMessage(from, message.interactive);
            } else if (type === "button") {
              await handleInteractiveMessage(from, { type: "button_reply", button_reply: message.button });
            } outro {
              await sendText(from, "Ainda não entendi esse tipo de mensagem, envie texto ou use o menu.");
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (erro) {
    console.error("Erro no webhook:", error.message);
    res.sendStatus(200);
  }
});

// ============================
// CRON diário 08:00 (America/Maceio)
// ============================
cron.schedule(
  "0 8 * * *",
  assíncrono () => {
    tentar {
      const sheet = await ensureSheet();
      const rows = await withRetry(() => sheet.getRows(), "get-finplanner-cron");
      const hoje = inícioDoDia(novo Date());
      const todayMs = today.getTime();

      const dueByUser = new Map();

      const enqueueReminder = (row, kind) => {
        const dueIso = getVal(row, "vencimento_iso");
        const dueBr = getVal(row, "vencimento_br");
        const dueDate = dueIso ? new Date(dueIso) : parseDateToken(dueBr);
        se (!dueDate || Number.isNaN(dueDate.getTime())) {
          console.log("⚠️ Cron skip (data inválida):", {
            usuário: getVal(linha, "usuário") || getVal(linha, "usuário_bruto"),
            tipo: getVal(linha, "tipo"),
            vencimento_iso: dueIso,
            vencimento_br: dueBr,
          });
          retornar;
        }
        const dueMs = startOfDay(dueDate).getTime();
        se (dueMs > todayMs) {
          console.log("ℹ️ Cron skip (vencimento futuro):", {
            usuário: getVal(linha, "usuário") || getVal(linha, "usuário_bruto"),
            tipo: getVal(linha, "tipo"),
            vencimento_iso: dueIso,
            vencimento_br: dueBr,
          });
          retornar;
        }
        const toRaw = getVal(row, "user_raw") || getVal(row, "user");
        const userNorm = normalizeUser(getVal(row, "user") || getVal(row, "user_raw"));
        se (!toRaw || !userNorm) {
          console.log("⚠️ Cron skip (usuário inválido):", {
            usuário: getVal(linha, "usuário") || getVal(linha, "usuário_bruto"),
            tipo: getVal(linha, "tipo"),
          });
          retornar;
        }
        const bucket = dueByUser.get(userNorm) || { to: toRaw, items: [] };
        se (!bucket.to) bucket.to = toRaw;
        bucket.items.push({ row, kind, dueMs });
        dueByUser.set(userNorm, bucket);
      };

      para (const linha de linhas) {
        const tipo = (getVal(row, "tipo") || "").toString().toLowerCase();
        const status = (getVal(row, "status") || "").toString().toLowerCase();
        if (tipo === "conta_pagar" && status !== "pago") enqueueReminder(row, "pagar");
        if (tipo === "conta_receber" && !["pago", "recebido"].includes(status)) enqueueReminder(row, "receber");
      }

      se (!dueByUser.size) {
        console.log("ℹ️ Cron: nenhum lançamento pendente para hoje ou vencido.");
      }

      para (const [userNorm, bucket] de dueByUser.entries()) {
        const { para, itens } = balde;
        if (!items.length || !to) continue;
        const ativo = await isUsuarioAtivo(userNorm);
        if (!ativo) {
          console.log("⛔ Cron skip (plano inativo):", { userNorm, to, itens: items.length });
          continuar;
        }

        const pagar = items
          .filter((item) => item.kind === "pagar")
          .sort((a, b) => a.dueMs - b.dueMs);
        const receber = items
          .filter((item) => item.kind === "receber")
          .sort((a, b) => a.dueMs - b.dueMs);

        const sections = [];
        seja contador = 1;

        se (comprimento da cerca) {
          const blocks = pagar.map((item) => {
            const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
            const dueLabel = dueRaw || "—";
            const label = item.dueMs < todayMs ? `${dueLabel} (atrasado)` : dueLabel;
            retornar formatEntryBlock(item.row, { index: counter++, dateText: label });
          });
          sections.push(`💸 *Pagamentos pendentes*\n\n${blocks.join("\n\n")}`);
        }

        se (receber.length) {
          const blocks = receber.map((item) => {
            const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
            const dueLabel = dueRaw || "—";
            const label = item.dueMs < todayMs ? `${dueLabel} (atrasado)` : dueLabel;
            retornar formatEntryBlock(item.row, { index: counter++, dateText: label });
          });
          sections.push(`💵 *Recebimentos pendentes*\n\n${blocks.join("\n\n")}`);
        }

        se (!sections.length) continue;

        const message = `⚠️ *Lembrete FinPlanner IA*\n\n${sections.join("\n\n")}`;
        const withinWindow = hasRecentUserInteraction(userNorm);
        console.log("⏰ Tentativa de envio do cron:", {
          userNorm,
          para,
          total: itens.comprimento,
          pagamento: duração do pagamento,
          receber: receber.length,
          dentro da janela,
        });
        const delivered = withinWindow
          ? await sendText(to, message)
          : aguarde sendTemplateReminder(to, userNorm, getStoredFirstName(userNorm));
        se (!entregue || !dentro da janela) {
          console.log("⚠️ Entrega do Cron interrompida:", { userNorm, to, delivered, withinWindow });
          continuar;
        }

        para (constante item de itens) {
          const paymentType = (getVal(item.row, "tipo_pagamento") || "").toString().toLowerCase();
          const code = getVal(item.row, "codigo_pagamento");
          se (!código) continue;
          if (paymentType === "pix") await sendCopyButton(to, "💳 Chave Pix:", code, "Copiar Pix");
          if (paymentType === "boleto") await sendCopyButton(to, "🧾 Código de barras:", code, "Copiar boleto");
        }
      }
    } catch (erro) {
      console.error("Erro CRON:", error.message);
    }
  },
  { timezone: "America/Maceio" }
);

// ============================
// Servidor
// ============================
const port = PORT || 10000;
app.listen(port, () => {
  console.log(`FinPlanner IA (2025-10-23) rodando na porta ${port}`);
  migrarPlanilhasDoUsuário();
});
