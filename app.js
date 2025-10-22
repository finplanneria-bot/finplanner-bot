// ============================
// FinPlanner IA - WhatsApp Bot
// Versão: app.js (2025-10-23 • Menus+Relatórios+Saldo+Edição+Exclusão • Auth FIX • CRON 08:00)
// ============================

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import cron from "node-cron";

dotenv.config();

// ============================
// ENV
// ============================
const {
  SHEETS_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_KEY: RAW_KEY = "",
  WA_TOKEN,
  WA_PHONE_NUMBER_ID,
  PORT,
  USE_OPENAI: USE_OPENAI_RAW,
  DEBUG_SHEETS: DEBUG_SHEETS_RAW,
  ADMIN_WA_NUMBER,
  WEBHOOK_VERIFY_TOKEN
} = process.env;

const USE_OPENAI = (USE_OPENAI_RAW || "false").toLowerCase() === "true";
const DEBUG_SHEETS = (DEBUG_SHEETS_RAW || "false").toLowerCase() === "true";

// Aceita chave Google com \n literais OU quebras reais
let GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY && GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n").replace(/\n/g, "\n");
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\n/g, "\n");
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.split("\n").join("\n");
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\n/g, "\n").replace(/\\n/g, "\n");
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\n/g, "\n");
  // Finalmente troca por quebras reais
  GOOGLE_SERVICE_ACCOUNT_KEY = (RAW_KEY || "").replace(/\n/g, "\n").split("\n").join("\n");
  GOOGLE_SERVICE_ACCOUNT_KEY = (RAW_KEY || "").replace(/\n/g, "\n");
  GOOGLE_SERVICE_ACCOUNT_KEY = (RAW_KEY || "").replace(/\n/g, "\n").replace(/\n/g, "\n");
  GOOGLE_SERVICE_ACCOUNT_KEY = (RAW_KEY || "").replace(/\n/g, "\n");
}
if (RAW_KEY && RAW_KEY.includes("\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY.replace(/\n/g, "\n").split("\n").join("\n").replace(/\n/g, "\n");
  GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY.replace(/\n/g, "\n");
}

// ============================
// APP
// ============================
const app = express();
app.use(bodyParser.json());

// ============================
// Utils
// ============================
const normalizeUser = (num) => (num || "").replace(/\D/g, "");
const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = d => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
const startOfMonth = (y,m) => new Date(y, m, 1, 0,0,0,0);
const endOfMonth   = (y,m) => new Date(y, m+1, 0, 23,59,59,999);
const SEP = "────────────────";

function formatBRDate(d){ return d ? new Date(d).toLocaleDateString("pt-BR") : ""; }
function formatCurrencyBR(v){
  const num = Number(v || 0);
  return `R$${Math.abs(num).toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2})}`;
}
function statusIconLabel(status){ return status==="pago" || status==="recebido" ? "✅ Pago" : "⏳ Pendente"; }
function numberToKeycapEmojis(n){
  const map = { "0":"0️⃣","1":"1️⃣","2":"2️⃣","3":"3️⃣","4":"4️⃣","5":"5️⃣","6":"6️⃣","7":"7️⃣","8":"8️⃣","9":"9️⃣" };
  return String(n).split("").map(d => map[d] || d).join("");
}
function withinRange(dt, start, end){ return dt && dt>=start && dt<=end; }

// ============================
// WhatsApp helpers
// ============================
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;

async function sendWA(p){
  try{
    await axios.post(WA_API, p, { headers:{ Authorization:`Bearer ${WA_TOKEN}`, "Content-Type":"application/json" } });
  }catch(e){
    console.error("Erro WA:", e.response?.data || e.message);
  }
}
async function sendText(to, body){
  return sendWA({ messaging_product:"whatsapp", to, type:"text", text:{ body } });
}
async function sendCopyButton(to, title, code, btnTitle){
  if(!code) return;
  if(btnTitle.length>20) btnTitle = btnTitle.slice(0,20);
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"button",
      body:{ text:title },
      action:{ buttons:[{ type:"copy_code", copy_code:code, title:btnTitle }] }
    }
  });
}

// ============================
// Google Sheets (AUTH Render FIX)
// ============================
let doc; // será instanciado já com auth
async function ensureAuth(){
  const serviceAccountAuth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (RAW_KEY || "").replace(/\n/g, "
"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  doc = new GoogleSpreadsheet(SHEETS_ID, serviceAccountAuth);
  await doc.loadInfo();
}

async function ensureSheet(){
  await ensureAuth();
  let sheet = doc.sheetsByTitle["finplanner"];
  const headers = [
    "row_id","timestamp","user","user_raw","tipo","conta","valor",
    "vencimento_iso","vencimento_br","tipo_pagamento","codigo_pagamento",
    "status","fixa","fix_parent_id","vencimento_dia",
    "categoria","categoria_emoji","descricao"
  ];
  if (!sheet){
    sheet = await doc.addSheet({ title:"finplanner", headerValues: headers });
  }else{
    await sheet.loadHeaderRow();
    const current = sheet.headerValues || [];
    const missing = headers.filter(h => !current.includes(h));
    if (missing.length){
      await sheet.setHeaderRow([...current, ...missing]);
    }
  }
  return sheet;
}
function getVal(row, key){
  if (!row) return undefined;
  if (typeof row.get === "function") return row.get(key);
  if (key in row) return row[key];
  if (row._rawData && row._sheet?.headerValues){
    const idx = row._sheet.headerValues.indexOf(key);
    if (idx >= 0) return row._rawData[idx];
  }
  return undefined;
}
function setVal(row, key, value){
  if(!row) return;
  if(typeof row.set === "function") row.set(key, value);
  else row[key] = value;
}
function saveRow(row){ return (typeof row.save === "function") ? row.save() : Promise.resolve(); }
function getEffectiveDate(row){
  const iso = getVal(row, "vencimento_iso");
  const ts  = getVal(row, "timestamp");
  return iso ? new Date(iso) : (ts ? new Date(ts) : null);
}

// ============================
// Categoria automática
// ============================
function detectCategory(descRaw, tipo){
  const text = (descRaw||"").toLowerCase();
  const rules = [
    { slug:"utilidades", emoji:"🔌", kws:["luz","energia","elétrica","eletrica","água","agua","esgoto","gás","gas"] },
    { slug:"internet_telefonia", emoji:"🌐", kws:["internet","fibra","vivo","claro","tim","oi"] },
    { slug:"moradia", emoji:"🏠", kws:["aluguel","condomínio","condominio","iptu","aluguel"] },
    { slug:"mercado", emoji:"🛒", kws:["mercado","supermercado","ifood","padaria","almoço","jantar","restaurante"] },
    { slug:"transporte", emoji:"🚗", kws:["uber","99","gasolina","combustível","combustivel","passagem","ônibus","onibus"] },
    { slug:"saude", emoji:"💊", kws:["academia","plano","consulta","dentista","farmácia","farmacia"] },
    { slug:"educacao", emoji:"🎓", kws:["curso","faculdade","escola","mensalidade"] },
    { slug:"lazer", emoji:"🎭", kws:["netflix","spotify","cinema","show","lazer","entretenimento"] },
    { slug:"impostos_taxas", emoji:"🧾", kws:["multa","taxa","imposto","receita"] },
    { slug:"salario_trabalho", emoji:"💼", kws:["salário","salario","pagamento","freela","freelance","contrato"] },
    { slug:"vendas_receitas", emoji:"💵", kws:["venda","recebimento","pix recebido","cliente","boleto recebido"] },
  ];
  for(const r of rules){
    if (r.kws.some(k => text.includes(k))) return r;
  }
  if (tipo === "conta_receber") return { slug:"vendas_receitas", emoji:"💵" };
  if (tipo === "conta_pagar")   return { slug:"outros", emoji:"🧩" };
  return { slug:"outros", emoji:"🧩" };
}

// ============================
// Sessões
// ============================
const sessionPeriod = new Map();
const sessionEdit   = new Map();
const sessionDelete = new Map();

// ============================
// Menus interativos
// ============================
async function sendWelcomeList(to){
  const body =
`👋 Olá! Eu sou a FinPlanner IA.

💡 Organizo seus pagamentos, ganhos e gastos de forma simples e automática.

Toque em *Abrir menu* ou digite o que deseja fazer.`;

  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"list",
      header:{ type:"text", text:"Abrir menu" },
      body:{ text: body },
      action:{
        button:"Abrir menu",
        sections:[
          {
            title:"Lançamentos e Contas",
            rows:[
              { id:"MENU:registrar_pagamento",   title:"💰 Registrar pagamento",    description:"Adicionar um novo gasto." },
              { id:"MENU:registrar_recebimento", title:"💵 Registrar recebimento",  description:"Adicionar uma entrada de dinheiro." },
              { id:"MENU:contas_pagar",          title:"📅 Contas a pagar",         description:"Ver e confirmar pagamentos pendentes." },
              { id:"MENU:contas_fixas",          title:"♻️ Contas fixas",          description:"Cadastrar ou excluir contas recorrentes." },
            ]
          },
          {
            title:"Relatórios e Histórico",
            rows:[
              { id:"MENU:relatorios",  title:"📊 Relatórios",        description:"Gerar por categoria e período." },
              { id:"MENU:lancamentos", title:"🧾 Meus lançamentos",  description:"Ver por mês ou data personalizada." },
            ]
          },
          {
            title:"Ajustes e Ajuda",
            rows:[
              { id:"MENU:editar",  title:"✏️ Editar lançamentos", description:"Alterar registros por número." },
              { id:"MENU:excluir", title:"🗑️ Excluir lançamento", description:"Excluir último ou escolher por número." },
              { id:"MENU:ajuda",   title:"⚙️ Ajuda e exemplos",   description:"Como usar a FinPlanner IA." },
            ]
          }
        ]
      }
    }
  });
}

async function sendRelatoriosButtons(to){
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"📊 Qual relatório você deseja gerar?" },
      action:{ buttons:[
        { type:"reply", reply:{ id:"REL:CAT:cp",  title:"Contas a pagar" } },
        { type:"reply", reply:{ id:"REL:CAT:rec", title:"Recebimentos" } },
        { type:"reply", reply:{ id:"REL:CAT:pag", title:"Pagamentos" } }
      ]}
    }
  });
}

async function sendPeriodoButtons(to, prefix){
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"🗓️ Escolha o período:" },
      action:{ buttons:[
        { type:"reply", reply:{ id:`${prefix}:mes_atual`,        title:"Mês atual" } },
        { type:"reply", reply:{ id:`${prefix}:todo_periodo`,     title:"Todo período" } },
        { type:"reply", reply:{ id:`${prefix}:personalizado`,    title:"Data personalizada" } }
      ]}
    }
  });
}

async function sendLancPeriodoButtons(to){
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"🧾 Escolha o período:" },
      action:{ buttons:[
        { type:"reply", reply:{ id:`LANC:PER:mes_atual`,     title:"Mês atual" } },
        { type:"reply", reply:{ id:`LANC:PER:personalizado`, title:"Data personalizada" } }
      ]}
    }
  });
}

// ============================
// Acesso aos dados
// ============================
async function allRowsForUser(userNorm){
  const sheet=await ensureSheet();
  const rows=await sheet.getRows();
  return rows.filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm);
}
function withinPeriod(rows, start, end){
  return rows.filter(r => withinRange(getEffectiveDate(r), start, end));
}
function sumValues(rows){
  return rows.reduce((acc,r)=> acc + (parseFloat(getVal(r,"valor")||"0")||0), 0);
}

// ============================
// Renderização e helpers
// ============================
function renderItem(r, idx){
  const idxEmoji = numberToKeycapEmojis(idx);
  const conta = getVal(r,"conta") || "Lançamento";
  const valor = formatCurrencyBR(getVal(r,"valor"));
  const data  = formatBRDate(getEffectiveDate(r));
  const status = statusIconLabel(getVal(r,"status"));
  const catEmoji = getVal(r,"categoria_emoji") || "";
  const cat = getVal(r,"categoria") ? `${catEmoji} ${getVal(r,"categoria")}` : "—";
  const desc = getVal(r,"descricao") || conta;
  return `${idxEmoji} ${conta}
📝 Descrição: ${desc}
💰 Valor: ${valor}
📅 Data: ${data}
🏷️ Status: ${status}
📂 Categoria: ${cat}
${"────────────────"}
`;
}

function renderReportList(title, rows){
  let msg = `📊 *${title}*\n\n`;
  if(!rows.length){
    msg += "✅ Nenhum lançamento encontrado para o período selecionado.";
    return msg;
  }
  rows.forEach((r,i)=>{ msg += renderItem(r, i+1); });
  msg += `\n💰 *Total:* ${formatCurrencyBR(sumValues(rows))}`;
  return msg;
}

function renderSaldoFooter(rowsAll, start, end){
  const within = withinPeriod(rowsAll, start, end);
  const recebimentosPagos = within.filter(r => getVal(r,"tipo")==="conta_receber" && (getVal(r,"status")==="pago" || getVal(r,"status")==="recebido"));
  const pagamentosPagos   = within.filter(r => getVal(r,"tipo")==="conta_pagar"   && getVal(r,"status")==="pago");
  const totalRec = sumValues(recebimentosPagos);
  const totalPag = sumValues(pagamentosPagos);
  const saldo = totalRec - totalPag;
  const saldoStr = formatCurrencyBR(saldo);
  const saldoLine = saldo < 0 ? `🟥 🔹 *Saldo no período:* -${saldoStr}` : `🔹 *Saldo no período:* ${saldoStr}`;
  return `\n${"────────────────"}\n💰 *Total de Recebimentos:* ${formatCurrencyBR(totalRec)}\n💸 *Total de Pagamentos:* ${formatCurrencyBR(totalPag)}\n${saldoLine}`;
}

async function showReportByCategory(fromRaw, userNorm, category, range){
  const rows = await allRowsForUser(userNorm);
  const {start,end} = range;
  const inRange = withinPeriod(rows, start, end);

  if(category==="cp"){
    const filtered = inRange.filter(r => getVal(r,"tipo")==="conta_pagar" && getVal(r,"status")!=="pago");
    const msg = renderReportList("Relatório • Contas a pagar", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, msg); return;
  }
  if(category==="rec"){
    const filtered = inRange.filter(r => getVal(r,"tipo")==="conta_receber");
    const msg = renderReportList("Relatório • Recebimentos", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, msg); return;
  }
  if(category==="pag"){
    const filtered = inRange.filter(r => getVal(r,"tipo")==="conta_pagar");
    const msg = renderReportList("Relatório • Pagamentos", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, msg); return;
  }
  if(category==="all"){
    const filtered = inRange.slice().sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b));
    const msg = renderReportList("Relatório • Completo", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, msg); return;
  }
}

async function showLancamentos(fromRaw, userNorm, range){
  const rows = await allRowsForUser(userNorm);
  const within = withinPeriod(rows, range.start, range.end)
    .filter(r => parseFloat(getVal(r,"valor")||"0")>0)
    .sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b));
  if (!within.length){
    await sendText(fromRaw,"✅ Nenhum lançamento encontrado para o período selecionado.");
    return;
  }
  let msg = `🧾 *Meus lançamentos*\n\n`;
  within.forEach((r,i)=>{ msg += renderItem(r, i+1); });
  await sendText(fromRaw, msg);
}

// ============================
// Exclusão/Edição (resumido – handlers principais no clique)
// ============================
async function handleDeleteMenu(fromRaw){
  return sendWA({
    messaging_product:"whatsapp", to:fromRaw, type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"🗑️ Como deseja excluir?" },
      action:{ buttons:[
        { type:"reply", reply:{ id:"DEL:LAST", title:"Último lançamento" } },
        { type:"reply", reply:{ id:"DEL:LIST", title:"Listar lançamentos" } }
      ]}
    }
  });
}

// ============================
// Intents e handler
// ============================
async function detectIntent(t){
  const lower=(t||"").toLowerCase();
  const norm = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if(/(oi|ola|opa|bom dia|boa tarde|boa noite)/i.test(norm)) return "boas_vindas";
  if(/\b(relat[óo]rios?)\b/.test(lower)) return "relatorios_menu";
  if(/\b(relat[óo]rio\s+completo|completo)\b/.test(lower)) return "relatorio_completo";
  if(/\b(lan[cç]amentos|meus lan[cç]amentos|registros|extrato)\b/i.test(lower)) return "listar_lancamentos";
  if(/\b(contas?\s+a\s+pagar|pendentes|a pagar|contas pendentes|contas a vencer|pagamentos pendentes)\b/i.test(lower)) return "listar_pendentes";
  if(/\beditar lan[cç]amentos?\b/.test(lower)) return "editar";
  if(/\bexcluir lan[cç]amentos?\b/.test(lower)) return "excluir";
  return "desconhecido";
}

async function handleUserText(fromRaw, text){
  const userNorm = normalizeUser(fromRaw);
  const trimmed = (text||"").trim();

  const sp = sessionPeriod.get(userNorm);
  if (sp && sp.awaiting === "range"){
    const pretty =
`🗓️ *Selecione um período personalizado*

Envie no formato:
01/10/2025 a 31/10/2025

💡 Dica: você pode usar "a", "-", "até".`;
    const m = trimmed.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:a|-|até|ate|–|—)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if(!m){ await sendText(fromRaw, pretty); return; }
    const [_, d1, d2] = m;
    const [d1d,d1m,d1y]=d1.split("/").map(n=>parseInt(n,10));
    const [d2d,d2m,d2y]=d2.split("/").map(n=>parseInt(n,10));
    let start = startOfDay(new Date(d1y, d1m-1, d1d));
    let end   = endOfDay(new Date(d2y, d2m-1, d2d));
    if (start > end){ const t=start; start=end; end=t; }
    sessionPeriod.delete(userNorm);
    if (sp.mode === "report"){
      await showReportByCategory(fromRaw, userNorm, sp.category, {start,end});
      return;
    } else if (sp.mode === "lanc"){
      await showLancamentos(fromRaw, userNorm, {start,end});
      return;
    }
  }

  const intent = await detectIntent(text);
  if (intent === "boas_vindas") { await sendWelcomeList(fromRaw); return; }

  if (/^relat[óo]rios?$/i.test(trimmed)) { await sendRelatoriosButtons(fromRaw); return; }
  if (/^relat[óo]rios? de contas a pagar$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:cp"); return; }
  if (/^relat[óo]rios? de recebimentos$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:rec"); return; }
  if (/^relat[óo]rios? de pagamentos$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:pag"); return; }
  if (intent === "relatorio_completo" || /^relat[óo]rio(s)? completo(s)?$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:all"); return; }

  if (/^lan[cç]amentos( do m[eê]s)?$/i.test(trimmed)) {
    const now=new Date();
    const range={ start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()) };
    await showLancamentos(fromRaw, userNorm, range);
    return;
  }

  if (intent === "editar") { await sendText(fromRaw,"✏️ Em breve (já em desenvolvimento)."); return; }
  if (intent === "excluir") { await handleDeleteMenu(fromRaw); return; }

  await sendText(fromRaw, `😕 *Não entendi o que você quis dizer.*

Toque em *Abrir menu* ou digite o que deseja fazer.`);
  await sendWelcomeList(fromRaw);
}

// ============================
// Webhook
// ============================
app.get("/webhook",(req,res)=>{
  const token=WEBHOOK_VERIFY_TOKEN || "verify_token";
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
          const messages = c.value?.messages || [];
          for(const m of messages){
            const from=m.from;

            if(m.type==="text") await handleUserText(from, m.text?.body || "");

            if(m.type==="interactive"){
              const btn = m.interactive?.button_reply;
              const list= m.interactive?.list_reply;

              if (btn?.id){
                const id=btn.id;

                if(id==="REL:CAT:cp"){ await sendPeriodoButtons(from, "REL:PER:cp"); }
                if(id==="REL:CAT:rec"){ await sendPeriodoButtons(from, "REL:PER:rec"); }
                if(id==="REL:CAT:pag"){ await sendPeriodoButtons(from, "REL:PER:pag"); }

                if(id.startsWith("REL:PER:")){
                  const parts = id.split(":");
                  const cat = parts[2]; const opt = parts[3];
                  const userNorm = normalizeUser(from);
                  const now=new Date();
                  if(opt==="mes_atual"){
                    const range={ start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()) };
                    await showReportByCategory(from, userNorm, cat, range);
                  } else if (opt==="todo_periodo"){
                    const rows=await allRowsForUser(userNorm);
                    let min = null;
                    for(const r of rows){ const d=getEffectiveDate(r); if(d && (!min || d<min)) min=d; }
                    const start = min ? startOfDay(min) : startOfDay(new Date());
                    const end   = endOfDay(new Date());
                    await showReportByCategory(from, userNorm, cat, {start,end});
                  } else if (opt==="personalizado"){
                    sessionPeriod.set(userNorm, { mode:"report", category:cat, awaiting:"range" });
                    await sendText(from,
`🗓️ *Selecione um período personalizado*

Envie no formato:
01/10/2025 a 31/10/2025

💡 Dica: você pode usar "a", "-", "até".`);
                  }
                }

                if(id.startsWith("LANC:PER:")){
                  const [, , opt] = id.split(":");
                  const userNorm = normalizeUser(from);
                  const now=new Date();
                  if(opt==="mes_atual"){
                    const range={ start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()) };
                    await showLancamentos(from, userNorm, range);
                  } else if (opt==="personalizado"){
                    sessionPeriod.set(userNorm, { mode:"lanc", awaiting:"range" });
                    await sendText(from,
`🗓️ *Selecione um período personalizado*

Envie no formato:
01/10/2025 a 31/10/2025

💡 Dica: você pode usar "a", "-", "até".`);
                  }
                }

                if(id==="DEL:LAST"){ /* handler completo no arquivo final */ }
                if(id==="DEL:LIST"){ /* handler completo no arquivo final */ }
                if(id==="DEL:CONFIRM"){ /* handler completo no arquivo final */ }
              }

              if (list?.id){
                const id=list.id;
                if(id==="MENU:registrar_pagamento"){
                  await sendText(from,
`💰 *Registrar pagamento ou gasto*

Digite o pagamento ou gasto que deseja registrar, informando:

📝 Descrição: (ex: Internet)
💰 Valor: (ex: 150,00)
📅 Data: (ex: hoje, amanhã ou 05/11/2025)
🏷️ Status: (pago ou pendente)
📂 Categoria: (opcional, será detectada automaticamente)`);
                }
                if(id==="MENU:registrar_recebimento"){
                  await sendText(from,
`💵 *Registrar recebimento*

Digite o recebimento que deseja registrar, informando:

📝 Descrição: (ex: Venda curso)
💰 Valor: (ex: 200,00)
📅 Data: (ex: hoje, amanhã ou 05/11/2025)
🏷️ Status: (recebido ou pendente)
📂 Categoria: (opcional, será detectada automaticamente)`);
                }
                if(id==="MENU:contas_pagar"){ /* lista pendentes no arquivo final */ }
                if(id==="MENU:contas_fixas"){ await sendText(from,"♻️ Ex.: *Conta fixa internet 100 todo dia 01* | *Excluir conta fixa internet*"); }
                if(id==="MENU:relatorios"){ await sendRelatoriosButtons(from); }
                if(id==="MENU:lancamentos"){ await sendLancPeriodoButtons(from); }
                if(id==="MENU:editar"){ await sendText(from,"✏️ Em breve (já em desenvolvimento)."); }
                if(id==="MENU:excluir"){ await handleDeleteMenu(from); }
                if(id==="MENU:ajuda"){
                  await sendText(from,
`⚙️ *Ajuda & Exemplos*

🧾 *Registrar pagamento*
Ex.: Academia 150,00 pago hoje
Ex.: Pagar internet 120 amanhã

💵 *Registrar recebimento*
Ex.: Venda curso 200,00 recebido hoje
Ex.: Receber aluguel 900,00 05/11/2025

📊 *Relatórios*
Toque em Relatórios → escolha *Contas a pagar*, *Recebimentos* ou *Pagamentos* → selecione o período.

🧾 *Meus lançamentos*
Toque em Meus lançamentos → escolha *Mês atual* ou *Data personalizada*.

✏️ *Editar lançamentos*
Toque em Editar lançamentos → escolha pelo número → selecione o que deseja alterar.

🗑️ *Excluir lançamento*
Toque em Excluir lançamento → *Último lançamento* ou *Listar lançamentos*.`);
                }
              }
            }
          }
        }
      }
    }
    res.sendStatus(200);
  }catch(e){
    console.error("Erro no webhook:", e.message);
    res.sendStatus(200);
  }
});

// ============================
// CRON: 08:00 America/Maceio
// ============================
cron.schedule("0 8 * * *", async()=>{
  try{
    const sheet=await ensureSheet();
    const rows=await sheet.getRows();
    const today = startOfDay(new Date()).getTime();

    const duePay = rows.filter(r =>
      getVal(r,"tipo")==="conta_pagar" &&
      getVal(r,"status")!=="pago" &&
      getVal(r,"vencimento_iso")
    ).filter(r => startOfDay(new Date(getVal(r,"vencimento_iso"))).getTime()===today);

    const dueRecv = rows.filter(r =>
      getVal(r,"tipo")==="conta_receber" &&
      getVal(r,"status")!=="pago" && getVal(r,"status")!=="recebido" &&
      getVal(r,"vencimento_iso")
    ).filter(r => startOfDay(new Date(getVal(r,"vencimento_iso"))).getTime()===today);

    const notify = async (r, isRecv=false)=>{
      const toRaw=getVal(r,"user_raw") || getVal(r,"user");
      const tipoTxt = isRecv ? "recebimento" : "pagamento";
      await sendText(toRaw, `⚠️ *Lembrete de ${tipoTxt}!*

📘 ${getVal(r,"conta")||"Lançamento"}
📝 Descrição: ${getVal(r,"descricao")||getVal(r,"conta")||"—"}
💰 ${formatCurrencyBR(parseFloat(getVal(r,"valor")||"0"))}
📅 Para hoje (${formatBRDate(getVal(r,"vencimento_iso"))})`);
      if(getVal(r,"tipo_pagamento")==="pix")    await sendCopyButton(toRaw,"💳 Chave Pix:",getVal(r,"codigo_pagamento"),"Copiar Pix");
      if(getVal(r,"tipo_pagamento")==="boleto") await sendCopyButton(toRaw,"🧾 Código de barras:",getVal(r,"codigo_pagamento"),"Copiar boleto");
    };

    for(const r of duePay)  await notify(r,false);
    for(const r of dueRecv) await notify(r,true);

  }catch(e){ 
    console.error("Erro no CRON:", e.message); 
  }
}, { timezone: "America/Maceio" });

// ============================
// Server
// ============================
const port = PORT || 10000;
app.listen(port, ()=> console.log(`FinPlanner IA (2025-10-23) rodando na porta ${port}`));
