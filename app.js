// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-20.3-fix)
// ============================
// Correção: regex compatíveis com Node v25 (sem barras duplas escapadas)

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import OpenAI from "openai";
import cron from "node-cron";
import crypto from "crypto";

dotenv.config();

console.log("✅ FinPlanner versão 2025-10-20.3-fix iniciando...");

// Configs principais
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;

const SHEETS_ID = process.env.SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");

const doc = new GoogleSpreadsheet(SHEETS_ID);
async function ensureAuth() {
  await doc.useServiceAccountAuth({ client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: GOOGLE_SERVICE_ACCOUNT_KEY });
  await doc.loadInfo();
}
async function ensureSheet() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["finplanner"];
  if (!sheet) sheet = await doc.addSheet({ title: "finplanner", headerValues: ["row_id","timestamp","user","tipo","conta","valor","vencimento_iso","vencimento_br","tipo_pagamento","codigo_pagamento","status"] });
  return sheet;
}

function formatBRDate(d){return d?new Date(d).toLocaleDateString("pt-BR"):"";}
function toISODate(d){if(!d)return"";const x=new Date(d);x.setHours(0,0,0,0);return x.toISOString();}
function formatCurrencyBR(v,showSign=false){const s=showSign&&v<0?"–":"";const a=Math.abs(Number(v||0));return `${s}R$${a.toLocaleString("pt-BR",{minimumFractionDigits:2})}`;}
function parseCurrencyBR(t){if(!t)return null;const m=t.match(/\b(?:r\$)?\s*(\d+(?:[.,]\d{2})?)(?!\/)\b/i);if(!m)return null;return parseFloat(m[1].replace(".","").replace(",",".")||0);}
function parseDueDate(text){
  const now=new Date();
  const dmY=(text||"").match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if(dmY){let[_,d,m,y]=dmY;const Y=y?(y.length===2?2000+parseInt(y):parseInt(y)):now.getFullYear();return new Date(Y,parseInt(m)-1,parseInt(d));}
  if(/\bhoje\b/i.test(text))return now;
  if(/\bontem\b/i.test(text)){const d=new Date(now);d.setDate(d.getDate()-1);return d;}
  if(/\bamanh[aã]\b/i.test(text)){const d=new Date(now);d.setDate(d.getDate()+1);return d;}
  return null;
}

async function sendText(to,text){await axios.post(WA_API,{messaging_product:"whatsapp",to,type:"text",text:{body:text}},{headers:{Authorization:`Bearer ${WA_TOKEN}`,"Content-Type":"application/json"}}).catch(e=>console.log("WA:",e.response?.data||e.message));}

async function handleUserText(from,text){
  if(/oi|olá|ola|bom dia|boa tarde|boa noite/i.test(text)){await sendText(from,"👋 Olá! Eu sou a FinPlanner IA.\n\nEnvie algo como:\n💰 Pagar energia R$150 amanhã\n💸 Receber R$200 sexta");return;}
  const sheet=await ensureSheet();
  const valor=parseCurrencyBR(text);
  const venc=parseDueDate(text);
  const tipo=/receb|ganh/i.test(text)?"conta_receber":"conta_pagar";
  const status=/paguei|efetuei|fiz|recebi|ganhei/i.test(text)?"pago":"pendente";
  const conta=text.split(" ")[0];
  await sheet.addRow({row_id:crypto.randomBytes(6).toString("hex"),timestamp:new Date().toISOString(),user:from,tipo,conta,valor,vencimento_iso:toISODate(venc),vencimento_br:formatBRDate(venc),status});
  await sendText(from,`🧾 Lançamento registrado!\n\n📘 ${conta}\n💰 ${formatCurrencyBR(valor)}\n📅 ${formatBRDate(venc)}\n${status==="pago"?"✅ Pago":"⏳ Pendente"}`);
}

import express from "express";
const app=express();
app.use(bodyParser.json());
app.post("/webhook",async(req,res)=>{
  try{
    const b=req.body;
    if(b.entry)for(const e of b.entry)for(const c of e.changes||[])for(const m of c.value?.messages||[]){
      const from=m.from;
      if(m.type==="text")await handleUserText(from,m.text.body);
    }
    res.sendStatus(200);
  }catch(e){console.log("Erro webhook:",e.message);res.sendStatus(200);}
});
app.get("/webhook",(req,res)=>{const t=process.env.WEBHOOK_VERIFY_TOKEN||"verify";if(req.query["hub.verify_token"]===t)return res.status(200).send(req.query["hub.challenge"]);res.sendStatus(403);});
app.listen(process.env.PORT||3000,()=>console.log("FinPlanner IA rodando"));
