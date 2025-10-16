// ============================
// FinPlanner IA - WhatsApp Bot
// ============================

// Importação das bibliotecas
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import OpenAI from "openai";
import cron from "node-cron";

// Carrega variáveis de ambiente
dotenv.config();

const app = express();
app.use(bodyParser.json());

// Configurações da API do WhatsApp Cloud
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) {
  console.error("❌ ERRO: WA_TOKEN ou WA_PHONE_NUMBER_ID não foram carregados corretamente.");
} else {
  console.log("✅ Token e Phone ID carregados com sucesso.");
}

// Configurações do OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configuração do Google Sheets
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_DOC_ID;

const serviceAccountAuth = new JWT({
  email: SERVICE_ACCOUNT_EMAIL,
  key: PRIVATE_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// Função para enviar mensagem pelo WhatsApp
async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v17.0/${WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
      },
    }
  );
}

// Webhook de verificação (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recebe mensagens do WhatsApp
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const text = message.text?.body || "";

    console.log(`Mensagem recebida de ${from}: ${text}`);

    // Processa a mensagem com GPT
    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Você é uma assistente financeira chamada FinPlanner IA. Classifique a mensagem do usuário em: gasto, ganho, conta_a_pagar, conta_a_receber, ou outro. Se for gasto ou conta, identifique valores e datas.",
        },
        { role: "user", content: text },
      ],
    });

    const reply = gptResponse.choices[0].message.content;

    await sendMessage(from, reply);

    // Conecta e registra no Google Sheets
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["movimentos"];
    if (sheet) {
      await sheet.addRow({
        data: new Date().toLocaleString("pt-BR"),
        descricao: text,
        resposta: reply,
      });
    }
  } catch (error) {
    console.error("Erro ao processar mensagem:", error.message);
  }
  res.sendStatus(200);
});

// Agendador diário (lembretes de contas)
cron.schedule("0 9 * * *", async () => {
  console.log("Verificando contas a pagar...");
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["contas_pagar"];
    const rows = await sheet.getRows();

    const hoje = new Date().toISOString().slice(0, 10);
    for (const row of rows) {
      if (row.vencimento === hoje && row.status !== "pago") {
        await sendMessage(
          row.chat_id,
          `🔔 Lembrete: sua conta *${row.descricao}* vence hoje.\nValor: R$ ${row.valor}\nCopie o código de barras: ${row.codigo_barras}`
        );
      }
    }
  } catch (err) {
    console.error("Erro ao verificar contas:", err.message);
  }
});

// Inicializa servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FinPlanner rodando na porta ${PORT}`);
});

