// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-18.5)
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

// ----------------------------
// Logs de variáveis
// ----------------------------
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
// Config - OpenAI
// ----------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_OPENAI = (process.env.USE_OPENAI || "false").toLowerCase() === "true";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ----------------------------
// Config - Google Sheets
// ----------------------------
const SHEETS_ID = process.env.SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n"))
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");

const doc = new GoogleSpreadsheet(SHEETS_ID);

async function ensureAuth() {
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_KEY || !SHEETS_ID)
    throw new Error("❌ Variáveis de autenticação ausentes");
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

async function ensureSheet() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["finplanner"];
  const headers = [
    "row_id","timestamp","user","tipo","conta","valor",
    "vencimento_iso","vencimento_br","tipo_pagamento",
    "codigo_pagamento","status",
  ];

  if (!sheet) {
    sheet = await doc.addSheet({ title: "finplanner", headerValues: headers });
    console.log("✅ Aba 'finplanner' criada!");
    return sheet;
  }

  await sheet.loadHeaderRow();
  const atuais = sheet.headerValues || [];
  const faltantes = headers.filter(h => !atuais.includes(h));
  if (faltantes.length) {
    await sheet.setHeaderRow([...atuais, ...faltantes]);
    console.log("🧩 Cabeçalhos atualizados:", faltantes.join(", "));
  }
  return sheet;
}

// ----------------------------
// Utilitários
// ----------------------------
const uuidShort = () => crypto.randomBytes(6).toString("hex");
const formatBRDate = d => d ? new Date(d).toLocaleDateString("pt-BR") : "—";
const toISODate = d => { if(!d) return ""; const n=new Date(d); n.setHours(0,0,0,0); return n.toISOString(); };
const formatCurrencyBR = v => Number(v||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
function parseCurrencyBR(text){
  const m=(text||"").match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/i);
  if(!m)return null;
  const inteiro=m[1].replace(/\./g,"");
  const centavos=m[2]||"00";
  return parseFloat(`${inteiro}.${centavos}`);
}
function detectBarcode(t){const m=(t||"").match(/[0-9\.\s]{30,}/);return m?m[0].trim().replace(/\s+/g," "):null;}
function detectPixKey(t){
  const hasPix=/\bpix\b/i.test(t||"");
  const email=(t||"").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone=(t||"").match(/\+?\d{10,14}/);
  const chave=(t||"").match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);
  return hasPix?(email?.[0]||phone?.[0]||chave?.[0]):null;
}
function parseDueDate(t){
  const now=new Date();
  const dmY=(t||"").match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if(dmY){let[_,d,m,y]=dmY;const year=y? (y.length===2?2000+parseInt(y):parseInt(y)):now.getFullYear();
    return new Date(year,parseInt(m)-1,parseInt(d));}
  if(/\bamanh[aã]\b/i.test(t||"")){const d=new Date(now);d.setDate(d.getDate()+1);return d;}
  if(/\bhoje\b/i.test(t||""))return now;
  return null;
}
function guessBillName(t){
  const labels=["energia","luz","água","agua","internet","aluguel","telefone","cartão","cartao"];
  const lower=(t||"").toLowerCase();
  for(const l of labels)if(lower.includes(l))return l.charAt(0).toUpperCase()+l.slice(1);
  const who=(t||"").match(/\b(?:pra|para|ao|a|à|de)\s+([\wÁÉÍÓÚÂÊÔÃÕÇ]+)/i);
  return who?who[1]:(lower.split(/\s+/).slice(0,3).join(" ")||"Conta");
}

// ----------------------------
// WhatsApp - envio
// ----------------------------
async function sendWA(p){try{await axios.post(WA_API,p,{headers:{Authorization:`Bearer ${WA_TOKEN}`,"Content-Type":"application/json"}});}catch(e){console.error("Erro ao enviar mensagem WA:",e.response?.data||e.message);}}
async function sendText(to,body){return sendWA({messaging_product:"whatsapp",to,type:"text",text:{body}});}
async function sendCopyButton(to,title,code,btnTitle){
  if(!code)return;
  if(btnTitle.length>20)btnTitle=btnTitle.slice(0,20);
  return sendWA({messaging_product:"whatsapp",to,type:"interactive",
    interactive:{type:"button",body:{text:title},
    action:{buttons:[{type:"copy_code",copy_code:code,title:btnTitle}]}}});
}
async function sendConfirmButton(to,rowId){
  return sendWA({messaging_product:"whatsapp",to,type:"interactive",
    interactive:{type:"button",body:{text:"Quando pagar, toque abaixo para confirmar:"},
    action:{buttons:[{type:"reply",reply:{id:`CONFIRMAR:${rowId}`,title:"✅ Confirmar"}}]}}});
}

// ----------------------------
// IA - intenção
// ----------------------------
async function detectIntent(t){
  const lower=(t||"").toLowerCase();
  if(/\b(oi|olá|ola|opa|bom dia|boa tarde|boa noite)\b/.test(lower))return"boas_vindas";
  if(/\b(meus pagamentos|listar|mostrar)\b/.test(lower))return"listar_contas";
  if(/\b(pagar|pagamento|transferir|enviar|quitar)\b/.test(lower))return"nova_conta";
  if(/\b(receber|entrada|venda|ganhar)\b/.test(lower))return"novo_recebimento";
  if(/\bconfirm(ar)? pagamento|paguei|pago\b/.test(lower))return"confirmar_pagamento";
  if(USE_OPENAI&&openai){
    try{
      const r=await openai.responses.create({
        model:"gpt-4.1-mini",
        input:`Classifique: nova_conta, novo_recebimento, listar_contas, confirmar_pagamento, boas_vindas, fora_contexto.\nMensagem: ${t}`
      });
      const label=(r.output_text||"").trim().toLowerCase();
      return["nova_conta","novo_recebimento","listar_contas","confirmar_pagamento","boas_vindas","fora_contexto"].includes(label)?label:"desconhecido";
    }catch{return"desconhecido";}
  }
  return"desconhecido";
}

// ----------------------------
// Mensagens padrão
// ----------------------------
async function handleUserText(from,text){
  const intent=await detectIntent(text);
  const sheet=await ensureSheet();

  if(intent==="boas_vindas"){
    await sendText(from,"👋 *Olá! Eu sou a FinPlanner IA.*\n\n💡 *Sou sua assistente financeira e posso te ajudar a organizar pagamentos e recebimentos de forma simples e automática.*\n\nEnvie mensagens como:\n• `Pagar energia R$150,00 amanhã`\n• `Receber de João R$200,00 sexta`\n• `Meus pagamentos`\n\n🔔 Eu aviso você no dia do vencimento e registro tudo automaticamente na sua planilha.");
    return;
  }
  if(intent==="fora_contexto"){
    await sendText(from,"💬 *Sou sua assistente financeira e posso te ajudar a organizar pagamentos e recebimentos.*");
    return;
  }
  if(intent==="listar_contas"){
    const rows=await sheet.getRows();
    const pendentes=rows.filter(r=>typeof r.get==="function"&&r.get("tipo")==="conta_pagar"&&r.get("user")===from&&r.get("status")!=="pago");
    if(!pendentes.length){await sendText(from,"✅ Você não tem contas pendentes.");return;}
    let msg="📋 *Suas contas pendentes:*\n\n";
    pendentes.forEach(p=>{msg+=`• ${formatBRDate(p.get("vencimento_iso"))} — ${p.get("conta")} (${formatCurrencyBR(p.get("valor"))})\n`;});
    await sendText(from,msg.trim());return;
  }
  if(intent==="nova_conta"||intent==="novo_recebimento"){
    const valor=parseCurrencyBR(text);
    const venc=parseDueDate(text);
    const conta=guessBillName(text);
    const pix=detectPixKey(text);
    const bol=pix?null:detectBarcode(text);
    const tipo=pix?"pix":bol?"boleto":"";
    const codigo=pix||bol||"";
    const tipoConta=intent==="novo_recebimento"?"conta_receber":"conta_pagar";
    const rowId=uuidShort();
    await sheet.addRow({row_id:rowId,timestamp:new Date().toISOString(),user:from,tipo:tipoConta,conta,valor,vencimento_iso:toISODate(venc),vencimento_br:formatBRDate(venc),tipo_pagamento:tipo,codigo_pagamento:codigo,status:"pendente"});
    if(tipoConta==="conta_pagar"){
      await sendText(from,`🧾 *Conta registrada!*\n\n💡 ${conta}\n💰 Valor: ${formatCurrencyBR(valor)}\n📅 Vencimento: ${formatBRDate(venc)}`);
      if(tipo==="pix")await sendCopyButton(from,"💳 Chave Pix:",codigo,"Copiar Pix");
      if(tipo==="boleto")await sendCopyButton(from,"🧾 Código de barras:",codigo,"Copiar boleto");
      await sendConfirmButton(from,rowId);
    }else{
      await sendText(from,`💸 *Recebimento registrado!*\n\n💡 ${conta}\n💰 Valor: ${formatCurrencyBR(valor)}\n📅 Data: ${formatBRDate(venc)}`);
    }
    return;
  }
  if(intent==="confirmar_pagamento"){
    const rows=await sheet.getRows();
    const row=rows.find(r=>typeof r.get==="function"&&r.get("user")===from&&r.get("tipo")==="conta_pagar"&&r.get("status")!=="pago");
    if(row){row.set("status","pago");await row.save();await sendText(from,"✅ *Pagamento confirmado!*");}
    else await sendText(from,"✅ Nenhuma conta pendente encontrada.");
    return;
  }
  await sendText(from,"🤔 *Não consegui entender.*\nTente algo como:\n• `Pagar luz R$150,00 amanhã`\n• `Receber de João R$200,00 sexta`\n• `Meus pagamentos`");
}

// ----------------------------
// Webhook
// ----------------------------
app.get("/webhook",(req,res)=>{
  const token=process.env.WEBHOOK_VERIFY_TOKEN||"verify_token";
  if(req.query["hub.mode"]==="subscribe"&&req.query["hub.verify_token"]===token)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

app.post("/webhook",async(req,res)=>{
  try{
    const body=req.body;
    if(body.object&&body.entry)
      for(const e of body.entry)
        for(const c of e.changes||[])
          for(const m of c.value?.messages||[]){
            const from=m.from;
            if(m.type==="text")await handleUserText(from,m.text?.body||"");
            if(m.type==="interactive"){
              const id=m.interactive?.button_reply?.id;
              if(id?.startsWith("CONFIRMAR:")){
                const rowId=id.split("CONFIRMAR:")[1];
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const row=rows.find(r=>typeof r.get==="function"&&r.get("row_id")===rowId);
                if(row){row.set("status","pago");await row.save();await sendText(from,"✅ *Pagamento confirmado!*");}
              }
            }
          }
    res.sendStatus(200);
  }catch(e){console.error("Erro no webhook:",e.message);res.sendStatus(200);}
});

// ----------------------------
// CRON - lembretes
// ----------------------------
cron.schedule("*/30 * * * *",async()=>{
  try{
    const sheet=await ensureSheet();
    const rows=await sheet.getRows();
    const today=new Date();today.setHours(0,0,0,0);
    const due=rows.filter(r=>typeof r.get==="function"&&r.get("tipo")==="conta_pagar"&&r.get("status")!=="pago"&&r.get("vencimento_iso")&&new Date(r.get("vencimento_iso")).setHours(0,0,0,0)===today.getTime());
    for(const r of due){
      const to=r.get("user");
      await sendText(to,`⚠️ *Lembrete de pagamento!*\n\n💡 ${r.get("conta")}\n💰 ${formatCurrencyBR(r.get("valor"))}\n📅 Vence hoje (${formatBRDate(r.get("vencimento_iso"))})`);
      if(r.get("tipo_pagamento")==="pix")await sendCopyButton(to,"💳 Chave Pix:",r.get("codigo_pagamento"),"Copiar Pix");
      if(r.get("tipo_pagamento")==="boleto")await sendCopyButton(to,"🧾 Código de barras:",r.get("codigo_pagamento"),"Copiar boleto");
    }
  }catch(e){console.error("Erro no CRON:",e.message);}
});

// ----------------------------
// Inicialização
// ----------------------------
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`FinPlanner IA rodando na porta ${PORT}`));
