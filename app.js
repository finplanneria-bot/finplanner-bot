// ============================
// FinPlanner IA - WhatsApp Bot (Versão Completa)
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
// Google Sheets (autenticação)
// ============================
async function getSheet(sheetName) {
  const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: SERVICE_ACCOUNT_EMAIL,
    private_key: PRIVATE_KEY,
  });
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[sheetName] || doc.sheetsByIndex[0];
  return sheet;
}

// ============================
// Enviar mensagens via WhatsApp Cloud
// ============================
async function sendMessage(to, text, buttons = null) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  if (buttons) {
    payload.type = "interactive";
    payload.interactive = {
      type: "button",
      body: { text },
      action: { buttons },
    };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v17.0/${WA_PHONE_NUMBER_ID}/messages`,
      payload,
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
// Webhook de verificação (Meta)
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
// Processar mensagens recebidas
// ============================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message && message.type === "text") {
      const from = message.from;
      const userText = message.text.body.trim();
      console.log(`📩 Mensagem recebida de ${from}: ${userText}`);

      // ============================
      // Armazenar mensagem no Sheets (Movimentos)
      // ============================
      try {
        const sheet = await getSheet("Movimentos");
        await sheet.addRow({
          Data: new Date().toLocaleString("pt-BR"),
          Numero: from,
          Mensagem: userText,
        });
        console.log("📊 Mensagem salva no Google Sheets!");
      } catch (err) {
        console.error("❌ Erro ao salvar no Google Sheets:", err.message);
      }

      // ============================
      // Identificar intenção (financeira ou não)
      // ============================
      const prompt = `
Você é a FinPlanner IA, uma assistente financeira. 
Responda apenas perguntas e mensagens relacionadas a finanças pessoais, ganhos, gastos, contas, relatórios ou limites.
Se o assunto não for financeiro, diga: 
"🤖 Desculpe, posso te ajudar apenas com assuntos financeiros (ganhos, gastos, contas, relatórios e limites)."

Mensagem do usuário: "${userText}"
Responda de forma curta, educada, com até 2 emojis, e começando com letra maiúscula.
`;

      let aiResponse = "";

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Você é a FinPlanner IA, uma assistente financeira inteligente." },
            { role: "user", content: prompt },
          ],
        });

        aiResponse = completion.choices[0].message.content.trim();
      } catch (error) {
        aiResponse = "❌ Desculpe, ocorreu um erro ao processar sua solicitação.";
        console.error("Erro OpenAI:", error.message);
      }

      // Envia resposta
      await sendMessage(from, aiResponse);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Erro ao processar mensagem:", error.message);
    res.sendStatus(500);
  }
});

// ============================
// Rotas de teste e relatórios
// ============================

// Envia mensagem de teste manual
app.get("/send", async (req, res) => {
  await sendMessage("557998149934", "🚀 FinPlanner conectada com sucesso!");
  res.send("Mensagem de teste enviada!");
});

// Gera relatório simples (exemplo)
app.get("/relatorio/:numero", async (req, res) => {
  try {
    const numero = req.params.numero;
    const sheet = await getSheet("Movimentos");
    const rows = await sheet.getRows();
    const userRows = rows.filter((r) => r.Numero === numero);

    const totalGanhos = userRows
      .filter((r) => r.Tipo === "Ganho")
      .reduce((sum, r) => sum + Number(r.Valor || 0), 0);
    const totalGastos = userRows
      .filter((r) => r.Tipo === "Gasto")
      .reduce((sum, r) => sum + Number(r.Valor || 0), 0);
    const saldo = totalGanhos - totalGastos;

    res.json({
      usuario: numero,
      ganhos: totalGanhos,
      gastos: totalGastos,
      saldo,
    });
  } catch (err) {
    console.error("Erro ao gerar relatório:", err.message);
    res.status(500).send("Erro ao gerar relatório");
  }
});

// ============================
// Inicialização do servidor
// ============================
app.listen(PORT, () => {
  console.log("✅ Token e Phone ID carregados com sucesso.");
  console.log(`🚀 FinPlanner rodando na porta ${PORT}`);
});
