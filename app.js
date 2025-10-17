// ============================
// FinPlanner IA - WhatsApp Bot (versão inteligente)
// ============================

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import OpenAI from "openai";
import cron from "node-cron";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// ============================
// Variáveis de ambiente
// ============================
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "finplanner_verify";
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_DOC_ID;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ============================
// Funções auxiliares
// ============================
const TZ = "America/Maceio";

const firstUp = (s) => (!s ? "" : s.charAt(0).toUpperCase() + s.slice(1));

const normalizePhone = (n) => (n || "").replace(/\D/g, "");

const BRL = (n) =>
  "R$ " +
  (Number(n || 0))
    .toFixed(2)
    .replace(".", ",")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");

// Mensagens com variações automáticas
const mensagens = {
  foraContexto: [
    "⚙️ Desculpe, posso te ajudar apenas com assuntos financeiros como ganhos, gastos, contas a pagar ou receber, relatórios e limites.",
    "💼 Posso te ajudar apenas com finanças, como ganhos, gastos, relatórios e limites.",
    "📊 Sou sua assistente financeira. Posso ajudar com ganhos, gastos e relatórios — nada fora disso, tá bem?",
  ],
  naoEntendi: [
    "❔ Não entendi bem o que você quis dizer. Pode repetir ou ser mais específico?",
    "🤔 Não consegui entender o comando. Tente reformular sua mensagem.",
    "💭 Acho que não entendi o que você quis dizer. Pode me explicar de outro jeito?",
  ],
  boasVindas: [
    "👋 Olá! Sou a FinPlanner IA, sua assistente financeira. Como posso te ajudar hoje?",
    "💰 Oi! Que bom te ver por aqui. Posso te ajudar a registrar um gasto, ganho ou gerar um relatório.",
    "📈 Olá! Sou a FinPlanner IA — sua parceira para organizar suas finanças.",
  ],
};

// Função para escolher uma variação aleatória
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ============================
// Google Sheets (configuração básica)
// ============================
async function getDoc() {
  const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
  await doc.useServiceAccountAuth({ client_email: SERVICE_ACCOUNT_EMAIL, private_key: PRIVATE_KEY });
  await doc.loadInfo();
  return doc;
}

// ============================
// Envio de mensagem WhatsApp
// ============================
async function sendMessage(to, text) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: firstUp(text) },
  };
  try {
    await axios.post(`https://graph.facebook.com/v17.0/${WA_PHONE_NUMBER_ID}/messages`, payload, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_TOKEN}` },
    });
  } catch (e) {
    console.error("Erro ao enviar mensagem:", e.response?.data || e.message);
  }
}

// ============================
// Interpretação inteligente
// ============================
async function interpretarMensagem(mensagem) {
  // usa OpenAI só para interpretar o comando, não para conversar
  try {
    const prompt = `
Você é a FinPlanner IA, uma assistente financeira que apenas entende intenções do usuário.
Apenas interprete o que o usuário quis dizer, mesmo se estiver com erros ou incompleto.

Retorne APENAS UMA palavra representando o tipo:
- "gasto" para registrar despesa
- "ganho" para registrar entrada
- "relatorio" para relatório
- "conta_pagar" ou "conta_receber"
- "limite" para limite
- "saudacao" para oi/olá/bom dia etc.
- "desconhecido" se não entender.
Mensagem: "${mensagem}"
`;
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    const tipo = resp.choices[0].message.content.toLowerCase().trim();
    return tipo.includes("gasto")
      ? "gasto"
      : tipo.includes("ganho")
      ? "ganho"
      : tipo.includes("relatorio")
      ? "relatorio"
      : tipo.includes("conta_pagar")
      ? "conta_pagar"
      : tipo.includes("conta_receber")
      ? "conta_receber"
      : tipo.includes("limite")
      ? "limite"
      : tipo.includes("saud")
      ? "saudacao"
      : "desconhecido";
  } catch (err) {
    console.error("Erro ao interpretar:", err.message);
    return "desconhecido";
  }
}

// ============================
// Webhook Meta (verificação)
// ============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso!");
    res.status(200).send(challenge);
  } else res.status(403).send("Erro na verificação");
});

// ============================
// Webhook de mensagens
// ============================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    const from = message?.from;
    const texto = message?.text?.body?.trim();

    if (!from || !texto) return res.sendStatus(200);

    const tipo = await interpretarMensagem(texto);

    if (tipo === "saudacao") {
      await sendMessage(from, pick(mensagens.boasVindas));
    } else if (["gasto", "ganho", "relatorio", "conta_pagar", "conta_receber", "limite"].includes(tipo)) {
      await sendMessage(from, "✅ Entendido! Vou processar seu comando financeiro.");
    } else if (tipo === "desconhecido") {
      await sendMessage(from, pick(mensagens.naoEntendi));
    } else {
      await sendMessage(from, pick(mensagens.foraContexto));
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Erro ao processar:", error.message);
    res.sendStatus(500);
  }
});

// ============================
// Inicialização
// ============================
app.listen(PORT, () => {
  console.log("✅ FinPlanner IA rodando com interpretação inteligente!");
  console.log(`🚀 Porta: ${PORT}`);
});
