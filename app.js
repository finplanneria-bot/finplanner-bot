// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-17)
// ============================
// Mantém: WhatsApp Cloud API + Google Sheets + OpenAI (apenas intenção)
// Novidades: mensagens visuais, armazenamento automático de conta a pagar,
//             botões interativos "Copiar chave Pix" e "Copiar código de barras",
//             lembretes com botão correspondente.

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
  return new Date(); // ambiente de hospedagem pode não respeitar TZ; ajustamos ao formatar
}

function formatBRDate(date) {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function toISODate(date) {
  // Zera horas para facilitar comparações de "vencimento em dia"
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function parseCurrencyBR(text) {
  // Captura padrões como: R$ 1.234,56 ou 123,45
  const m = text.match(/(?:R\$\s*)?([0-9]{1,3}(?:\.[0-9]{3})*|[0-9]+)(?:,([0-9]{2}))?/);
  if (!m) return null;
  const inteiro = m[1].replace(/\./g, "");
  const centavos = m[2] || "00";
  return parseFloat(`${inteiro}.${centavos}`);
}

function formatCurrencyBR(v) {
  try {
    return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  } catch {
    return `R$ ${Number(v).toFixed(2)}`;
  }
}

function detectBarcode(text) {
  // Muito permissivo: pega sequências longas de dígitos e pontos/espaços
  const clean = text.replace(/\n/g, " ");
  const m = clean.match(/[0-9\.\s]{30,}/);
  return m ? m[0].trim().replace(/\s+/g, " ") : null;
}

function detectPixKey(text) {
  // Heurística: e-mail, telefone com DDI/DDD, CPF/CNPJ, chaves aleatórias (GUID-like), palavras "pix" próximas
  const hasPixWord = /\bpix\b/i.test(text);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone = text.match(/\+?\d{10,14}/);
  const cpf = text.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
  const cnpj = text.match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/);
  const chaveAleatoria = text.match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);

  const candidate = email?.[0] || phone?.[0] || cpf?.[0] || cnpj?.[0] || chaveAleatoria?.[0];
  return hasPixWord && candidate ? candidate : null;
}

function parseDueDate(text) {
  // Captura dd/mm ou dd/mm/yyyy e também palavras "vence dia", "vencimento"
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
  // procura "vence dia 20" e assume mês atual
  const venceDia = text.match(/vence(?:r|\b|\s|\w)*\bdia\b\s*(\d{1,2})/i) || text.match(/vencimento\s*(\d{1,2})/i);
  if (venceDia) {
    const d = parseInt(venceDia[1], 10);
    const now = brNow();
    return new Date(now.getFullYear(), now.getMonth(), d, 0, 0, 0, 0);
  }
  return null;
}

function guessBillName(text) {
  // Tenta extrair uma "label" simples: energia, água, internet, aluguel etc.
  const labels = ["energia", "luz", "água", "internet", "aluguel", "telefone", "cartão", "iptu", "condomínio", "conta", "fatura"];
  const lower = text.toLowerCase();
  for (const l of labels) {
    if (lower.includes(l)) return l.charAt(0).toUpperCase() + l.slice(1);
  }
  // fallback: primeiras 4 palavras
  return lower.split(/\s+/).slice(0, 4).join(" ") || "Conta";
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
  // Usa mensagens interativas com botão do tipo copy_code
  // Referência: Cloud API - interactive copy_code
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

// ----------------------------
// Google Sheets - inicialização e escrita
// ----------------------------
async function ensureSheet() {
  await doc.loadInfo();
  sheet = doc.sheetsByTitle["finplanner"];
  if (!sheet) {
    sheet = await doc.addSheet({ title: "finplanner", headerValues: [
      "timestamp", "user", "tipo", "conta", "valor", "vencimento_iso", "vencimento_br",
      "tipo_pagamento", "codigo_pagamento", "status"
    ]});
  } else {
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues || [];
    const need = ["timestamp","user","tipo","conta","valor","vencimento_iso","vencimento_br","tipo_pagamento","codigo_pagamento","status"];
    // adiciona colunas que faltarem
    let changed = false;
    for (const h of need) {
      if (!headers.includes(h)) { headers.push(h); changed = true; }
    }
    if (changed) await sheet.setHeaderRow(headers);
  }
}

async function addBillRow({ user, conta, valor, vencimento, tipo_pagamento, codigo_pagamento }) {
  await ensureSheet();
  const row = {
    timestamp: new Date().toISOString(),
    user,
    tipo: "conta_pagar",
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
  return rows.filter(r => r.get("tipo") === "conta_pagar" && r.get("status") !== "pago" && r.get("vencimento_iso") && (new Date(r.get("vencimento_iso")).getTime() === today.getTime()));
}

// ----------------------------
// Interpretação de intenção (sem texto livre)
// ----------------------------
async function detectIntent(text) {
  const lower = text.toLowerCase();

  // Heurísticas rápidas primeiro
  const isGreeting = /\b(oi|olá|ola|opa|bom dia|boa tarde|boa noite)\b/.test(lower);
  if (isGreeting) return { type: "boas_vindas" };

  const hasKeywordsConta = /(nova|adicionar|add|registrar|lançar|incluir).*\b(conta|despesa|fatura)\b|\bconta a pagar\b|\bvenc(e|imento)\b/.test(lower);
  const hasMoney = /r\$|\d+[\.,]\d{2}\b/.test(lower);
  const hasDue = /\bvence|vencimento|dia\b/.test(lower) || /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(lower);
  if (hasKeywordsConta || (hasMoney && hasDue)) return { type: "nova_conta" };

  if (/\b(meus|listar|mostrar) (pagamentos|contas|a pagar)\b/.test(lower)) return { type: "listar_contas" };
  if (/\brelat(orio|ório)\b/.test(lower)) return { type: "relatorio" };
  if (/\bconfirm(ar)? pagamento|paguei|pago\b/.test(lower)) return { type: "confirmar_pagamento" };

  // OpenAI (opcional) apenas para classificar rótulo
  if (USE_OPENAI && openai) {
    try {
      const prompt = `Classifique a intenção da mensagem do usuário em UMA de: boas_vindas, nova_conta, listar_contas, relatorio, confirmar_pagamento, desconhecido.\nMensagem: "${text}"\nResposta apenas com o rótulo.`;
      const r = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: prompt,
      });
      const label = (r.output_text || "").trim().toLowerCase();
      return { type: ["boas_vindas","nova_conta","listar_contas","relatorio","confirmar_pagamento"].includes(label) ? label : "desconhecido" };
    } catch (e) {
      console.error("OpenAI intent error:", e.message);
    }
  }

  return { type: "desconhecido" };
}

// ----------------------------
// Respostas padronizadas (sem texto livre)
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

function msgContaSalva({ conta, valor, vencimento, tipoPagamento }) {
  const valorFmt = valor != null ? formatCurrencyBR(valor) : "—";
  const dataFmt = vencimento ? formatBRDate(vencimento) : "—";
  const tipo = tipoPagamento === "pix" ? "💳 Pagamento via Pix" : (tipoPagamento === "boleto" ? "🧾 Pagamento via Boleto" : "");
  return (
    "🧾 *Conta salva com sucesso!*\n\n" +
    `💡 Conta: ${conta}\n` +
    `💰 Valor: ${valorFmt}\n` +
    `📅 Vencimento: ${dataFmt}\n` +
    (tipo ? `${tipo}\n\n` : "\n") +
    "🔔 Te lembrarei no dia do vencimento!"
  );
}

function msgDesconhecido() {
  return (
    "🤔 *Não entendi seu comando.*\n\n" +
    "Tente algo como:\n" +
    "• `Aluguel R$ 1.200 vence 10/11 pix +5583988887777`\n" +
    "• `Meus pagamentos` (para listar o que está por vencer)"
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
    "Se preferir, toque no botão abaixo para copiar e pagar."
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

// ----------------------------
// Processamento de mensagem do usuário
// ----------------------------
async function handleUserText(from, text) {
  const intent = await detectIntent(text);

  if (intent.type === "boas_vindas") {
    await sendText(from, msgBoasVindas());
    return;
  }

  if (intent.type === "nova_conta") {
    // Extrai dados
    const conta = guessBillName(text);
    const valor = parseCurrencyBR(text);
    const vencimento = parseDueDate(text);
    const pix = detectPixKey(text);
    const boleto = pix ? null : detectBarcode(text); // se detectou Pix, prioriza Pix

    let tipo_pagamento = "";
    let codigo_pagamento = "";

    if (pix) { tipo_pagamento = "pix"; codigo_pagamento = pix; }
    else if (boleto) { tipo_pagamento = "boleto"; codigo_pagamento = boleto; }

    await addBillRow({
      user: from,
      conta,
      valor,
      vencimento,
      tipo_pagamento,
      codigo_pagamento,
    });

    // Mensagem de confirmação bonita
    await sendText(from, msgContaSalva({ conta, valor, vencimento, tipoPagamento: tipo_pagamento }));

    // Envia botão interativo se houver método
    if (tipo_pagamento === "pix") {
      await sendInteractiveCopyButton({
        to: from,
        title: "💳 Chave Pix disponível:",
        copyText: codigo_pagamento,
        buttonTitle: "Copiar chave Pix",
      });
    } else if (tipo_pagamento === "boleto") {
      await sendInteractiveCopyButton({
        to: from,
        title: "🧾 Código de barras do boleto:",
        copyText: codigo_pagamento,
        buttonTitle: "Copiar código de barras",
      });
    }

    return;
  }

  if (intent.type === "listar_contas") {
    await ensureSheet();
    const rows = await sheet.getRows();
    const today = new Date(); today.setHours(0,0,0,0);

    const próximos = rows
      .filter(r => r.get("tipo") === "conta_pagar" && r.get("user") === from && r.get("status") !== "pago")
      .map(r => ({
        conta: r.get("conta"),
        valor: parseFloat(r.get("valor") || "0"),
        vencimento: r.get("vencimento_iso") ? new Date(r.get("vencimento_iso")) : null,
      }))
      .sort((a,b) => (a.vencimento?.getTime()||0) - (b.vencimento?.getTime()||0))
      .slice(0, 10);

    if (!próximos.length) {
      await sendText(from, "✅ Você não tem contas pendentes registradas.");
      return;
    }

    let msg = msgListaCabecalho() + "\n\n";
    for (const item of próximos) {
      msg += msgLinhaLista(item) + "\n";
    }
    await sendText(from, msg.trim());
    return;
  }

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

  // fallback
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

            if (msg.type === "text") {
              const text = msg.text?.body || "";
              await handleUserText(from, text);
            }

            // Opcional: tratar botões clicados, etc.
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
