// ============================
// FinPlanner IA - WhatsApp Bot
// Versão: app.js (2025-10-21.3.4 • COMPLETA, colorida, detalhada)
// ============================

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import cron from "node-cron";
import crypto from "crypto";

dotenv.config();

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

let GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY && GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}

const app = express();
app.use(bodyParser.json());

const normalizeUser = (num) => (num || "").replace(/\D/g, "");
const uuidShort = () => crypto.randomBytes(6).toString("hex");
const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = d => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
const startOfMonth = (y,m) => new Date(y, m, 1, 0,0,0,0);
const endOfMonth   = (y,m) => new Date(y, m+1, 0, 23,59,59,999);
const SEP = "────────────────";

function formatBRDate(d){ return d ? new Date(d).toLocaleDateString("pt-BR") : ""; }
function toISODate(d){ if(!d) return ""; const x=new Date(d); x.setHours(0,0,0,0); return x.toISOString(); }
function dayMonth(d){
  const x = d ? new Date(d) : null;
  if(!x) return "—";
  return `${String(x.getDate()).padStart(2,"0")}/${String(x.getMonth()+1).padStart(2,"0")}`;
}
function formatCurrencyBR(v, showSign=false){
  const num = Number(v || 0);
  const sign = showSign && num < 0 ? "-" : "";
  const abs = Math.abs(num);
  return `${sign}R$${abs.toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2})}`;
}
function statusIconLabel(status){ return status==="pago" ? "✅ Pago" : "⏳ Pendente"; }
const numberEmoji = (n)=>{
  const map = ["","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  return (n>=1 && n<=10) ? map[n] : `${n}️⃣`;
};
const capitalize = s => (s||"").replace(/\b\w/g, c => c.toUpperCase());
function withinRange(dt, start, end){ return dt && dt>=start && dt<=end; }
function brToDate(s){const m=s?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(!m)return null;return new Date(parseInt(m[3]),parseInt(m[2])-1,parseInt(m[1]));}

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

const doc = new GoogleSpreadsheet(SHEETS_ID);

async function ensureAuth(){
  if (!SHEETS_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_KEY) {
    const msg = "Variáveis de autenticação do Google ausentes.";
    console.error("❌ Auth Sheets:", msg);
    throw new Error(msg);
  }
  try{
    await doc.useServiceAccountAuth({ client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: GOOGLE_SERVICE_ACCOUNT_KEY });
    await doc.loadInfo();
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

function parseCurrencyBR(text){
  if(!text) return null;
  const t = (text + " ").replace(/\s+/g," ");
  const m = t.match(/\b(?:r\$)?\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?(?!\/)\b/i);
  if (!m) return null;
  const inteiro = (m[1] || "0").replace(/\./g, "");
  const cent = m[2] || "00";
  return parseFloat(`${inteiro}.${cent.padEnd(2,"0")}`);
}
function detectBarcode(text){
  const m = (text||"").replace(/\n/g," ").match(/[0-9.\s]{30,}/);
  return m ? m[0].trim().replace(/\s+/g," ") : null;
}
function detectPixKey(text){
  const hasPix = /\b(pix|transfer[eê]ncia|transferir|enviei pix|fiz pix)\b/i.test(text||"");
  if(!hasPix) return null;
  const email=(text||"").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone=(text||"").match(/\+?\d{10,14}/);
  const guid =(text||"").match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);
  return email?.[0] || phone?.[0] || guid?.[0] || "";
}
function parseDueDate(text){
  const t = text || "";
  const now = new Date();
  const dmY = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (dmY){
    let [_, d, m, y] = dmY;
    const Y = y ? (y.length===2 ? 2000 + parseInt(y) : parseInt(y)) : now.getFullYear();
    return new Date(Y, parseInt(m)-1, parseInt(d));
  }
  const dia = t.match(/\bdia\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i);
  if (dia){
    let [_, d, m, y] = dia;
    const Y = y ? (y.length===2 ? 2000 + parseInt(y) : parseInt(y)) : now.getFullYear();
    return new Date(Y, parseInt(m)-1, parseInt(d));
  }
  if (/\bontem\b/i.test(t)) { const d = new Date(now); d.setDate(d.getDate()-1); return d; }
  if (/\bhoje\b/i.test(t)) return now;
  if (/\bamanh[ãa]\b/i.test(t)) { const d = new Date(now); d.setDate(d.getDate()+1); return d; }
  return null;
}
function guessBillName(t){
  const labels=["energia","luz","água","agua","internet","aluguel","telefone","mercado","lanche","combustível","gasolina","iptu","ipva","condominio","feira","compras","cartão","cartao","academia","telegram","beatriz","óleo","oleo"];
  const lower=(t||"").toLowerCase();
  for(const l of labels) if(lower.includes(l)) return l.charAt(0).toUpperCase()+l.slice(1);
  const who=(t||"").match(/\b(?:pra|para|ao|a|à|de)\s+([\wÁÉÍÓÚÂÊÔÃÕÇ]+)/i);
  return who ? capitalize(who[1]) : (capitalize(lower.split(/\s+/).slice(0,3).join(" ")) || "Lançamento");
}

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
  if(/\b(relat[óo]rio|resumo)\b/.test(lower)) return "relatorio";
  if(/^\s*(pago|pendente)\s*$/i.test(t||"")) return "responder_status_texto";
  if(/\b(editar|corrigir|alterar|atualizar)\b/i.test(lower)) return "editar_lancamento";
  if(/\b(lan[cç]amentos|meus lan[cç]amentos|registros|extrato)\b/i.test(lower)) return "listar_lancamentos";
  if(/\b(contas?\s+a\s+pagar|pendentes|a pagar|contas pendentes|contas a vencer|pagamentos pendentes)\b/i.test(lower)) return "listar_pendentes";
  if(/\b(minhas contas fixas|contas fixas|pagamentos fixos|conta fixa|pagamento fixo)\b/i.test(lower)) return "conta_fixa";
  if(/\b(confirmar pagamento|quero confirmar|marcar como pago|confirmar\s+\d+|confirmar\s+[a-z])\b/i.test(lower)) return "confirmar_pagamento_solto";
  if(/\b(excluir|deletar|apagar)\b/i.test(lower)) return "excluir_lancamento";
  if(/\b(pagar|pagamento|vou pagar|irei pagar|quitar|liquidar|pix\s+para|transferir|enviar)\b/i.test(lower)) return "nova_conta";
  if(/\b(receber|entrada|venda|ganhar|ganho|receita|recebi|ganhei|gastei|paguei|efetuei|enviei|fiz pix)\b/i.test(lower)) return "novo_movimento";
  return "desconhecido";
}

async function sendWelcomeWithOpenMenuButton(to){
  const body = `👋 Olá! Eu sou a FinPlanner IA.

💡 Organizo seus pagamentos, ganhos e gastos de forma simples e automática.

Toque em *“Ver opções”* ou digite o que deseja fazer.`;
  await sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"button",
      body:{ text: body },
      action:{ buttons:[{ type:"reply", reply:{ id:"OPEN_MAIN_MENU", title:"Ver opções" } }] }
    }
  });
}

async function sendMenuPrincipalList(to){
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"list",
      header:{ type:"text", text:"Ver opções" },
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
              { id:"MENU:relatorios", title:"📊 Relatórios", description:"Pagos, pendentes ou completo." },
              { id:"MENU:lancamentos", title:"🧾 Meus lançamentos", description:"Ver movimentações do mês." },
            ]
          },
          {
            title:"Ajustes e Ajuda",
            rows:[
              { id:"MENU:editar", title:"✏️ Editar lançamentos", description:"Alterar ou revisar registros." },
              { id:"MENU:excluir", title:"🗑️ Excluir lançamento", description:"Remover lançamento manualmente." },
              { id:"MENU:ajuda", title:"⚙️ Ajuda e exemplos", description:"Ver como usar a FinPlanner IA." },
            ]
          }
        ]
      }
    }
  });
}

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

async function sendEditListForCategory(to, userNorm, category){
  const sheet=await ensureSheet();
  const rows=await sheet.getRows();
  const now=new Date();
  const win = { start:startOfMonth(now.getFullYear(),now.getMonth()), end:endOfMonth(now.getFullYear(),now.getMonth()) };
  let itens = rows.filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm)
                  .filter(r => withinRange(getEffectiveDate(r), win.start, win.end));

  if (category==="conta_pagar")   itens = itens.filter(r=>getVal(r,"tipo")==="conta_pagar");
  if (category==="conta_receber") itens = itens.filter(r=>getVal(r,"tipo")==="conta_receber");
  if (category==="fixa")          itens = itens.filter(r=> (getVal(r,"fixa")||"")!=="");

  itens = itens.filter(r => parseFloat(getVal(r,"valor")||"0")>0)
               .sort((a,b)=> getEffectiveDate(b) - getEffectiveDate(a))
               .slice(0,10);

  if(!itens.length){
    await sendText(to, "✅ Nenhum lançamento encontrado nesta categoria.");
    return;
  }

  const rowsList = itens.map((r, idx)=>{
    const n = idx+1;
    const title = `${numberEmoji(n)} ${getVal(r,"conta") || "Lançamento"} — ${formatCurrencyBR(parseFloat(getVal(r,"valor")||"0"))}`;
    const desc  = `${dayMonth(getEffectiveDate(r))} | ${getVal(r,"status")==="pago"?"✅ Pago":"⏳ Pendente"}`;
    return { id:`EDITSEL:${getVal(r,"row_id")}`, title, description:desc };
  });

  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"list",
      header:{ type:"text", text:"Selecione o lançamento" },
      body:{ text:"Escolha um item para editar:" },
      action:{
        button:"Ver itens",
        sections:[{ title:"Lançamentos", rows: rowsList }]
      }
    }
  });
}

async function sendEditFieldMenu(to, rowId){
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"O que deseja alterar?" },
      action:{ buttons:[
        { type:"reply", reply:{ id:`EDITFIELD:${rowId}:valor`,  title:"Alterar valor 💰" } },
        { type:"reply", reply:{ id:`EDITFIELD:${rowId}:data`,   title:"Alterar data 📅" } },
        { type:"reply", reply:{ id:`EDITFIELD:${rowId}:status`, title:"Alterar status 🏷️" } },
        { type:"reply", reply:{ id:`EDITFIELD:${rowId}:nome`,   title:"Alterar nome ✏️" } },
        { type:"reply", reply:{ id:"EDITAR:POR_CATEG",          title:"🔙 Voltar às categorias" } },
      ]}
    }
  });
}

const session = new Map(); // userNorm -> { editRowId, field }

async function applyPendingEditIfAny(fromRaw, userNorm, text){
  const s = session.get(userNorm);
  if (!s) return false;
  const sheet=await ensureSheet();
  const rows=await sheet.getRows();
  const row = rows.find(r => getVal(r,"row_id")===s.editRowId && (getVal(r,"user")||"").replace(/\D/g,"")===userNorm);
  if(!row){ session.delete(userNorm); await sendText(fromRaw,"⚠️ Não encontrei o lançamento para edição."); return true; }

  if (s.field==="valor"){
    const v = parseCurrencyBR(text);
    if (v==null){ await sendText(fromRaw,"Informe um valor válido (ex.: 120,00)."); return true; }
    setVal(row,"valor", v);
  } else if (s.field==="data"){
    const d = parseDueDate(text);
    if(!d){ await sendText(fromRaw,"Informe uma data válida (ex.: 20/10/2025 ou 'amanhã')."); return true; }
    setVal(row,"vencimento_iso", toISODate(d)); setVal(row,"vencimento_br", formatBRDate(d));
  } else if (s.field==="status"){
    const chosen = /\bpago\b/i.test(text) ? "pago" : (/\bpendente\b/i.test(text) ? "pendente" : null);
    if(!chosen){ await sendText(fromRaw,"Digite 'pago' ou 'pendente'."); return true; }
    setVal(row,"status", chosen);
  } else if (s.field==="nome"){
    const name = text.trim(); if(!name){ await sendText(fromRaw,"Digite um nome válido."); return true; }
    setVal(row,"conta", capitalize(name));
  }
  await saveRow(row);
  session.delete(userNorm);

  await sendText(fromRaw, `✅ ${capitalize(s.field)} atualizado com sucesso.`);
  await sendEditFieldMenu(fromRaw, getVal(row,"row_id"));
  return true;
}

async function listPendingPayments(userNorm){
  const sheet=await ensureSheet();
  const rows=await sheet.getRows();
  const mine=rows
    .filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm && getVal(r,"tipo")==="conta_pagar" && getVal(r,"status")!=="pago")
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
    const data=dayMonth(getEffectiveDate(r));
    msg += `${emoji} 💡 ${nome}\n💰 ${val} | 📅 ${data} | ${statusIconLabel(getVal(r,"status"))}\n${SEP}\n`;
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
  const sheet=await ensureSheet();
  const rows=await sheet.getRows();
  const candidates = rows.filter(r =>
    (getVal(r,"user")||"").replace(/\D/g,"")===userNorm &&
    getVal(r,"tipo")==="conta_pagar" &&
    getVal(r,"status")!=="pago"
  );
  const hit = candidates.find(r => lower.includes((getVal(r,"conta")||"").toLowerCase()));
  if(!hit) return false;
  setVal(hit,"status","pago"); await saveRow(hit);
  await sendText(fromRaw, `✅ Pagamento confirmado: *${getVal(hit,"conta")}* no valor de ${formatCurrencyBR(getVal(hit,"valor"))}.`);
  return true;
}

async function handleUserText(fromRaw, text){
  const userNorm = normalizeUser(fromRaw);
  if (await applyPendingEditIfAny(fromRaw, userNorm, text)) return;
  const intent = await detectIntent(text);

  if (intent === "boas_vindas") { await sendWelcomeWithOpenMenuButton(fromRaw); return; }

  if (isIrrelevantShortMessage(text)) {
    if (GREET_RE.test(text || "")) { await sendWelcomeWithOpenMenuButton(fromRaw); }
    else { await sendText(fromRaw, "🤔 Não entendi. Toque em *Ver opções* para navegar."); }
    return;
  }

  if (intent === "listar_pendentes") { await showPendingWithNumbers(fromRaw, userNorm); return; }
  if (await confirmPendingByNumber(fromRaw, userNorm, text)) return;
  if (await confirmPendingByDescription(fromRaw, userNorm, text)) return;
  if (intent === "editar_lancamento") { await sendSubmenuEditarButtons(fromRaw); return; }

  await sendText(fromRaw, `✅ Você pode digitar: 
• "Pagar internet 120 amanhã"
• "Contas a pagar"
• "Relatórios"
ou tocar em *Ver opções* para usar o menu interativo.`);
}

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
          for(const m of c.value?.messages || []){
            const from=m.from;

            if(m.type==="text") await handleUserText(from, m.text?.body || "");

            if(m.type==="interactive"){
              const btn = m.interactive?.button_reply;
              const list= m.interactive?.list_reply;

              if (btn?.id){
                const id=btn.id;
                if(id==="OPEN_MAIN_MENU" || id==="MENU:principal"){ await sendMenuPrincipalList(from); }
                if(id==="EDITAR:ULTIMO"){
                  await sendText(from,"✏️ Você escolheu *Alterar o último registro*. Envie o que deseja alterar (ex.: \"valor 120\", \"data 20/10\", \"status pago\", \"nome academia\").");
                }
                if(id==="EDITAR:POR_CATEG"){ await sendListCategoriasEdicao(from); }
                if(id?.startsWith("EDITFIELD:")){
                  const [, rowId, field] = id.split(":");
                  session.set(normalizeUser(from), { editRowId: rowId, field });
                  if(field==="valor")  await sendText(from, "Digite o *novo valor* (ex.: 120,00):");
                  if(field==="data")   await sendText(from, "Digite a *nova data* (ex.: 20/10/2025 ou 'amanhã'):");
                  if(field==="status") await sendText(from, "Digite o *novo status* (pago ou pendente):");
                  if(field==="nome")   await sendText(from, "Digite o *novo nome/descrição*:");
                }
              }

              if (list?.id){
                const id=list.id;
                if(id==="MENU:registrar_pagamento"){ await sendText(from,"💰 Envie: *Pagar internet 120 amanhã*"); }
                if(id==="MENU:registrar_recebimento"){ await sendText(from,"💵 Envie: *Receber venda 200 hoje*"); }
                if(id==="MENU:contas_pagar"){ await showPendingWithNumbers(from, normalizeUser(from)); }
                if(id==="MENU:contas_fixas"){ await sendText(from,"♻️ Ex.: *Conta fixa internet 100 todo dia 01* | *Excluir conta fixa internet*"); }
                if(id==="MENU:relatorios"){ await sendText(from,"📊 Relatórios: *Pagos*, *A pagar*, *Vencidos* ou *Completo*."); }
                if(id==="MENU:lancamentos"){ await sendText(from,"🧾 Envie: *Lançamentos do mês* ou *Lançamentos 10/2025*."); }
                if(id==="MENU:editar"){ await sendSubmenuEditarButtons(from); }
                if(id==="MENU:excluir"){ await sendText(from,"🗑️ Dica: *Excluir 3* (pelo número) ou *Excluir internet*."); }
                if(id==="MENU:ajuda"){ await sendText(from,"⚙️ Exemplos: *Pagar energia 150 amanhã*, *Contas a pagar*, *Relatório do mês*."); }

                if(id==="EDITAR:CATEG:conta_pagar"){ await sendEditListForCategory(from, normalizeUser(from), "conta_pagar"); }
                if(id==="EDITAR:CATEG:conta_receber"){ await sendEditListForCategory(from, normalizeUser(from), "conta_receber"); }
                if(id==="EDITAR:CATEG:fixa"){ await sendEditListForCategory(from, normalizeUser(from), "fixa"); }

                if(id?.startsWith("EDITSEL:")){
                  const rowId=id.split("EDITSEL:")[1];
                  await sendEditFieldMenu(from, rowId);
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
  }catch(e){ console.error("Erro no CRON:", e.message); }
});

const port = PORT || 10000;
app.listen(port, ()=> console.log(`FinPlanner IA (com menus interativos) rodando na porta ${port}`));
