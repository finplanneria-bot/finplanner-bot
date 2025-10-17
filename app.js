// ============================
// FinPlanner IA - WhatsApp Bot
// ============================

// Importação das bibliotecas
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import OpenAI from "openai";
import cron from "node-cron";

// Carrega variáveis de ambiente (.env ou Render)
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

// ============================
// Inicialização do OpenAI
// ============================
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ============================
// Função auxiliar para acessar a planilha (versão correta)
// ============================
async function getSheet() {
  try {
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID);

    // Autenticação da conta de serviço
    await doc.useServiceAccountAuth({
      client_email: SERVICE_ACCOUNT_EMAIL,
      private_key: PRIVATE_KEY,
    });

    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0]; // primeira aba da planilha
    return sheet;
  } catch (error) {
    console.error("❌ Erro ao conectar ao Google Sheets:", error.message);
    throw error;
  }
}

// ============================
// Função para enviar mensagens no WhatsApp
// ============================
async function sendMessage(to, text) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v17.0/${WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${WA_TOKEN}`,
        },
      }
    );
    console.log("✅ Mensagem enviada com sucesso:", response.data);
  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error.response?.data || error.message);
  }
}

// ============================
// Webhook de verificação (usado pelo Meta)
// ============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso!");
    res.status(200).send(challenge);
  } else {
    res.status(403).send("Erro na verificação do webhook");
  }
});

// ============================
// Webhook de recebimento de mensagens
// ============================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message && message.type === "text") {
      const from = message.from;
      const userText = message.text.body;

      console.log(`📩 Mensagem recebida de ${from}: ${userText}`);

      // 🔹 Salvar a mensagem no Google Sheets
      try {
        const sheet = await getSheet();
        await sheet.addRow({ Numero: from, Mensagem: userText });
        console.log("📊 Mensagem salva no Google Sheets!");
      } catch (error) {
        console.error("❌ Erro ao salvar no Google Sheets:", error.message);
      }

      // 🔹 Gerar resposta com IA (OpenAI)
      let aiResponse = "Desculpe, não consegui entender sua solicitação.";

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Você é a FinPlanner IA, uma assistente financeira inteligente e simpática." },
            { role: "user", content: userText },
          ],
        });

        aiResponse = completion.choices[0].message.content;
      } catch (error) {
        console.error("❌ Erro ao gerar resposta da IA:", error.message);
      }

      // 🔹 Enviar resposta automática
      await sendMessage(from, aiResponse);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Erro ao processar mensagem:", error.message);
    res.sendStatus(500);
  }
});

// ============================
// Rota de teste manual
// ============================
app.get("/send", async (req, res) => {
  await sendMessage("557998149934", "🚀 FinPlanner conectado com sucesso!");
  res.send("Mensagem de teste enviada!");
});

// ============================
// Inicialização do servidor
// ============================
app.listen(PORT, () => {
  console.log(`✅ Token e Phone ID carregados com sucesso.`);
  console.log(`🚀 FinPlanner rodando na porta ${PORT}`);
});
