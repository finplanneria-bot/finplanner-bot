// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-19.6)
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
// Diagnóstico mínimo
// ----------------------------
console.log("🔍 FinPlanner env:");
console.log("SHEETS_ID:", process.env.SHEETS_ID ? "✅" : "❌");
console.log("GOOGLE_SERVICE_ACCOUNT_EMAIL:", process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "❌");
console.log("GOOGLE_SERVICE_ACCOUNT_KEY:", process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? "✅" : "❌");
console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "✅" : "❌");
console.log("USE_OPENAI:", process.env.USE_OPENAI);

// ----------------------------
// WhatsApp Cloud API
// ----------------------------
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;

// ----------------------------
// OpenAI (interpretação)
// ----------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_OPENAI = (process.env.USE_OPENAI || "false").toLowerCase() === "true";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ----------------------------
// Google Sheets
// ----------------------------
const SHEETS_ID = process.env.SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}
const doc = new GoogleSpreadsheet(SHEETS_ID);

async function ensureAuth() {
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_KEY || !SHEETS_ID) {
    throw new Error("Variáveis de autenticação ausentes");
  }
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: GOOGLE_SERVICE_ACCOUNT_KEY,
  });
  await doc.loadInfo();
}

async function ensureSheet() {
  await ensureAuth();
  let sheet = doc.sheetsByTitle["finplanner"];
  const headers = [
    "row_id","timestamp","user","tipo","conta","valor",
    "vencimento_iso","vencimento_br","tipo_pagamento","codigo_pagamento","status",
  ];
  if (!sheet) {
    sheet = await doc.addSheet({ title: "finplanner", headerValues: headers });
    console.log("✅ Aba 'finplanner' criada");
    return sheet;
  }
  await sheet.loadHeaderRow();
  const atuais = sheet.headerValues || [];
  const falt = headers.filter(h => !atuais.includes(h));
  if (falt.length) {
    await sheet.setHeaderRow([...atuais, ...falt]);
    console.log("🧩 Cabeçalhos adicionados:", falt.join(", "));
  }
  return sheet;
}

// ----------------------------
// Utils
// ----------------------------
const uuidShort = () => crypto.randomBytes(6).toString("hex");
const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = d => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
const startOfMonth = (y,m) => new Date(y, m, 1, 0,0,0,0);
const endOfMonth   = (y,m) => new Date(y, m+1, 0, 23,59,59,999);

function formatBRDate(d){ return d ? new Date(d).toLocaleDateString("pt-BR") : "—"; }
function toISODate(d){ if(!d) return ""; const x=new Date(d); x.setHours(0,0,0,0); return x.toISOString(); }
function formatCurrencyBR(v, showSign=false){
  const sign = showSign && v < 0 ? "–" : "";
  const abs = Math.abs(Number(v||0));
  return `${sign}R$${abs.toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2})}`;
}

// ✅ Aceita 17 → R$17,00 | 17,50 → R$17,50 | R$ 120,00
// 🚫 Não captura "17" se for parte de "17/10" (data)
function parseCurrencyBR(text){
  if(!text) return null;
  const clean = text.replace(/\s+/g, " ");
  // número (com ou sem R$), não seguido imediatamente por "/"
  const m = clean.match(/\b(?:r\$)?\s*(\d+(?:[.,]\d{2})?)(?!\/)\b/i);
  if(!m) return null;
  let val = m[1].replace(/\./g,"").replace(",",".");
  return parseFloat(val);
}

function detectBarcode(t){const m=(t||"").match(/[0-9\.\s]{30,}/);return m?m[0].trim().replace(/\s+/g," "):null;}
function detectPixKey(t){
  const hasPix=/\bpix\b/i.test(t||"");
  const email=(t||"").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone=(t||"").match(/\+?\d{10,14}/);
  const docid=(t||"").match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);
  return hasPix ? (email?.[0]||phone?.[0]||docid?.[0]) : null;
}

// ✅ Datas: dd/mm[/aaaa], hoje, amanhã, ontem
function parseDueDate(text){
  const now=new Date();
  const dmY=(text||"").match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if(dmY){let[_,d,m,y]=dmY;const Y=y? (y.length===2?2000+parseInt(y):parseInt(y)):now.getFullYear();return new Date(Y,parseInt(m)-1,parseInt(d));}
  if(/\bontem\b/i.test(text||"")){const d=new Date(now);d.setDate(d.getDate()-1);return d;}
  if(/\bhoje\b/i.test(text||"")) return now;
  if(/\bamanh[aã]\b/i.test(text||"")){const d=new Date(now);d.setDate(d.getDate()+1);return d;}
  return null;
}

function guessBillName(t){
  const labels=["energia","luz","água","agua","internet","aluguel","telefone","cartão","cartao","condominio","mercado","iptu","ipva","lanche","gasolina","academia","telegram","beatriz","pix"];
  const lower=(t||"").toLowerCase();
  for(const l of labels) if(lower.includes(l)) return l.charAt(0).toUpperCase()+l.slice(1);
  const who=(t||"").match(/\b(?:pra|para|ao|a|à|de)\s+([\wÁÉÍÓÚÂÊÔÃÕÇ]+)/i);
  return who ? capitalize(who[1]) : (capitalize(lower.split(/\s+/).slice(0,3).join(" ")) || "Lançamento");
}
const capitalize = s => (s||"").replace(/\b\w/g, c => c.toUpperCase());

// Data/report helpers
function brToDate(s){const m=s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(!m)return null;return new Date(parseInt(m[3]),parseInt(m[2])-1,parseInt(m[1]));}
function formatMonthYear(d){const meses=["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"]; const dt=new Date(d); return `${meses[dt.getMonth()]} de ${dt.getFullYear()}`;}
function monthLabel(d=new Date()){const meses=["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"]; return meses[d.getMonth()];}
function withinRange(dt, start, end){ return dt && dt>=start && dt<=end; }
function getEffectiveDate(r){ return r.get("vencimento_iso") ? new Date(r.get("vencimento_iso")) : new Date(r.get("timestamp")); }

// Janela de tempo pedida em "Categorias ..."
function parseInlineWindowForCategories(text){
  const t=(text||"").toLowerCase();

  // 3 meses
  if(/\b3\s*mes(es)?\b/i.test(t)){
    const end = endOfDay(new Date());
    const s = new Date(end);
    s.setMonth(s.getMonth()-2); // atual + 2 anteriores
    const start = startOfMonth(s.getFullYear(), s.getMonth());
    return { start, end };
  }

  // dd/mm/yyyy a dd/mm/yyyy
  const m=t.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:a|até|ate|-)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if(m){
    const from=brToDate(m[1]), to=brToDate(m[2]);
    if(from&&to && (to-from)<=366*24*3600*1000) return { start:startOfDay(from), end:endOfDay(to) };
  }

  // mês atual (padrão)
  const now=new Date();
  return { start:startOfMonth(now.getFullYear(),now.getMonth()), end:endOfMonth(now.getFullYear(),now.getMonth()) };
}

// ----------------------------
// WhatsApp helpers
// ----------------------------
async function sendWA(p){try{await axios.post(WA_API,p,{headers:{Authorization:`Bearer ${WA_TOKEN}`,"Content-Type":"application/json"}});}catch(e){console.error("Erro WA:",e.response?.data||e.message);}}
async function sendText(to,body){return sendWA({messaging_product:"whatsapp",to,type:"text",text:{body}});}
async function sendCopyButton(to,title,code,btnTitle){
  if(!code)return;
  if(btnTitle.length>20)btnTitle=btnTitle.slice(0,20);
  return sendWA({messaging_product:"whatsapp",to,type:"interactive",
    interactive:{type:"button",body:{text:title},action:{buttons:[{type:"copy_code",copy_code:code,title:btnTitle}]}}});
}
async function sendConfirmButton(to,rowId){
  const title="✅ Confirmar";
  return sendWA({messaging_product:"whatsapp",to,type:"interactive",
    interactive:{type:"button",body:{text:"Quando pagar, toque abaixo para confirmar:"},
    action:{buttons:[{type:"reply",reply:{id:`CONFIRMAR:${rowId}`,title:title}}]}}});
}
async function sendStatusChoiceButtons(to,rowId){
  return sendWA({messaging_product:"whatsapp",to,type:"interactive",
    interactive:{type:"button",body:{text:"Esse lançamento já foi pago ou ainda está pendente?"},
    action:{buttons:[
      {type:"reply",reply:{id:`SETSTATUS:${rowId}:pago`,title:"✅ Pago"}},
      {type:"reply",reply:{id:`SETSTATUS:${rowId}:pendente`,title:"🕓 Pendente"}},
    ]}}});
}

// ----------------------------
// Intenções (heurística + IA)
// ----------------------------
async function detectIntent(t){
  const lower=(t||"").toLowerCase();

  // boas-vindas / ajuda
  if(/\b(oi|olá|ola|opa|bom dia|boa tarde|boa noite)\b/.test(lower)) return "boas_vindas";
  if(/\b(funções|funcoes|ajuda|help)\b/.test(lower)) return "funcoes";

  // listagens clássicas
  if(/\b(meus pagamentos|listar pagamentos|mostrar pagamentos)\b/i.test(lower)) return "listar_contas";
  if(/\b(meus recebimentos|meus ganhos|listar recebimentos|mostrar recebimentos|ganhos)\b/i.test(lower)) return "listar_recebimentos";

  // novas listagens/consultas
  if(/\b(meus gastos|lançamentos de hoje)\b/i.test(lower)) return "listar_gastos_ext";
  if(/\b(lançamentos|meus lançamentos|lançamentos geral|registros|todos os lançamentos|extrato)\b/i.test(lower)) return "listar_lancamentos";
  if(/\b(categorias|gastos por categoria|listar categorias|liste gastos por categoria|categorias de gastos|categorias de ganhos)\b/i.test(lower)) return "listar_categorias";

  // relatórios
  if(/\b(relat[óo]rio|resumo)\b/i.test(lower)) return "relatorio";

  // novos movimentos
  if(/\b(pagar|pagamento|vou pagar|irei pagar|quitar|liquidar|pix\s+para|transferir|enviar)\b/i.test(lower)) return "nova_conta";
  if(/\b(receber|entrada|venda|ganhar|ganho|receita|recebi|ganhei|gastei|paguei|efetuei|enviei|fiz pix)\b/i.test(lower)) return "novo_movimento";

  // confirmar
  if(/\bconfirm(ar)? pagamento|paguei|pago|liquidei|baixei|quitei\b/i.test(lower)) return "confirmar_pagamento";

  if(USE_OPENAI&&openai){
    try{
      const r=await openai.responses.create({
        model:"gpt-4.1-mini",
        input:`Classifique: boas_vindas, funcoes, listar_contas, listar_recebimentos, listar_gastos_ext, listar_lancamentos, listar_categorias, relatorio, nova_conta, novo_movimento, confirmar_pagamento, fora_contexto.\nFrase: ${t}`
      });
      const label=(r.output_text||"").trim().toLowerCase();
      if(["boas_vindas","funcoes","listar_contas","listar_recebimentos","listar_gastos_ext","listar_lancamentos","listar_categorias","relatorio","nova_conta","novo_movimento","confirmar_pagamento","fora_contexto"].includes(label))
        return label;
    }catch{}
  }
  return "desconhecido";
}

// ----------------------------
// Extrações + status (verbos)
// ----------------------------
function extractEntities(text, intent){
  const conta=guessBillName(text);
  const valor=parseCurrencyBR(text);
  const vencimento=parseDueDate(text);
  const pix=detectPixKey(text);
  const boleto=pix?null:detectBarcode(text);

  let tipo_pagamento="", codigo_pagamento="";
  if(pix){tipo_pagamento="pix";codigo_pagamento=pix;}
  else if(boleto){tipo_pagamento="boleto";codigo_pagamento=boleto;}

  const lower=(text||"").toLowerCase();

  // Status: apenas pelos verbos (não por "hoje/amanhã")
  let status = null; // null => perguntar
  const isFutureVerb = /\b(pagar|vou pagar|irei pagar|quitar|liquidar|enviar|transferir)\b/i.test(lower);
  const isPaidVerb   = /\b(paguei|efetuei|fiz|recebi|ganhei|gastei|transferi|enviei(?:\s+pix)?|pago)\b/i.test(lower);

  if (isFutureVerb) status = "pendente";
  else if (isPaidVerb) status = "pago";
  else status = null;

  // Natureza:
  let tipo = "conta_pagar";
  if (intent === "nova_conta") {
    tipo = "conta_pagar";
  } else if (intent === "novo_movimento") {
    if (/\b(recebi|ganhei|receber|entrada|venda|receita)\b/i.test(lower)) tipo = "conta_receber";
    if (/\b(gastei|paguei|pix\s+para|transferi|efetuei|fiz)\b/i.test(lower)) tipo = "conta_pagar";
  }

  return { conta, valor, vencimento, tipo_pagamento, codigo_pagamento, status, tipo };
}

// ----------------------------
// Saldo mensal do usuário
// ----------------------------
async function computeUserMonthlyBalance(sheet, user){
  const rows = await sheet.getRows();
  const now = new Date();
  const mStart = startOfMonth(now.getFullYear(), now.getMonth());
  const mEnd   = endOfMonth(now.getFullYear(), now.getMonth());

  const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===user && r.get("status")==="pago");

  // Data efetiva: vencimento_iso ou timestamp
  const inMonth = mine.filter(r => {
    const d = r.get("vencimento_iso") ? new Date(r.get("vencimento_iso")) : new Date(r.get("timestamp"));
    return d >= mStart && d <= mEnd;
  });

  const receitas = inMonth
    .filter(r => r.get("tipo")==="conta_receber")
    .reduce((a,r)=> a + parseFloat(r.get("valor")||"0"), 0);

  const gastos = inMonth
    .filter(r => r.get("tipo")==="conta_pagar")
    .reduce((a,r)=> a + parseFloat(r.get("valor")||"0"), 0);

  return receitas - gastos;
}

// ----------------------------
// Mensagens
// ----------------------------
const MSG = {
  BOAS_VINDAS:
`👋 *Olá! Eu sou a FinPlanner IA.*

💡 *Organizo seus pagamentos, ganhos e gastos de forma simples e automática.*

Você pode me enviar mensagens como:

💰 *Registrar um pagamento*
→ \`Pagar internet R$120,00 amanhã\`
→ \`Paguei academia R$80,00 hoje\`

💸 *Registrar um recebimento*
→ \`Receber venda de óleo R$90,00 sexta\`
→ \`Ganhei R$300,00 com entrega 28/10/2025\`

📋 *Ver movimentações*
→ \`Meus pagamentos\`
→ \`Meus recebimentos\` ou \`Meus ganhos\`
→ \`Lançamentos de hoje\` ou \`Extrato\`

📊 *Relatórios*
→ \`Relatório do mês\`
→ \`Relatório 3 meses\`
→ \`Relatório 01/08/2025 a 30/09/2025\`
→ \`Relatório geral\` (últimos 12 meses)

🔔 *Eu te lembro dos vencimentos e organizo tudo automaticamente pra você.*`,
  AJUDA:
`⚙️ *Funções da FinPlanner IA*

💰 *Registrar pagamentos*
→ \`Pagar energia R$150,00 amanhã\`
→ \`Pix 12,95 lanche\` (já pago)

💸 *Registrar recebimentos*
→ \`Receber venda de óleo R$90,00 25/10/2025\`
→ \`Ganhei R$300,00 hoje\` (já recebido)

📅 *Listar*
→ \`Meus pagamentos\`
→ \`Meus recebimentos\` / \`Meus ganhos\`
→ \`Lançamentos de hoje\` / \`Extrato\`

📊 *Relatórios*
→ \`Relatório do mês\`
→ \`Relatório 3 meses\`
→ \`Relatório 10/2025\`
→ \`Relatório 01/08/2025 a 30/09/2025\`
→ \`Relatório geral\` (12 meses)

✅ *Confirmar pagamentos*
→ \`Paguei aluguel\`

🔔 *Lembretes automáticos no dia do vencimento.*`,
  NAO_ENTENDI:
`🤔 *Não consegui entender sua mensagem.*

Experimente algo assim:

💰 \`Pagar aluguel R$800,00 05/11/2025\`
💸 \`Receber R$300,00 de João amanhã\`
📅 \`Lançamentos de hoje\`
📊 \`Relatório 3 meses\`
⚙️ \`Funções\` (para ver tudo o que posso fazer)`,
  CONTA_OK: (conta, valorFmt, dataFmt, status) =>
`🧾 *Lançamento registrado!*

📘 Descrição: ${conta || "Lançamento"}
💰 Valor: ${valorFmt}
📅 Vencimento/Data: ${dataFmt}
${status==="pago" ? "✅ Status: Pago" : "⏳ Status: Pendente"}`,
  RECEB_OK: (conta, valorFmt, dataFmt, status) =>
`💸 *Recebimento registrado!*

📘 Descrição: ${conta || "Recebimento"}
💰 Valor: ${valorFmt}
📅 Data: ${dataFmt}
${status==="pago" ? "✅ Status: Pago" : "⏳ Status: Pendente"}`,
  CONFIRM_OK: "✅ *Pagamento confirmado!*",
  LISTA_PAG_VAZIA: "✅ Você não tem pagamentos pendentes.",
  LISTA_REC_VAZIA: "✅ Você não tem recebimentos futuros.",
  LEMBRETE: (conta, valorFmt, dataFmt) =>
`⚠️ *Lembrete de pagamento!*

📘 ${conta || "Conta"}
💰 ${valorFmt}
📅 Vence hoje (${dataFmt})`,
  SALDO_MES: (saldo) => `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`,
};

// ----------------------------
// Parser de relatórios
// ----------------------------
function parseReportQuery(tRaw){
  const t = (tRaw||"").toLowerCase();

  // Filtros
  let filter="all";
  if(/\b(gastos|despesas|pagamentos)\b/i.test(t)) filter="gastos";
  if(/\b(ganhos|receitas|entradas|recebimentos)\b/i.test(t)) filter="ganhos";

  // Geral (12 meses)
  if(/\b(geral|completo|todos|tudo)\b/i.test(t)){
    const end = endOfDay(new Date());
    const start = new Date(end);
    start.setFullYear(start.getFullYear()-1);
    return { type:"range", start, end, filter };
  }

  // 3 meses
  if(/\b3\s*mes(es)?\b/i.test(t)){
    const end = endOfDay(new Date());
    const s = new Date(end);
    s.setMonth(s.getMonth()-2); // atual + 2 anteriores
    const start = startOfMonth(s.getFullYear(), s.getMonth());
    return { type:"range", start, end, filter };
  }

  // Período dd/mm/yyyy a dd/mm/yyyy
  const reRange=/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:a|até|ate|-)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i;
  const m=t.match(reRange);
  if(m){
    const from=brToDate(m[1]); const to=brToDate(m[2]);
    if(from && to && (to - from) <= 366*24*3600*1000) return { type:"range", start: startOfDay(from), end: endOfDay(to), filter };
    return null;
  }

  // do mês / mês atual
  if(/\b(do m[eê]s|m[eê]s atual)\b/i.test(t)){
    const now=new Date(); const start=startOfMonth(now.getFullYear(), now.getMonth()); const end=endOfMonth(now.getFullYear(), now.getMonth());
    return { type:"monthly", start, end, filter };
  }

  // mm/yyyy
  const reMonth=/(?:m[eê]s\s*)?(\d{1,2})\/(\d{4})/i;
  const mm=t.match(reMonth);
  if(mm){
    const month=parseInt(mm[1])-1, year=parseInt(mm[2]);
    return { type:"monthly", start: startOfMonth(year,month), end: endOfMonth(year,month), filter };
  }

  // padrão → mês atual
  const now=new Date(); return { type:"monthly", start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()), filter };
}

function buildCategoryTotals(rows){
  const map = {};
  for(const r of rows){
    const nome = r.get("conta") || "Outros";
    const val  = parseFloat(r.get("valor")||"0");
    map[nome] = (map[nome]||0) + val;
  }
  const arr = Object.entries(map).map(([conta, total])=>({conta,total})).sort((a,b)=> b.total - a.total);
  return arr;
}

// ----------------------------
// Fluxo principal
// ----------------------------
function statusIconLabel(status){
  return status==="pago" ? "✅ Pago" : "⏳ Pendente";
}

async function handleUserText(from, text){
  const intent = await detectIntent(text);
  const sheet = await ensureSheet();

  if (intent === "boas_vindas") { await sendText(from, MSG.BOAS_VINDAS); return; }
  if (intent === "funcoes") { await sendText(from, MSG.AJUDA); return; }

  if (intent === "listar_contas") {
    const rows = await sheet.getRows();
    const pend = rows
      .filter(r => typeof r.get==="function" && r.get("user")===from && r.get("tipo")==="conta_pagar" && r.get("status")!=="pago")
      .map(r => ({ conta: r.get("conta"), valor: parseFloat(r.get("valor")||"0"), ven: r.get("vencimento_iso")? new Date(r.get("vencimento_iso")): null, st:r.get("status") }))
      .sort((a,b)=> (a.ven?.getTime()||0)-(b.ven?.getTime()||0))
      .slice(0,20);
    if(!pend.length){ await sendText(from, MSG.LISTA_PAG_VAZIA); return; }
    let msg="📋 *Pagamentos pendentes:*\n\n";
    for(const p of pend){ msg += `• ${formatBRDate(p.ven)} — ${p.conta} (${formatCurrencyBR(p.valor)}) — ${statusIconLabel(p.st)}\n`; }
    await sendText(from, msg.trim()); return;
  }

  if (intent === "listar_recebimentos") {
    const rows = await sheet.getRows();
    const recs = rows
      .filter(r => typeof r.get==="function" && r.get("user")===from && r.get("tipo")==="conta_receber" && r.get("status")!=="pago")
      .map(r => ({ conta: r.get("conta"), valor: parseFloat(r.get("valor")||"0"), ven: r.get("vencimento_iso")? new Date(r.get("vencimento_iso")): null, st:r.get("status") }))
      .sort((a,b)=> (a.ven?.getTime()||0)-(b.ven?.getTime()||0))
      .slice(0,20);
    if(!recs.length){ await sendText(from, MSG.LISTA_REC_VAZIA); return; }
    let msg="📋 *Recebimentos futuros:*\n\n";
    for(const p of recs){ msg += `• ${formatBRDate(p.ven)} — ${p.conta} (${formatCurrencyBR(p.valor)}) — ${statusIconLabel(p.st)}\n`; }
    await sendText(from, msg.trim()); return;
  }

  // "meus gastos" / "extrato" / "lançamentos de hoje"
  if (intent === "listar_gastos_ext") {
    const rows = await sheet.getRows();
    const lower=(text||"").toLowerCase();
    const isHoje = /\bhoje\b/i.test(lower);

    let itens = rows.filter(r => typeof r.get==="function" && r.get("user")===from);

    if (isHoje) {
      const today = startOfDay(new Date()).getTime();
      itens = itens.filter(r => {
        const d = r.get("vencimento_iso") ? startOfDay(new Date(r.get("vencimento_iso"))).getTime()
                                          : startOfDay(new Date(r.get("timestamp"))).getTime();
        return d === today;
      });
      itens.sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b));
      let msg = "📋 *Lançamentos de hoje:*\n\n";
      if (!itens.length) { await sendText(from, "✅ Nenhum lançamento hoje."); return; }
      for (const r of itens) {
        const tip = r.get("tipo")==="conta_pagar" ? "Gasto" : "Receb.";
        msg += `• ${tip} — ${r.get("conta")} (${formatCurrencyBR(parseFloat(r.get("valor")||"0"))}) — ${statusIconLabel(r.get("status"))}\n`;
      }
      await sendText(from, msg.trim()); 
      return;
    }

    // Se não tiver "hoje", encaminhe para extrato recente (igual ao listar_lancamentos)
    itens.sort((a,b)=> getEffectiveDate(b) - getEffectiveDate(a));
    itens = itens.slice(0, 20);
    if (!itens.length) { await sendText(from, "✅ Nenhum lançamento encontrado."); return; }
    let msg = "📋 *Extrato recente:*\n\n";
    for (const r of itens) {
      const tip = r.get("tipo")==="conta_pagar" ? "Gasto" : "Receb.";
      const when = r.get("vencimento_br") || formatBRDate(r.get("timestamp"));
      msg += `• ${when} — ${tip} — ${r.get("conta")} (${formatCurrencyBR(parseFloat(r.get("valor")||"0"))}) — ${statusIconLabel(r.get("status"))}\n`;
    }
    msg += `\n💡 Dica: envie *"Categorias"* para ver totais por categoria.`;
    await sendText(from, msg.trim()); 
    return;
  }

  // Lançamentos (extrato geral do usuário)
  if (intent === "listar_lancamentos") {
    const rows = await sheet.getRows();
    let itens = rows.filter(r => typeof r.get==="function" && r.get("user")===from);

    if (!itens.length) { await sendText(from, "✅ Nenhum lançamento encontrado."); return; }

    // ordenar por data efetiva (vencimento ou timestamp) desc
    itens.sort((a,b)=> getEffectiveDate(b) - getEffectiveDate(a));
    itens = itens.slice(0, 25);

    let msg = "📋 *Seus lançamentos recentes:*\n\n";
    for (const r of itens) {
      const tip = r.get("tipo")==="conta_pagar" ? "Gasto" : "Receb.";
      const when = r.get("vencimento_br") || formatBRDate(r.get("timestamp"));
      const val = formatCurrencyBR(parseFloat(r.get("valor")||"0"));
      msg += `• ${when} — ${tip} — ${r.get("conta")} (${val}) — ${statusIconLabel(r.get("status"))}\n`;
    }
    msg += `\n🔎 Dica: envie *"Categorias"* para ver totais por categoria.`;
    await sendText(from, msg.trim()); 
    return;
  }

  // Categorias (totais por categoria para gastos e ganhos)
  if (intent === "listar_categorias") {
    const { start, end } = parseInlineWindowForCategories(text);
    const rows = await sheet.getRows();
    const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===from);

    const inRange = mine.filter(r => withinRange(getEffectiveDate(r), start, end));

    const gastos = inRange.filter(r => r.get("tipo")==="conta_pagar");
    const ganhos = inRange.filter(r => r.get("tipo")==="conta_receber");

    const totG = buildCategoryTotals(gastos).filter(x => x.total > 0);
    const totR = buildCategoryTotals(ganhos).filter(x => x.total > 0);

    const title = `🏷️ *Categorias (${formatBRDate(start)} a ${formatBRDate(end)})*`;

    if (!totG.length && !totR.length) {
      await sendText(from, `${title}\n\n✅ Nenhum lançamento no período.`);
      return;
    }

    let msg = `${title}\n\n`;
    // Mostrar dois blocos, omitindo categorias zeradas
    if (totG.length) {
      msg += `💰 *Gastos por categoria:*\n`;
      totG.forEach(it => { msg += `• ${it.conta}: ${formatCurrencyBR(it.total)}\n`; });
      msg += `\n`;
    }
    if (totR.length) {
      msg += `💸 *Ganhos por categoria:*\n`;
      totR.forEach(it => { msg += `• ${it.conta}: ${formatCurrencyBR(it.total)}\n`; });
      msg += `\n`;
    }

    msg += `ℹ️ Você pode pedir: *"Categorias 3 meses"* ou *"Categorias 01/08/2025 a 30/09/2025"*.`;
    await sendText(from, msg.trim());
    return;
  }

  if (intent === "relatorio") {
    const pr = parseReportQuery(text);
    if(!pr){ await sendText(from, "⚠️ *Período inválido.* Tente:\n• `Relatório do mês`\n• `Relatório 3 meses`\n• `Relatório 01/08/2025 a 30/09/2025`\n• `Relatório geral`"); return; }

    const rows = await sheet.getRows();
    const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===from);
    const getWhen = r => r.get("vencimento_iso") ? new Date(r.get("vencimento_iso")) : new Date(r.get("timestamp"));
    const inRange = (dt) => dt && (dt >= pr.start && dt <= pr.end);

    let gastos = mine.filter(r => r.get("tipo")==="conta_pagar"   && inRange(getWhen(r)));
    let ganhos = mine.filter(r => r.get("tipo")==="conta_receber" && inRange(getWhen(r)));

    if (pr.filter === "gastos") ganhos = [];
    if (pr.filter === "ganhos") gastos = [];

    const totGastos  = gastos.reduce((a,r)=> a + parseFloat(r.get("valor")||"0"), 0);
    const totGanhos  = ganhos.reduce((a,r)=> a + parseFloat(r.get("valor")||"0"), 0);
    const saldo      = totGanhos - totGastos;

    const title = pr.type==="monthly"
      ? `📊 *Relatório de ${formatMonthYear(pr.start)}*`
      : `📊 *Relatório ${formatBRDate(pr.start)} a ${formatBRDate(pr.end)}*`;

    let msg = `${title}\n\n`;
    if (pr.filter === "ganhos") {
      msg += `💸 Ganhos: ${formatCurrencyBR(totGanhos)}\n\n`;
    } else if (pr.filter === "gastos") {
      msg += `💰 Gastos: ${formatCurrencyBR(totGastos)}\n\n`;
    } else {
      msg += `💸 Receitas: ${formatCurrencyBR(totGanhos)}\n`;
      msg += `💰 Gastos: ${formatCurrencyBR(totGastos)}\n`;
      msg += `🧮 Saldo: ${formatCurrencyBR(saldo, true)}\n\n`;
    }

    // Totais por categoria (mostrar ambos blocos, omitindo zerados)
    const catGastos = buildCategoryTotals(gastos).filter(x => x.total > 0);
    const catGanhos = buildCategoryTotals(ganhos).filter(x => x.total > 0);

    if (catGastos.length && pr.filter !== "ganhos") {
      msg += `🏷️ *Gastos por categoria:*\n`;
      catGastos.forEach(it => { msg += `• ${it.conta}: ${formatCurrencyBR(it.total)}\n`; });
      msg += `\n`;
    }
    if (catGanhos.length && pr.filter !== "gastos") {
      msg += `🏷️ *Ganhos por categoria:*\n`;
      catGanhos.forEach(it => { msg += `• ${it.conta}: ${formatCurrencyBR(it.total)}\n`; });
      msg += `\n`;
    }

    // Top 3
    const top = (arr) => arr
      .map(r => ({ conta: r.get("conta"), valor: parseFloat(r.get("valor")||"0") }))
      .sort((a,b)=> b.valor-a.valor)
      .slice(0,3);

    if (gastos.length && pr.filter !== "ganhos") {
      const topG = top(gastos);
      if (topG.length) {
        msg += `🏆 *Maiores gastos:*\n`;
        topG.forEach(it => msg += `• ${it.conta} (${formatCurrencyBR(it.valor)})\n`);
        msg += `\n`;
      }
    }
    if (ganhos.length && pr.filter !== "gastos") {
      const topR = top(ganhos);
      if (topR.length) {
        msg += `🏆 *Maiores ganhos:*\n`;
        topR.forEach(it => msg += `• ${it.conta} (${formatCurrencyBR(it.valor)})\n`);
        msg += `\n`;
      }
    }

    await sendText(from, msg.trim());
    return;
  }

  if (intent === "nova_conta" || intent === "novo_movimento") {
    const { conta, valor, vencimento, tipo_pagamento, codigo_pagamento, status, tipo } = extractEntities(text, intent);
    const rowId = uuidShort();

    // se status for nulo (ambíguo), salva pendente e pergunta
    const finalStatus = status ?? "pendente";

    await sheet.addRow({
      row_id: rowId,
      timestamp: new Date().toISOString(),
      user: from,
      tipo,
      conta,
      valor,
      vencimento_iso: toISODate(vencimento),
      vencimento_br: formatBRDate(vencimento),
      tipo_pagamento,
      codigo_pagamento,
      status: finalStatus,
    });

    const valorFmt = formatCurrencyBR(valor);
    const dataFmt  = formatBRDate(vencimento);

    if (tipo === "conta_pagar") {
      await sendText(from, MSG.CONTA_OK(conta, valorFmt, dataFmt, finalStatus));
      if (tipo_pagamento === "pix")    await sendCopyButton(from, "💳 Chave Pix:", codigo_pagamento, "Copiar Pix");
      if (tipo_pagamento === "boleto") await sendCopyButton(from, "🧾 Código de barras:", codigo_pagamento, "Copiar boleto");
      if (finalStatus !== "pago") await sendConfirmButton(from, rowId);
    } else {
      await sendText(from, MSG.RECEB_OK(conta, valorFmt, dataFmt, finalStatus));
    }

    // Perguntar status se ambíguo
    if (status === null) {
      await sendStatusChoiceButtons(from, rowId);
    }

    // Mostrar saldo do mês apenas se pago
    if (finalStatus === "pago") {
      const saldo = await computeUserMonthlyBalance(sheet, from);
      await sendText(from, MSG.SALDO_MES(saldo));
    }

    return;
  }

  if (intent === "confirmar_pagamento") {
    const rows = await sheet.getRows();
    const row = rows.find(r => typeof r.get==="function" && r.get("user")===from && r.get("tipo")==="conta_pagar" && r.get("status")!=="pago");
    if (row) {
      row.set("status","pago");
      await row.save();
      await sendText(from, MSG.CONFIRM_OK);
      const saldo = await computeUserMonthlyBalance(sheet, from);
      await sendText(from, MSG.SALDO_MES(saldo));
    } else {
      await sendText(from, "✅ Nenhum pagamento pendente encontrado.");
    }
    return;
  }

  if (intent === "fora_contexto") {
    await sendText(from, "💬 *Sou sua assistente financeira e posso te ajudar a organizar pagamentos e recebimentos.*");
    return;
  }

  await sendText(from, MSG.NAO_ENTENDI);
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
    if(body.object&&body.entry){
      for(const e of body.entry){
        for(const c of e.changes||[]){
          for(const m of c.value?.messages||[]){
            const from=m.from;
            if(m.type==="text") await handleUserText(from, m.text?.body || "");
            if(m.type==="interactive"){
              const id=m.interactive?.button_reply?.id;

              // Botão confirmar pagamento
              if(id?.startsWith("CONFIRMAR:")){
                const rowId=id.split("CONFIRMAR:")[1];
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const row=rows.find(r=>typeof r.get==="function"&&r.get("row_id")===rowId);
                if(row){
                  row.set("status","pago");
                  await row.save();
                  await sendText(from, "✅ *Pagamento confirmado!*");
                  const saldo = await computeUserMonthlyBalance(sheet, from);
                  await sendText(from, MSG.SALDO_MES(saldo));
                }
              }

              // Botões de escolha de status
              if(id?.startsWith("SETSTATUS:")){
                const [, rowId, chosen] = id.split(":"); // SETSTATUS:rowId:pago|pendente
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const row=rows.find(r=>typeof r.get==="function"&&r.get("row_id")===rowId);
                if(row){
                  row.set("status", chosen === "pago" ? "pago" : "pendente");
                  await row.save();

                  if (chosen === "pago") {
                    await sendText(from, "✅ *Marcado como pago!*");
                    const saldo = await computeUserMonthlyBalance(sheet, from);
                    await sendText(from, MSG.SALDO_MES(saldo));
                  } else {
                    await sendText(from, "⏳ *Mantido como pendente.*");
                  }
                }
              }
            }
          }
        }
      }
    }
    res.sendStatus(200);
  }catch(e){ console.error("Erro no webhook:", e.message); res.sendStatus(200); }
});

// ----------------------------
// CRON - lembretes (a cada 30 min)
// ----------------------------
cron.schedule("*/30 * * * *", async()=>{
  try{
    const sheet=await ensureSheet();
    const rows=await sheet.getRows();
    const today = startOfDay(new Date());
    const due = rows.filter(r =>
      typeof r.get==="function" &&
      r.get("tipo")==="conta_pagar" &&
      r.get("status")!=="pago" &&
      r.get("vencimento_iso") &&
      startOfDay(new Date(r.get("vencimento_iso"))).getTime()===today.getTime()
    );
    for(const r of due){
      const to=r.get("user");
      await sendText(to, MSG.LEMBRETE(r.get("conta"), formatCurrencyBR(parseFloat(r.get("valor")||"0")), formatBRDate(r.get("vencimento_iso"))));
      if(r.get("tipo_pagamento")==="pix")    await sendCopyButton(to,"💳 Chave Pix:",r.get("codigo_pagamento"),"Copiar Pix");
      if(r.get("tipo_pagamento")==="boleto") await sendCopyButton(to,"🧾 Código de barras:",r.get("codigo_pagamento"),"Copiar boleto");
    }
  }catch(e){ console.error("Erro no CRON:", e.message); }
});

// ----------------------------
// Inicialização
// ----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`FinPlanner IA rodando na porta ${PORT}`));
