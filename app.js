// ============================
// 🤖 FinPlanner IA - WhatsApp Bot
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

// Configurações do Google Sheets
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

const serviceAccountAuth = new JWT({
  email: GOOGLE_CLIENT_EMAIL,
  key: GOOGLE_PRIVATE_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);

// Configurações do OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============================
// Funções auxiliares
// ============================

async function enviarMensagem(numero, mensagem, botoes = null) {
  const data = {
    messaging_product: "whatsapp",
    to: numero,
    type: botoes ? "interactive" : "text",
  };

  if (botoes) {
    data.interactive = botoes;
  } else {
    data.text = { body: mensagem };
  }

  await axios.post(
    `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`,
    data,
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}

function criarBotoesPixOuBoleto(tipo, valor) {
  return {
    type: "button",
    body: { text: tipo === "pix" ? "💸 Clique para copiar a chave Pix:" : "🏦 Código de barras:" },
    action: {
      buttons: [
        {
          type: "reply",
          reply: {
            id: "copiar_chave",
            title: valor.length > 30 ? valor.slice(0, 30) + "..." : valor,
          },
        },
      ],
    },
  };
}

// ============================
// Funções principais
// ============================

async function interpretarMensagem(mensagem) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Você é uma IA financeira que interpreta comandos curtos de texto sobre pagamentos e recebimentos. Retorne em formato JSON: {acao: pagar|receber|listar, nome: string, valor: number, data: string (ou null se não houver), tipo: 'pix'|'boleto'|null, codigo: string|null}",
        },
        { role: "user", content: mensagem },
      ],
      temperature: 0.3,
    });

    const texto = response.choices[0].message.content.trim();
    return JSON.parse(texto);
  } catch (e) {
    return null;
  }
}

// ============================
// Webhook de mensagens recebidas
// ============================

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const mensagem = entry?.messages?.[0];
    if (!mensagem) return res.sendStatus(200);

    const numero = mensagem.from;
    const texto = mensagem.text?.body?.trim();

    // 👋 Boas-vindas
    if (["oi", "olá", "opa", "bom dia", "boa tarde", "boa noite"].includes(texto.toLowerCase())) {
      const msg = `👋 *Bem-vindo(a) à FinPlanner IA!*\n\nSou sua assistente financeira e posso te ajudar a:\n\n💰 *Organizar pagamentos e contas a receber*\n📅 *Lembrar dos vencimentos automaticamente*\n💸 *Anexar chaves Pix ou códigos de boleto aos pagamentos*\n📋 *Listar tudo o que está por vencer*\n\nVocê pode me enviar, por exemplo:\n\n• _Pagar energia R$250 vence 20/10_\n• _Receber de João R$120 no dia 25_\n• _Pix 87918888 pra Maria dia 30_\n• _Boleto 34191.79001... vence 05/11_\n• _Meus pagamentos_\n\nEu salvo automaticamente e te aviso no dia do vencimento.`;
      await enviarMensagem(numero, msg);
      return res.sendStatus(200);
    }

    // Interpretação da mensagem
    const dados = await interpretarMensagem(texto);

    if (!dados || !dados.acao) {
      const msgErro = `🤔 Não consegui entender seu comando.\n\nTente algo como:\n\n💵 *Pagar R$150 ao João no dia 25/10*\n💸 *Receber R$200 do Carlos amanhã*\n📋 *Meus pagamentos*`;
      await enviarMensagem(numero, msgErro);
      return res.sendStatus(200);
    }

    // Processar ação
    switch (dados.acao) {
      case "pagar":
      case "receber":
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        await sheet.addRow({
          Tipo: dados.acao,
          Nome: dados.nome,
          Valor: dados.valor,
          Data: dados.data,
          Codigo: dados.codigo || "",
          PixOuBoleto: dados.tipo || "",
          Numero: numero,
        });

        let msg = `✅ ${dados.acao === "pagar" ? "Pagamento" : "Recebimento"} salvo com sucesso!\n\n${
          dados.acao === "pagar" ? "💰" : "💵"
        } *${dados.nome}* — R$${dados.valor}\n📅 *Vencimento:* ${dados.data || "não informado"}`;

        if (dados.codigo) {
          const botoes = criarBotoesPixOuBoleto(dados.tipo, dados.codigo);
          await enviarMensagem(numero, msg, botoes);
        } else {
          await enviarMensagem(numero, msg);
        }
        break;

      case "listar":
        await doc.loadInfo();
        const sheetList = doc.sheetsByIndex[0];
        const rows = await sheetList.getRows();
        const hoje = new Date();
        const pendentes = rows.filter((r) => new Date(r.Data) >= hoje && r.Numero === numero);
        if (pendentes.length === 0) {
          await enviarMensagem(numero, "📭 Você não tem pagamentos ou recebimentos pendentes.");
        } else {
          let lista = "📋 *Seus próximos vencimentos:*\n\n";
          pendentes.forEach((r) => {
            lista += `${r.Tipo === "pagar" ? "💰" : "💵"} ${r.Nome} — R$${r.Valor} em ${r.Data}\n`;
          });
          await enviarMensagem(numero, lista);
        }
        break;
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Erro no webhook:", e);
    res.sendStatus(500);
  }
});

// ============================
// Lembretes automáticos (cron)
// ============================

cron.schedule("0 9 * * *", async () => {
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  const hoje = new Date().toISOString().split("T")[0];

  for (const r of rows) {
    if (r.Data === hoje) {
      const msg = `⏰ *Lembrete FinPlanner IA*\n\nHoje vence ${
        r.Tipo === "pagar" ? "seu pagamento" : "seu recebimento"
      }:\n\n${r.Tipo === "pagar" ? "💰" : "💵"} *${r.Nome}* — R$${r.Valor}\n📅 ${r.Data}`;
      if (r.Codigo) {
        const botoes = criarBotoesPixOuBoleto(r.PixOuBoleto, r.Codigo);
        await enviarMensagem(r.Numero, msg, botoes);
      } else {
        await enviarMensagem(r.Numero, msg);
      }
    }
  }
});

// ============================
// Inicialização do servidor
// ============================

app.listen(3000, () => console.log("🚀 FinPlanner IA rodando na porta 3000!"));
