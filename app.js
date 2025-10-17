// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-18.4)
// ============================
// 🧠 IA apenas interpreta intenção (OpenAI) → respostas SEMPRE padronizadas
// 💾 Registra sempre contas/recebimentos no Google Sheets
// 💬 Valores sempre no formato “R$0,00”
// 🔔 Lembretes automáticos de vencimento + botões Pix/Boleto/Confirmar
// 🧱 Autenticação 100% compatível com Google Sheets (sem erro de auth)
// ============================

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import OpenAI from "openai";
import cron from "node-cron";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// ============================
// Logs de diagnóstico
// ============================
console.log("🔍 Testando variáveis de ambiente FinPlanner IA:");
console.log("SHEETS_ID:", process.env.SHEETS_ID ? "✅ OK" : "❌ FALTA");
console.log("GOOGLE_SERVICE_ACCOUNT_EMAIL:", process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "❌ AUSENTE");
console.log("GOOGLE_SERVICE_ACCOUNT_KEY:", process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? "✅ DETECTADA" : "❌ FALTA");
console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "✅ DETECTADA" : "❌ FALTA");
console.log("USE_OPENAI:", process.env.USE_OPENAI);

// ----------------------------
// Config - WhatsApp Cloud API
// ----------------------------
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;

// ----------------------------
// Config - OpenAI (interpretação)
// ----------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_OPENAI = (process.env.USE_OPENAI || "false").toLowerCase() === "true";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ----------------------------
// Config - Google Sheets (autenticação universal)
// ----------------------------
const SHEETS_ID = process.env.SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}
const doc = new GoogleSpreadsheet(SHEETS_ID);

// Função de autenticação universal
async function ensureAuth() {
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_KEY || !SHEETS_ID) {
    console.error("❌ Erro ao autenticar Google Sheets: Variáveis de autenticação ausentes");
    throw new Error("Variáveis de autenticação ausentes");
  }
  try {
    await doc.useServiceAccountAuth({
      client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: GOOGLE_SERVICE_ACCOUNT_KEY,
    });
    await doc.loadInfo();
  } catch (e) {
    console.error("❌ Falha na autenticação do Google Sheets:", e.message);
    throw e;
  }
}

// Cria ou ajusta automaticamente a aba e cabeçalhos
async function ensureSheet() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["finplanner"];
  const headersNecessarios = [
    "row_id",
    "timestamp",
    "user",
    "tipo",
    "conta",
    "valor",
    "vencimento_iso",
    "vencimento_br",
    "tipo_pagamento",
    "codigo_pagamento",
    "status",
  ];

  if (!sheet) {
    console.log("📄 Criando nova aba 'finplanner' no Google Sheets...");
    sheet = await doc.addSheet({ title: "finplanner", headerValues: headersNecessarios });
    console.log("✅ Aba criada com sucesso!");
    return sheet;
  }

  await sheet.loadHeaderRow();
  const headersAtuais = sheet.headerValues || [];
  let alterado = false;
  for (const h of headersNecessarios) {
    if (!headersAtuais.includes(h)) {
      headersAtuais.push(h);
      alterado = true;
      console.log(`➕ Adicionando coluna ausente: ${h}`);
    }
  }
  if (alterado) {
    await sheet.setHeaderRow(headersAtuais);
    console.log("✅ Cabeçalhos atualizados com sucesso!");
  } else {
    console.log("📄 Cabeçalhos já existentes e completos.");
  }

  return sheet;
}

// ============================
// Utilitários
// ============================
function uuidShort() {
  return crypto.randomBytes(6).toString("hex");
}
function formatBRDate(date) {
  if (!date) return "—";
  const d = new Date(date);
  return d.toLocaleDateString("pt-BR");
}
function toISODate(date) {
  if (!date) return "";
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function formatCurrencyBR(v) {
  try {
    return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  } catch {
    return `R$${Number(v || 0).toFixed(2).replace(".", ",")}`;
  }
}
function parseCurrencyBR(text) {
  const t = (text || "").replace(/\s+/g, " ").toLowerCase();
  const match = t.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/i);
  if (!match) return null;
  const inteiro = match[1].replace(/\./g, "");
  const centavos = match[2] || "00";
  return parseFloat(`${inteiro}.${centavos}`);
}
function detectBarcode(text) {
  const m = (text || "").replace(/\n/g, " ").match(/[0-9\.\s]{30,}/);
  return m ? m[0].trim().replace(/\s+/g, " ") : null;
}
function detectPixKey(text) {
  const hasPix = /\bpix\b/i.test(text || "");
  const email = (text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone = (text || "").match(/\+?\d{10,14}/);
  const cpf = (text || "").match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
  const cnpj = (text || "").match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/);
  const chave = (text || "").match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);
  return hasPix ? email?.[0] || phone?.[0] || cpf?.[0] || cnpj?.[0] || chave?.[0] : null;
}
function parseDueDate(text) {
  const now = new Date();
  const dmY = (text || "").match(/(\b\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dmY) {
    let [_, d, m, y] = dmY;
    const year = y ? (y.length === 2 ? 2000 + parseInt(y) : parseInt(y)) : now.getFullYear();
    return new Date(year, parseInt(m) - 1, parseInt(d));
  }
  if (/\bamanh[aã]\b/i.test(text || "")) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (/\bhoje\b/i.test(text || "")) return now;
  if (/\bsexta\b/i.test(text || "")) {
    const d = new Date(now);
    const day = d.getDay();
    const delta = (5 - day + 7) % 7 || 7;
    d.setDate(d.getDate() + delta);
    return d;
  }
  return null;
}
function guessBillName(text) {
  const labels = ["energia", "luz", "água", "agua", "internet", "aluguel", "telefone", "cartão", "cartao", "condominio"];
  const lower = (text || "").toLowerCase();
  for (const l of labels) if (lower.includes(l)) return l.charAt(0).toUpperCase() + l.slice(1);
  const who = (text || "").match(/\b(?:pra|para|ao|a|à|de)\s+([\wÁÉÍÓÚÂÊÔÃÕÇ]+)/i);
  return who ? who[1] : (lower.split(/\s+/).slice(0, 3).join(" ") || "Conta").replace(/\b\w/g, c => c.toUpperCase());
}

// ============================
// WhatsApp - envio
// ============================
async function sendWA(payload) {
  try {
    await axios.post(WA_API, payload, { headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("Erro ao enviar mensagem WA:", e.response?.data || e.message);
  }
}
async function sendText(to, text) {
  return sendWA({ messaging_product: "whatsapp", to, type: "text", text: { body: text } });
}
async function sendCopyButton(to, title, copyText, buttonTitle) {
  if (!copyText) return;
  return sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "button", body: { text: title }, action: { buttons: [{ type: "copy_code", copy_code: copyText, title: buttonTitle }] } },
  });
}
async function sendConfirmButton(to, rowId) {
  return sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "button", body: { text: "Quando pagar, toque abaixo para confirmar:" }, action: { buttons: [{ type: "reply", reply: { id: `CONFIRMAR:${rowId}`, title: "✅ Confirmar pagamento" } }] } },
  });
}

// ============================
// IA - interpretação
// ============================
async function detectIntent(text) {
  const lower = (text || "").toLowerCase();
  if (/\b(oi|olá|ola|opa|bom dia|boa tarde|boa noite)\b/.test(lower)) return "boas_vindas";
  if (/\b(meus pagamentos|listar|mostrar)\b/.test(lower)) return "listar_contas";
  if (/\b(pagar|pagamento|transferir|enviar|quitar|liquidar)\b/.test(lower)) return "nova_conta";
  if (/\b(receber|entrada|venda|ganhar)\b/.test(lower)) return "novo_recebimento";
  if (/\bconfirm(ar)? pagamento|paguei|pago|liquidei|baixei\b/.test(lower)) return "confirmar_pagamento";

  if (USE_OPENAI && openai) {
    try {
      const r = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `Classifique esta frase em uma das categorias: nova_conta, novo_recebimento, listar_contas, confirmar_pagamento, boas_vindas, fora_contexto, desconhecido.\nFrase: ${text}`,
      });
      const label = (r.output_text || "").trim().toLowerCase();
      return ["nova_conta","novo_recebimento","listar_contas","confirmar_pagamento","boas_vindas","fora_contexto"].includes(label) ? label : "desconhecido";
    } catch { return "desconhecido"; }
  }
  return "desconhecido";
}

// ============================
// Manipulação de mensagens
// ============================
async function handleUserText(from, text) {
  const intent = await detectIntent(text);
  const sheet = await ensureSheet();

  if (intent === "boas_vindas") {
    await sendText(from, "👋 *Olá! Eu sou a FinPlanner IA.*\n\n💡 *Sou sua assistente financeira e posso te ajudar a organizar pagamentos e recebimentos de forma simples e automática.*\n\nVocê pode me enviar mensagens como:\n• `Pagar energia R$150,00 amanhã`\n• `Receber de João R$200,00 sexta`\n• `Meus pagamentos`\n\n🔔 Eu aviso você no dia do vencimento e registro tudo automaticamente na sua planilha.");
    return;
  }
  if (intent === "fora_contexto") {
    await sendText(from, "💬 *Sou sua assistente financeira e posso te ajudar a organizar pagamentos e recebimentos.*");
    return;
  }
  if (intent === "listar_contas") {
    const rows = await sheet.getRows();
    const pendentes = rows.filter(r => r.get("tipo") === "conta_pagar" && r.get("user") === from && r.get("status") !== "pago");
    if (!pendentes.length) { await sendText(from, "✅ Você não tem contas pendentes registradas."); return; }
    let msg = "📋 *Aqui estão suas contas pendentes:*\n\n";
    pendentes.forEach(p => { msg += `• ${formatBRDate(p.get("vencimento_iso"))} — ${p.get("conta")} (${formatCurrencyBR(p.get("valor"))})\n`; });
    await sendText(from, msg.trim());
    return;
  }
  if (intent === "nova_conta" || intent === "novo_recebimento") {
    const valor = parseCurrencyBR(text);
    const vencimento = parseDueDate(text);
    const conta = guessBillName(text);
    const pix = detectPixKey(text);
    const boleto = pix ? null : detectBarcode(text);
    const tipo_pagamento = pix ? "pix" : boleto ? "boleto" : "";
    const codigo_pagamento = pix || boleto || "";
    const natureza = intent === "novo_recebimento" ? "conta_receber" : "conta_pagar";

    const rowId = uuidShort();
    await sheet.addRow({ row_id: rowId, timestamp: new Date().toISOString(), user: from, tipo: natureza, conta, valor, vencimento_iso: toISODate(vencimento), vencimento_br: formatBRDate(vencimento), tipo_pagamento, codigo_pagamento, status: "pendente" });

    if (natureza === "conta_pagar") {
      await sendText(from, `🧾 *Conta registrada com sucesso!*\n\n💡 ${conta}\n💰 Valor: ${formatCurrencyBR(valor)}\n📅 Vencimento: ${formatBRDate(vencimento)}`);
      if (tipo_pagamento === "pix") await sendCopyButton(from, "💳 Chave Pix:", codigo_pagamento, "Copiar chave Pix");
      if (tipo_pagamento === "boleto") await sendCopyButton(from, "🧾 Código de barras:", codigo_pagamento, "Copiar código de barras");
      await sendConfirmButton(from, rowId);
    } else {
      await sendText(from, `💸 *Recebimento registrado com sucesso!*\n\n💡 ${conta}\n💰 Valor: ${formatCurrencyBR(valor)}\n📅 Data: ${formatBRDate(vencimento)}`);
    }
    return;
  }
  if (intent === "confirmar_pagamento") {
    const rows = await sheet.getRows();
    const row = rows.find(r => r.get("user") === from && r.get("tipo") === "conta_pagar" && r.get("status") !== "pago");
    if (row) { row.set("status","pago"); await row.save(); await sendText(from,"✅ *Pagamento confirmado com sucesso!*"); }
    else await sendText(from,"✅ Nenhuma conta pendente encontrada.");
    return;
  }
  await sendText(from,"🤔 *Não consegui entender.*\n\nTente algo como:\n• `Pagar luz R$150,00 amanhã`\n• `Receber de João R$200,00 sexta`\n• `Meus pagamentos`");
}

// ============================
// Webhook
// ============================
app.get("/webhook",(req,res)=>{
  const token=process.env.WEBHOOK_VERIFY_TOKEN||"verify_token";
  if(req.query["hub.mode"]==="subscribe"&&req.query["hub.verify_token"]===token)return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
app.post("/webhook",async(req,res)=>{
  try{
    const body=req.body;
    if(body.object&&body.entry){
      for(const entry of body.entry||[]){
        for(const change of entry.changes||[]){
          const msgs=change.value?.messages||[];
          for(const msg of msgs){
            const from=msg.from;
            if(msg.type==="text")await handleUserText(from,msg.text?.body||"");
            if(msg.type==="interactive"){
              const id=msg.interactive?.button_reply?.id;
              if(id?.startsWith("CONFIRMAR:")){
                const rowId=id.split("CONFIRMAR:")[1];
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const row=rows.find(r=>r.get("row_id")===rowId);
                if(row){row.set("status","pago");await row.save();await sendText(from,"✅ *Pagamento confirmado com sucesso!*");}
              }
            }
          }
        }
      }
    }
    res.sendStatus(200);
  }catch(e){console.error("Erro no webhook:",e.message);res.sendStatus(200);}
});

// ============================
// CRON - lembretes
// ============================
cron.schedule("*/30 * * * *",async()=>{
  try{
    await ensureAuth();
    const sheet=await ensureSheet();
    const rows=await sheet.getRows();
    const today=new Date();today.setHours(0,0,0,0);
    const due=rows.filter(r=>r.get("tipo")==="conta_pagar"&&r.get("status")!=="pago"&&r.get("vencimento_iso")&&(new Date(r.get("vencimento_iso"))).setHours(0,0,0,0)===today.getTime());
    for(const r of due){
      const to=r.get("user");
      await sendText(to,`⚠️ *Lembrete de pagamento!*\n\n💡 ${r.get("conta")}\n💰 ${formatCurrencyBR(r.get("valor"))}\n📅 Vence hoje (${formatBRDate(r.get("vencimento_iso"))})`);
      if(r.get("tipo_pagamento")==="pix")await sendCopyButton(to,"💳 Chave Pix:",r.get("codigo_pagamento"),"Copiar chave Pix");
      if(r.get("tipo_pagamento")==="boleto")await sendCopyButton(to,"🧾 Código de barras:",r.get("codigo_pagamento"),"Copiar código de barras");
    }
  }catch(e){console.error("Erro no CRON:",e.message);}
});

// ============================
// Inicialização
// ============================
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`FinPlanner IA rodando na porta ${PORT}`));
