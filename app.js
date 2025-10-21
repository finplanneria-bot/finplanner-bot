// ============================
// FinPlanner IA - WhatsApp Bot
// Versão: app.js (2025-10-22.1 • Auth Render FIX + Relatórios com Saldo por Período + Relatório Completo)
// ============================

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import cron from "node-cron";
import crypto from "crypto";

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
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
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
function statusIconLabel(status){ return status==="pago" ? "✅ Pago" : "⏳ Pendente"; }
const numberEmoji = (n)=>{
  const map = ["","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  return (n>=1 && n<=10) ? map[n] : `${n}️⃣`;
};
const capitalize = s => (s||"").replace(/\b\w/g, c => c.toUpperCase());
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
    if (DEBUG_SHEETS && ADMIN_WA_NUMBER) {
      await sendText(ADMIN_WA_NUMBER, `⚠️ Erro WA: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
    }
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
  if (!SHEETS_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_KEY) {
    const msg = "Variáveis de autenticação do Google ausentes.";
    console.error("❌ Auth Sheets:", msg);
    throw new Error(msg);
  }
  try{
    const serviceAccountAuth = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_SERVICE_ACCOUNT_KEY,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    doc = new GoogleSpreadsheet(SHEETS_ID, serviceAccountAuth);
    await doc.loadInfo();
    console.log("✅ Autenticado com Google Sheets com sucesso");
  }catch(e){
    console.error("❌ Erro auth Sheets:", e.message);
    throw e;
  }
}

async function ensureSheet(){
  await ensureAuth();
  let sheet = doc.sheetsByTitle["finplanner"];
  const headers = [
    "row_id","timestamp","user","user_raw","tipo","conta","valor",
    "vencimento_iso","vencimento_br","tipo_pagamento","codigo_pagamento",
    "status","fixa","fix_parent_id","vencimento_dia"
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
// Sessões (edição e períodos)
// ============================
const sessionEdit = new Map();     // userNorm -> { editRowId, field }
const sessionPeriod = new Map();   // userNorm -> { mode: 'report'|'lanc', category?: 'cp'|'rec'|'pag'|'all', awaiting:'range' }

// ============================
// Menus interativos
// ============================
async function sendWelcomeList(to){
  const body = `👋 Olá! Eu sou a FinPlanner IA.

💡 Organizo seus pagamentos, ganhos e gastos de forma simples e automática.

Toque em *“Abrir menu”* ou digite o que deseja fazer.`;

  // Envia LIST diretamente (sem botão intermediário)
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
              { id:"MENU:registrar_pagamento", title:"💰 Registrar pagamento", description:"Adicionar um novo gasto." },
              { id:"MENU:registrar_recebimento", title:"💵 Registrar recebimento", description:"Adicionar uma entrada de dinheiro." },
              { id:"MENU:contas_pagar", title:"📅 Contas a pagar", description:"Ver e confirmar pagamentos pendentes." },
              { id:"MENU:contas_fixas", title:"♻️ Contas fixas", description:"Cadastrar ou excluir contas recorrentes." },
            ]
          },
          {
            title:"Relatórios e Histórico",
            rows:[
              { id:"MENU:relatorios", title:"📊 Relatórios", description:"Gerar por categoria e período." },
              { id:"MENU:lancamentos", title:"🧾 Meus lançamentos", description:"Ver por mês ou período personalizado." },
            ]
          },
          {
            title:"Ajustes e Ajuda",
            rows:[
              { id:"MENU:editar", title:"✏️ Editar lançamentos", description:"Alterar ou revisar registros." },
              { id:"MENU:excluir", title:"🗑️ Excluir lançamento", description:"Remover lançamento manualmente." },
              { id:"MENU:ajuda", title:"⚙️ Ajuda e exemplos", description:"Como usar a FinPlanner IA." },
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
        { type:"reply", reply:{ id:"REL:CAT:cp",   title:"Contas a pagar" } },
        { type:"reply", reply:{ id:"REL:CAT:rec",  title:"Recebimentos" } },
        { type:"reply", reply:{ id:"REL:CAT:pag",  title:"Pagamentos" } },
        { type:"reply", reply:{ id:"REL:CAT:all",  title:"Relatório completo" } },
      ]}
    }
  });
}

async function sendPeriodoButtons(to, prefix){
  // prefix: REL:PER:cp|rec|pag|all ou LANC:PER
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"🗓️ Selecione o período do relatório" },
      action:{ buttons:[
        { type:"reply", reply:{ id:`${prefix}:mes_atual`,        title:"Mês atual" } },
        { type:"reply", reply:{ id:`${prefix}:todo_periodo`,     title:"Todo o período" } },
        { type:"reply", reply:{ id:`${prefix}:personalizado`,    title:"Período personalizado" } },
      ]}
    }
  });
}

async function sendLancPeriodoButtons(to){
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"🧾 Selecione o período dos lançamentos" },
      action:{ buttons:[
        { type:"reply", reply:{ id:`LANC:PER:mes_atual`,     title:"Mês atual" } },
        { type:"reply", reply:{ id:`LANC:PER:personalizado`, title:"Período personalizado" } },
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
// Renderização de relatórios
// ============================
function renderReportList(title, rows){
  let msg = `📊 *${title}*\n\n`;
  if(!rows.length){
    msg += "✅ Nenhum lançamento encontrado para o período selecionado.";
    return msg;
  }
  rows.forEach((r,i)=>{
    const idx = i+1;
    msg += `${numberEmoji(idx)} ${getVal(r,"conta")||"Lançamento"}\n` +
           `💰 ${formatCurrencyBR(getVal(r,"valor"))}\n` +
           `📅 Data: ${formatBRDate(getEffectiveDate(r))}\n` +
           `🏷️ Status: ${statusIconLabel(getVal(r,"status"))}\n` +
           `${SEP}\n`;
  });
  msg += `\n💰 *Total:* ${formatCurrencyBR(sumValues(rows))}`;
  return msg;
}

// Saldo consolidado (pagos no período): Recebimentos pagos - Pagamentos pagos
function renderSaldoFooter(rowsAll, start, end){
  const within = withinPeriod(rowsAll, start, end);
  const recebimentosPagos = within.filter(r => getVal(r,"tipo")==="conta_receber" && getVal(r,"status")==="pago");
  const pagamentosPagos   = within.filter(r => getVal(r,"tipo")==="conta_pagar"   && getVal(r,"status")==="pago");
  const totalRec = sumValues(recebimentosPagos);
  const totalPag = sumValues(pagamentosPagos);
  const saldo = totalRec - totalPag;
  const saldoStr = formatCurrencyBR(saldo);
  const saldoLine = saldo < 0 ? `🟥 🔹 *Saldo no período:* -${saldoStr}` : `🔹 *Saldo no período:* ${saldoStr}`;
  return `\n${SEP}\n💰 *Total de Recebimentos:* ${formatCurrencyBR(totalRec)}\n💸 *Total de Pagamentos:* ${formatCurrencyBR(totalPag)}\n${saldoLine}`;
}

async function showReportByCategory(fromRaw, userNorm, category, range){
  const rows = await allRowsForUser(userNorm);
  const {start,end} = range;
  const inRange = withinPeriod(rows, start, end);

  if(category==="cp"){ // Contas a pagar (pendentes)
    const filtered = inRange.filter(r => getVal(r,"tipo")==="conta_pagar" && getVal(r,"status")!=="pago");
    const msg = renderReportList("Relatório • Contas a pagar", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, msg); return;
  }
  if(category==="rec"){ // Recebimentos (todos; saldo considera pagos)
    const filtered = inRange.filter(r => getVal(r,"tipo")==="conta_receber");
    const msg = renderReportList("Relatório • Recebimentos", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, msg); return;
  }
  if(category==="pag"){ // Pagamentos (despesas; saldo considera pagos)
    const filtered = inRange.filter(r => getVal(r,"tipo")==="conta_pagar");
    const msg = renderReportList("Relatório • Pagamentos", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, msg); return;
  }
  if(category==="all"){ // Relatório completo (tudo no período)
    const filtered = inRange.slice().sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b));
    const msg = renderReportList("Relatório • Completo", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, msg); return;
  }
}

// ============================
// Lançamentos (lista geral)
// ============================
function renderLancamentosList(rows, title="🧾 Meus lançamentos"){
  let msg = `🧾 *${title}*\n\n`;
  if(!rows.length){
    msg += "✅ Nenhum lançamento encontrado para o período selecionado.";
    return msg;
  }
  rows.forEach((r,i)=>{
    const idx=i+1;
    msg += `${numberEmoji(idx)} ${getVal(r,"conta")||"Lançamento"}\n` +
           `💰 ${formatCurrencyBR(getVal(r,"valor"))}\n` +
           `📅 Data: ${formatBRDate(getEffectiveDate(r))}\n` +
           `🏷️ ${(getVal(r,"tipo")==="conta_receber" ? "Recebimento" : "Pagamento")} • ${statusIconLabel(getVal(r,"status"))}\n` +
           `${SEP}\n`;
  });
  return msg;
}
async function showLancamentos(fromRaw, userNorm, range){
  const rows = await allRowsForUser(userNorm);
  const within = withinPeriod(rows, range.start, range.end)
    .filter(r => parseFloat(getVal(r,"valor")||"0")>0)
    .sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b)); // ordem de registro
  await sendText(fromRaw, renderLancamentosList(within, "Meus lançamentos"));
}

// ============================
// Edição (atalhos essenciais, como antes)
// ============================
async function sendSubmenuEditarButtons(to){
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"✏️ O que você deseja fazer?" },
      action:{ buttons:[
        { type:"reply", reply:{ id:"EDITAR:ULTIMO",    title:"Alterar o último registro" } },
        { type:"reply", reply:{ id:"EDITAR:POR_CATEG", title:"Ver lista por categoria" } },
        { type:"reply", reply:{ id:"MENU:principal",   title:"🔙 Voltar ao menu" } },
      ]}
    }
  });
}

async function sendListCategoriasEdicao(to){
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"list",
      header:{ type:"text", text:"Editar por categoria" },
      body:{ text:"Escolha a categoria que deseja editar:" },
      action:{
        button:"Categorias",
        sections:[{
          title:"Categorias",
          rows:[
            { id:"EDITAR:CATEG:conta_pagar",   title:"💡 Contas a pagar",   description:"Editar gastos/pendentes" },
            { id:"EDITAR:CATEG:conta_receber", title:"💸 Contas a receber", description:"Editar receitas" },
            { id:"EDITAR:CATEG:fixa",          title:"♻️ Contas fixas",     description:"Editar recorrências" },
            { id:"MENU:principal",             title:"🔙 Voltar ao menu",   description:"" },
          ]
        }]
      }
    }
  });
}

// ============================
// Menu principal (LIST)
// ============================
async function sendMenuPrincipalList(to){
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"list",
      header:{ type:"text", text:"Abrir menu" },
      body:{ text:"Selecione uma opção:" },
      action:{
        button:"Abrir menu",
        sections:[
          {
            title:"Lançamentos e Contas",
            rows:[
              { id:"MENU:registrar_pagamento", title:"💰 Registrar pagamento", description:"Adicionar um novo gasto." },
              { id:"MENU:registrar_recebimento", title:"💵 Registrar recebimento", description:"Adicionar uma entrada de dinheiro." },
              { id:"MENU:contas_pagar", title:"📅 Contas a pagar", description:"Ver e confirmar pagamentos pendentes." },
              { id:"MENU:contas_fixas", title:"♻️ Contas fixas", description:"Cadastrar ou excluir contas recorrentes." },
            ]
          },
          {
            title:"Relatórios e Histórico",
            rows:[
              { id:"MENU:relatorios", title:"📊 Relatórios", description:"Gerar por categoria e período." },
              { id:"MENU:lancamentos", title:"🧾 Meus lançamentos", description:"Ver por mês ou período personalizado." },
            ]
          },
          {
            title:"Ajustes e Ajuda",
            rows:[
              { id:"MENU:editar", title:"✏️ Editar lançamentos", description:"Alterar ou revisar registros." },
              { id:"MENU:excluir", title:"🗑️ Excluir lançamento", description:"Remover lançamento manualmente." },
              { id:"MENU:ajuda", title:"⚙️ Ajuda e exemplos", description:"Como usar a FinPlanner IA." },
            ]
          }
        ]
      }
    }
  });
}

// ============================
// Contas pendentes e confirmação
// ============================
async function listPendingPayments(userNorm){
  const rows=await allRowsForUser(userNorm);
  const mine=rows
    .filter(r => getVal(r,"tipo")==="conta_pagar" && getVal(r,"status")!=="pago")
    .filter(r => parseFloat(getVal(r,"valor")||"0")>0)
    .sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b));
  return mine;
}
async function showPendingWithNumbers(fromRaw, userNorm){
  const pend = await listPendingPayments(userNorm);
  if (!pend.length){ await sendText(fromRaw,"✅ Você não tem contas a pagar no momento."); return; }
  let msg = `📋 *Suas contas a pagar:*\n\n`;
  pend.forEach((r, i)=>{
    const n=i+1; const emoji = numberEmoji(n);
    const nome=getVal(r,"conta")||"Conta";
    const val=formatCurrencyBR(parseFloat(getVal(r,"valor")||"0"));
    const data=formatBRDate(getEffectiveDate(r));
    msg += `${emoji} 💡 ${nome}\n💰 ${val}\n📅 Data: ${data}\n🏷️ Status: ${statusIconLabel(getVal(r,"status"))}\n${SEP}\n`;
  });
  msg += `\n💡 Envie o *número* ou o *nome* para confirmar o pagamento.\nExemplos: "2" ou "Confirmar internet"`;
  await sendText(fromRaw, msg.trim());
  return pend;
}
async function confirmPendingByNumber(fromRaw, userNorm, text){
  const numMatch = String(text||"").trim().match(/^\d{1,2}$/);
  if(!numMatch) return false;
  const idx = parseInt(numMatch[0])-1;
  const pend = await listPendingPayments(userNorm);
  const sel = pend[idx]; if(!sel) return false;
  setVal(sel,"status","pago"); await saveRow(sel);
  await sendText(fromRaw, `✅ Pagamento confirmado: *${getVal(sel,"conta")}* no valor de ${formatCurrencyBR(getVal(sel,"valor"))}.`);
  return true;
}
async function confirmPendingByDescription(fromRaw, userNorm, text){
  const lower=(text||"").toLowerCase();
  if(!/\b(confirm(ar)?|pago)\b/.test(lower)) return false;
  const rows=await allRowsForUser(userNorm);
  const candidates = rows.filter(r => getVal(r,"tipo")==="conta_pagar" && getVal(r,"status")!=="pago");
  const hit = candidates.find(r => lower.includes((getVal(r,"conta")||"").toLowerCase()));
  if(!hit) return false;
  setVal(hit,"status","pago"); await saveRow(hit);
  await sendText(fromRaw, `✅ Pagamento confirmado: *${getVal(hit,"conta")}* no valor de ${formatCurrencyBR(getVal(hit,"valor"))}.`);
  return true;
}

// ============================
// Intents e handler
// ============================
const GREET_RE = /(\b(oi|ol[aá]|opa|bom dia|boa tarde|boa noite)\b)/i;
const FIN_KEYWORDS_RE = /(pagar|paguei|receber|recebi|ganhei|venda|gastei|conta fixa|boleto|pix|lançamento|lancamento|contas a pagar|relat[óo]rio)/i;
function hasDigitsOrCurrency(t){ return /\d/.test(t||"") || /r\$/i.test(t||""); }
function isIrrelevantShortMessage(t){
  const text=(t||"").trim(); if (!text) return true;
  const words=text.split(/\s+/);
  if (words.length<=3 && GREET_RE.test(text)) return true;
  if (words.length<=2 && !hasDigitsOrCurrency(text) && !FIN_KEYWORDS_RE.test(text)) return true;
  if (/\b(menu|teste|test|help)\b/i.test(text) && !FIN_KEYWORDS_RE.test(text)) return true;
  return false;
}
async function detectIntent(t){
  const lower=(t||"").toLowerCase();
  const norm = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if(/(oi|ola|opa|bom dia|boa tarde|boa noite)/i.test(norm)) return "boas_vindas";
  if(/\b(funções|funcoes|ajuda|help)\b/.test(lower)) return "funcoes";
  if(/\b(relat[óo]rios?)\b/.test(lower)) return "relatorios_menu";
  if(/\b(relat[óo]rio\s+completo|completo)\b/.test(lower)) return "relatorio_completo";
  if(/\b(lan[cç]amentos|meus lan[cç]amentos|registros|extrato)\b/i.test(lower)) return "listar_lancamentos";
  if(/\b(contas?\s+a\s+pagar|pendentes|a pagar|contas pendentes|contas a vencer|pagamentos pendentes)\b/i.test(lower)) return "listar_pendentes";
  return "desconhecido";
}

async function handleUserText(fromRaw, text){
  const userNorm = normalizeUser(fromRaw);
  const trimmed = (text||"").trim();

  // Sessão de período pendente (relatórios/lançamentos)
  const sp = sessionPeriod.get(userNorm);
  if (sp && sp.awaiting === "range"){
    const m = trimmed.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:a|-|até|ate|–|—)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if(!m){
      await sendText(fromRaw, "🗓️ Formato inválido. Envie no formato: 01/10/2025 a 31/10/2025");
      return;
    }
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

  // Comandos diretos de relatórios
  if (/^relat[óo]rios?$/i.test(trimmed)) { await sendRelatoriosButtons(fromRaw); return; }
  if (/^relat[óo]rios? de contas a pagar$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:cp"); return; }
  if (/^relat[óo]rios? de recebimentos$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:rec"); return; }
  if (/^relat[óo]rios? de pagamentos$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:pag"); return; }
  if (intent === "relatorio_completo" || /^relat[óo]rio(s)? completo(s)?$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:all"); return; }

  // Lançamentos do mês (atalho)
  if (/^lan[cç]amentos( do m[eê]s)?$/i.test(trimmed)) {
    const now=new Date();
    const range={ start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()) };
    await showLancamentos(fromRaw, userNorm, range);
    return;
  }

  if (intent === "listar_pendentes") { await showPendingWithNumbers(fromRaw, userNorm); return; }
  if (intent === "listar_lancamentos") { await sendLancPeriodoButtons(fromRaw); return; }
  if (intent === "relatorios_menu") { await sendRelatoriosButtons(fromRaw); return; }

  // fallback
  await sendText(fromRaw, `✅ Você pode digitar: 
• "Relatórios" → escolher categoria e período
• "Relatório completo"
• "Relatórios de contas a pagar"
• "Lançamentos do mês"
ou tocar em *Abrir menu* para usar o menu interativo.`);
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

              // Botões
              if (btn?.id){
                const id=btn.id;

                // Relatórios: categorias
                if(id==="REL:CAT:cp"){ await sendPeriodoButtons(from, "REL:PER:cp"); }
                if(id==="REL:CAT:rec"){ await sendPeriodoButtons(from, "REL:PER:rec"); }
                if(id==="REL:CAT:pag"){ await sendPeriodoButtons(from, "REL:PER:pag"); }
                if(id==="REL:CAT:all"){ await sendPeriodoButtons(from, "REL:PER:all"); }

                // Seleção de período dos relatórios
                if(id.startsWith("REL:PER:")){
                  const [, , cat, opt] = id.split(":"); // REL PER cp|rec|pag|all : mes_atual|todo_periodo|personalizado
                  const userNorm = normalizeUser(from);
                  const now=new Date();
                  if(opt==="mes_atual"){
                    const range={ start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()) };
                    await showReportByCategory(from, userNorm, cat, range);
                  } else if (opt==="todo_periodo"){
                    const rows=await allRowsForUser(userNorm);
                    // pega primeiro registro do usuário
                    let min = null;
                    for(const r of rows){ const d=getEffectiveDate(r); if(d && (!min || d<min)) min=d; }
                    const start = min ? startOfDay(min) : startOfDay(new Date());
                    const end   = endOfDay(new Date());
                    await showReportByCategory(from, userNorm, cat, {start,end});
                  } else if (opt==="personalizado"){
                    sessionPeriod.set(userNorm, { mode:"report", category:cat, awaiting:"range" });
                    await sendText(from, "🗓️ Selecione o período. Ex.: 01/10/2025 a 31/10/2025");
                  }
                }

                // Lançamentos: períodos
                if(id.startsWith("LANC:PER:")){
                  const [, , opt] = id.split(":");
                  const userNorm = normalizeUser(from);
                  const now=new Date();
                  if(opt==="mes_atual"){
                    const range={ start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()) };
                    await showLancamentos(from, userNorm, range);
                  } else if (opt==="personalizado"){
                    sessionPeriod.set(userNorm, { mode:"lanc", awaiting:"range" });
                    await sendText(from, "🗓️ Selecione o período. Ex.: 01/10/2025 a 31/10/2025");
                  }
                }
              }

              // Lista (menus)
              if (list?.id){
                const id=list.id;
                if(id==="MENU:registrar_pagamento"){ await sendText(from,"💰 Envie: *Pagar internet 120 amanhã*"); }
                if(id==="MENU:registrar_recebimento"){ await sendText(from,"💵 Envie: *Receber venda 200 hoje*"); }
                if(id==="MENU:contas_pagar"){ await showPendingWithNumbers(from, normalizeUser(from)); }
                if(id==="MENU:contas_fixas"){ await sendText(from,"♻️ Ex.: *Conta fixa internet 100 todo dia 01* | *Excluir conta fixa internet*"); }
                if(id==="MENU:relatorios"){ await sendRelatoriosButtons(from); }
                if(id==="MENU:lancamentos"){ await sendLancPeriodoButtons(from); }
                if(id==="MENU:editar"){ await sendSubmenuEditarButtons(from); }
                if(id==="MENU:excluir"){ await sendText(from,"🗑️ Dica: *Excluir 3* (pelo número) ou *Excluir internet*."); }
                if(id==="MENU:ajuda"){ await sendText(from,"⚙️ Exemplos: *Pagar energia 150 amanhã*, *Contas a pagar*, *Relatórios*."); }
              }
            }
          }
        }
      }
    }
    res.sendStatus(200);
  }catch(e){
    console.error("Erro no webhook:", e.message);
    if (DEBUG_SHEETS && ADMIN_WA_NUMBER) {
      await sendText(ADMIN_WA_NUMBER, `❌ Erro no webhook: ${e.message}`);
    }
    res.sendStatus(200);
  }
});

// ============================
// CRON: lembretes a cada 30 min (vencimentos de hoje)
// ============================
cron.schedule("*/30 * * * *", async()=>{
  try{
    const sheet=await ensureSheet();
    const rows=await sheet.getRows();
    const today = startOfDay(new Date()).getTime();
    const due = rows.filter(r =>
      getVal(r,"tipo")==="conta_pagar" &&
      getVal(r,"status")!=="pago" &&
      getVal(r,"vencimento_iso")
    ).filter(r => startOfDay(new Date(getVal(r,"vencimento_iso"))).getTime()===today);

    for(const r of due){
      const toRaw=getVal(r,"user_raw") || getVal(r,"user");
      await sendText(toRaw, `⚠️ *Lembrete de pagamento!*

📘 ${getVal(r,"conta")||"Conta"}
💰 ${formatCurrencyBR(parseFloat(getVal(r,"valor")||"0"))}
📅 Vence hoje (${formatBRDate(getVal(r,"vencimento_iso"))})`);
      if(getVal(r,"tipo_pagamento")==="pix")    await sendCopyButton(toRaw,"💳 Chave Pix:",getVal(r,"codigo_pagamento"),"Copiar Pix");
      if(getVal(r,"tipo_pagamento")==="boleto") await sendCopyButton(toRaw,"🧾 Código de barras:",getVal(r,"codigo_pagamento"),"Copiar boleto");
    }
  }catch(e){ 
    console.error("Erro no CRON:", e.message); 
    if (DEBUG_SHEETS && ADMIN_WA_NUMBER) await sendText(ADMIN_WA_NUMBER, `⚠️ Erro CRON: ${e.message}`);
  }
});

// ============================
// Server
// ============================
const port = PORT || 10000;
app.listen(port, ()=> console.log(`FinPlanner IA (Relatórios com saldo + Auth FIX) rodando na porta ${port}`));
