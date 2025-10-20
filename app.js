// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-21 • fix-reports+debug)
// ============================
// ⚙️ Correções definitivas de relatórios/leitura da planilha + DEBUG no console e WhatsApp (somente admin).
// Mantém: intenções naturais, contas fixas (estrutura preparada), relatórios (vencidos/pagos/a pagar/completo),
// saldo mensal (somente pagos), confirmação por número/descrição, perguntas de status quando ambíguo,
// botões de copiar Pix/Boleto, e tudo que combinamos.
//
// Requisitos de ambiente (Render → Environment):
// SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_KEY
// WA_TOKEN, WA_PHONE_NUMBER_ID
// OPENAI_API_KEY (opcional), USE_OPENAI=true|false
// DEBUG_SHEETS=true|false (true recomendado nos testes)
// ADMIN_WA_NUMBER=55XXXXXXXXXXX (número do WhatsApp do admin para receber debug)
//
// package.json: { "type": "module" }
//
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

// ---------- ENV & DIAG
const {
  SHEETS_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_KEY: RAW_KEY = "",
  WA_TOKEN,
  WA_PHONE_NUMBER_ID,
  OPENAI_API_KEY,
  USE_OPENAI: USE_OPENAI_RAW,
  DEBUG_SHEETS: DEBUG_SHEETS_RAW,
  ADMIN_WA_NUMBER,
  WEBHOOK_VERIFY_TOKEN
} = process.env;

const USE_OPENAI = (USE_OPENAI_RAW || "false").toLowerCase() === "true";
const DEBUG_SHEETS = (DEBUG_SHEETS_RAW || "false").toLowerCase() === "true";

let GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  // Render/Env geralmente salva com \n literais; converte para que a chave funcione
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}

// ---------- Utils base
const normalizeUser = (num) => (num || "").replace(/\D/g, "");
const uuidShort = () => crypto.randomBytes(6).toString("hex");
const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = d => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
const startOfMonth = (y,m) => new Date(y, m, 1, 0,0,0,0);
const endOfMonth   = (y,m) => new Date(y, m+1, 0, 23,59,59,999);

function formatBRDate(d){ return d ? new Date(d).toLocaleDateString("pt-BR") : ""; }
function toISODate(d){ if(!d) return ""; const x=new Date(d); x.setHours(0,0,0,0); return x.toISOString(); }
function formatCurrencyBR(v, showSign=false){
  const num = Number(v || 0);
  const sign = showSign && num < 0 ? "-" : ""; // usa sinal "-" quando negativo
  const abs = Math.abs(num);
  return `${sign}R$${abs.toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2})}`;
}
function monthLabel(d=new Date()){
  const meses=["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  return meses[d.getMonth()];
}
function withinRange(dt, start, end){ return dt && dt>=start && dt<=end; }
function brToDate(s){const m=s?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(!m)return null;return new Date(parseInt(m[3]),parseInt(m[2])-1,parseInt(m[1]));}
const capitalize = s => (s||"").replace(/\b\w/g, c => c.toUpperCase());

// ---------- WhatsApp helpers
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
async function sendStatusChoiceButtons(to,rowId){
  return sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"Esse lançamento já foi pago ou ainda está pendente?" },
      action:{
        buttons:[
          { type:"reply", reply:{ id:`SETSTATUS:${rowId}:pago`, title:"Pago" } },
          { type:"reply", reply:{ id:`SETSTATUS:${rowId}:pendente`, title:"Pendente" } },
        ]
      }
    }
  });
}

async function sendReportMenu(to){
  // 2 blocos para caber nos limites de botões do WhatsApp
  await sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{ type:"button", body:{ text:"Escolha o relatório:" },
      action:{ buttons:[
        { type:"reply", reply:{ id:"REPORT:vencidos", title:"Vencidos" } },
        { type:"reply", reply:{ id:"REPORT:pagos",    title:"Pagos" } },
        { type:"reply", reply:{ id:"REPORT:apagar",   title:"A Pagar" } },
      ]}
    }
  });
  await sendWA({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{ type:"button", body:{ text:"Ou veja tudo:" },
      action:{ buttons:[{ type:"reply", reply:{ id:"REPORT:completo", title:"Completo" } }]}
    }
  });
}

// Debug para admin via WhatsApp
async function sendAdminDebug(message){
  if (!DEBUG_SHEETS) return;
  const admin = (ADMIN_WA_NUMBER || "").trim();
  if (!admin) return;
  try { await sendText(admin, `🐞 DEBUG\n${message}`); } catch {}
}

// ---------- OpenAI (opcional, só para intenções se ativado)
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ---------- Google Sheets (compatível)
const doc = new GoogleSpreadsheet(SHEETS_ID);

async function ensureAuth(){
  if (!SHEETS_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_KEY) {
    const msg = "Variáveis de autenticação ausentes";
    console.error("❌ Falha na autenticação do Google Sheets:", msg);
    await sendAdminDebug(`Sheets auth error: ${msg}`);
    throw new Error(msg);
  }
  try{
    if (DEBUG_SHEETS) console.log("🔑 Autenticando no Google Sheets...");
    await doc.useServiceAccountAuth({
      client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: GOOGLE_SERVICE_ACCOUNT_KEY,
    });
    await doc.loadInfo();
    if (DEBUG_SHEETS) console.log(`✅ Planilha carregada: ${doc.title}`);
  }catch(e){
    console.error("❌ Falha na autenticação do Google Sheets:", e.message);
    await sendAdminDebug(`Sheets auth error: ${e.message}`);
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
    if (DEBUG_SHEETS) console.log("✅ Aba 'finplanner' criada.");
  }else{
    await sheet.loadHeaderRow();
    const current = sheet.headerValues || [];
    const missing = headers.filter(h => !current.includes(h));
    if (missing.length){
      await sheet.setHeaderRow([...current, ...missing]);
      if (DEBUG_SHEETS) console.log("🧩 Cabeçalhos adicionados:", missing.join(", "));
    } else {
      if (DEBUG_SHEETS) console.log("📄 Cabeçalhos OK.");
    }
  }
  return sheet;
}

// Acesso robusto a células (v3/v4)
function getVal(row, key){
  if (!row) return undefined;
  if (typeof row.get === "function") return row.get(key);
  if (key in row) return row[key];
  // fallback para _rawData, se existir
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
function saveRow(row){
  return (typeof row.save === "function") ? row.save() : Promise.resolve();
}
function getEffectiveDate(row){
  const iso = getVal(row, "vencimento_iso");
  const ts  = getVal(row, "timestamp");
  return iso ? new Date(iso) : (ts ? new Date(ts) : null);
}

// ---------- Parsing
function parseCurrencyBR(text){
  if(!text) return null;
  const t = (text + " ").replace(/\s+/g," ");
  // números sem "/" (para não confundir com datas); aceita "17" = R$17,00; 17,50; 1.234,56; com/sem R$
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
  const hasPix = /\b(pix|transfer[êe]ncia|transferir|enviei pix|fiz pix)\b/i.test(text||"");
  if(!hasPix) return null;
  const email=(text||"").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone=(text||"").match(/\+?\d{10,14}/);
  const guid =(text||"").match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);
  return email?.[0] || phone?.[0] || guid?.[0] || "";
}
function parseDueDate(text){
  const t = text || "";
  const now = new Date();
  // dd/mm(/yyyy)
  const dmY = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (dmY){
    let [_, d, m, y] = dmY;
    const Y = y ? (y.length===2 ? 2000 + parseInt(y) : parseInt(y)) : now.getFullYear();
    return new Date(Y, parseInt(m)-1, parseInt(d));
  }
  // "dia 20/10(/yyyy)"
  const dia = t.match(/\bdia\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i);
  if (dia){
    let [_, d, m, y] = dia;
    const Y = y ? (y.length===2 ? 2000 + parseInt(y) : parseInt(y)) : now.getFullYear();
    return new Date(Y, parseInt(m)-1, parseInt(d));
  }
  // palavras relativas
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

// ---------- Períodos
function parseInlineWindow(text, {defaultTo="month"} = {}){
  const t=(text||"").toLowerCase();
  if(/\bhoje\b/i.test(t)){
    const d = new Date();
    return { start: startOfDay(d), end: endOfDay(d), label: "hoje" };
  }
  if(/\b3\s*mes(es)?\b/i.test(t)){
    const end = endOfDay(new Date());
    const s = new Date(end); s.setMonth(s.getMonth()-2);
    const start = startOfMonth(s.getFullYear(), s.getMonth());
    return { start, end, label: "3meses" };
  }
  const range=t.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:a|até|ate|-)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if(range){
    const from=brToDate(range[1]), to=brToDate(range[2]);
    if(from&&to && (to-from)<=366*24*3600*1000) return { start:startOfDay(from), end:endOfDay(to), label: "range" };
  }
  const mm=t.match(/(\d{1,2})\/(\d{4})/);
  if(mm){
    const month=parseInt(mm[1])-1, year=parseInt(mm[2]);
    return { start: startOfMonth(year,month), end: endOfMonth(year,month), label: "mes" };
  }
  if(/\b(geral|completo|todos|tudo)\b/i.test(t)){
    const end = endOfDay(new Date());
    const start = new Date(end); start.setFullYear(start.getFullYear()-1);
    return { start, end, label: "geral" };
  }
  if (defaultTo==="month") {
    const now=new Date();
    return { start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()), label: "mes" };
  }
  const end = endOfDay(new Date());
  const start = new Date(end); start.setFullYear(start.getFullYear()-1);
  return { start, end, label: "geral" };
}

// ---------- Intenções (simples + robustas)
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
  if(/\b(pagar|pagamento|vou pagar|irei pagar|quitar|liquidar|pix\s+para|transferir|enviar)\b/i.test(lower)) return "nova_conta";
  if(/\b(receber|entrada|venda|ganhar|ganho|receita|recebi|ganhei|gastei|paguei|efetuei|enviei|fiz pix)\b/i.test(lower)) return "novo_movimento";
  return "desconhecido";
}

// ---------- Saldo mensal (considera somente pagos)
async function computeUserMonthlyBalance(sheet, userNorm){
  const rows = await sheet.getRows();
  const now = new Date();
  const mStart = startOfMonth(now.getFullYear(), now.getMonth());
  const mEnd   = endOfMonth(now.getFullYear(), now.getMonth());
  const mine = rows.filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm && getVal(r,"status")==="pago");
  const inMonth = mine.filter(r => { const d=getEffectiveDate(r); return d>=mStart && d<=mEnd; });
  const receitas = inMonth.filter(r => getVal(r,"tipo")==="conta_receber").reduce((a,r)=> a + parseFloat(getVal(r,"valor")||"0"), 0);
  const gastos   = inMonth.filter(r => getVal(r,"tipo")==="conta_pagar").reduce((a,r)=> a + parseFloat(getVal(r,"valor")||"0"), 0);
  return receitas - gastos;
}

// ---------- Mensagens
const MSG = {
  BOAS_VINDAS:
`👋 *Olá! Eu sou a FinPlanner IA.*

💡 *Organizo seus pagamentos, ganhos e gastos de forma simples e automática.*

Você pode me enviar mensagens como:

💰 *Registrar um pagamento*
→ \`Pagar internet R$120,00 amanhã\`
→ \`Paguei academia R$80,00 hoje\`
→ \`Academia 50\` *(já entendo sem verbo!)*

💸 *Registrar um recebimento*
→ \`Receber venda de óleo R$90,00 sexta\`
→ \`Ganhei R$300,00 hoje\`

📆 *Cadastrar conta fixa*
→ \`Conta fixa internet R$100,00 todo dia 01\`
→ \`Pagamento fixo aluguel R$850,00 todo dia 05\`

📋 *Ver movimentações*
→ \`Lançamentos de hoje\`
→ \`Meus lançamentos\` / \`Extrato\`

📊 *Relatórios*
→ \`Relatórios\` (Vencidos, Pagos, A Pagar, Completo)
→ \`Relatório do mês\` • \`Relatório 3 meses\`
→ \`Relatório 01/08/2025 a 30/09/2025\`
→ \`Relatório geral\` (últimos 12 meses)

🔔 *Eu te lembro dos vencimentos. Você também pode registrar gastos já pagos ou que acabou de pagar.*`,
  AJUDA:
`⚙️ *Funções da FinPlanner IA*

💰 *Pagamentos*
→ \`Pagar energia R$150,00 amanhã\`
→ \`Paguei gasolina R$80,00 hoje\`
→ \`Mercado 150\` (sem verbo)

💸 *Recebimentos*
→ \`Receber venda R$90,00 25/10/2025\`
→ \`Ganhei R$300,00 hoje\`

📆 *Contas Fixas*
→ \`Conta fixa internet R$100,00 todo dia 01\`
→ \`Excluir conta fixa internet\`

📅 *Listar*
→ \`Lançamentos de hoje\` / \`Meus lançamentos\`
→ \`Contas a pagar\`

📊 *Relatórios*
→ \`Relatórios\` (Vencidos, Pagos, A Pagar, Completo)
→ \`Relatório do mês\` / \`Relatório 3 meses\`
→ \`Relatório 10/2025\` • \`Relatório geral\`

✏️ *Editar último lançamento*
→ \`Editar valor 100\` • \`Alterar data 20/10/2025\`
→ \`Alterar status pago\` • \`Editar descrição academia\``,
  NAO_ENTENDI:
`🤔 *Não consegui entender sua mensagem.*

Experimente algo assim:

💰 \`Pagar aluguel R$800,00 05/11/2025\`
💸 \`Receber R$300,00 de João amanhã\`
📅 \`Contas a pagar\`
📊 \`Relatórios\`
⚙️ \`Funções\``,
};

function statusIconLabel(status){ return status==="pago" ? "✅ Pago" : "⏳ Pendente"; }
function formatLine(r){
  const tip = getVal(r,"tipo")==="conta_pagar" ? "Gasto" : "Receb.";
  const when = getVal(r,"vencimento_br") || "";
  const val = formatCurrencyBR(parseFloat(getVal(r,"valor")||"0"));
  return `• ${when || "—"} — ${tip} — ${getVal(r,"conta")} (${val}) — ${statusIconLabel(getVal(r,"status"))}`;
}

// ---------- Relatórios
function splitByStatusAndDate(itens){
  const today = startOfDay(new Date()).getTime();
  const vencidos = [], apagar = [], pagos = [];
  for (const r of itens){
    const d = getEffectiveDate(r); const dd = d ? startOfDay(d).getTime() : 0;
    const st = getVal(r,"status");
    if (st === "pago") { pagos.push(r); continue; }
    if (dd < today) vencidos.push(r);
    else apagar.push(r);
  }
  return { vencidos, apagar, pagos };
}

async function computeAndBuildReport(userNorm, rows, win, kind="completo"){
  const mine = rows
    .filter(r => (getVal(r,"user")||"").replace(/\D/g,"") === userNorm)
    .filter(r => withinRange(getEffectiveDate(r), win.start, win.end))
    .sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b));

  if (DEBUG_SHEETS){
    console.log(`🧮 computeAndBuildReport() rows totais: ${rows.length}, do usuário: ${mine.length}`);
    await sendAdminDebug(`Relatório: total ${rows.length}, do usuário ${mine.length} (${formatBRDate(win.start)} a ${formatBRDate(win.end)})`);
  }

  if (!mine.length) return "✅ Nenhum lançamento no período selecionado.";

  const { vencidos, apagar, pagos } = splitByStatusAndDate(mine);

  let msg = `📊 *Relatório (${formatBRDate(win.start)} a ${formatBRDate(win.end)})*\n\n`;

  if (kind === "vencidos" || kind === "completo") {
    msg += "📅 *Vencidos*\n";
    if (vencidos.length) vencidos.forEach(r => { msg += `${formatLine(r)}\n`; });
    else msg += "• Nenhum vencido\n";
    msg += "\n";
  }
  if (kind === "pagos" || kind === "completo") {
    msg += "💰 *Pagos*\n";
    if (pagos.length) pagos.forEach(r => { msg += `${formatLine(r)}\n`; });
    else msg += "• Nenhum pago\n";
    msg += "\n";
  }
  if (kind === "apagar" || kind === "completo") {
    msg += "⏳ *A Pagar / A Receber*\n";
    if (apagar.length) apagar.forEach(r => { msg += `${formatLine(r)}\n`; });
    else msg += "• Nenhum a pagar/receber\n";
    msg += "\n";
  }

  const now=new Date();
  if (win.start.getMonth()===now.getMonth() && win.start.getFullYear()===now.getFullYear()) {
    const sal = await computeUserMonthlyBalance(await ensureSheet(), userNorm);
    msg += `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(sal, true)}`;
  }

  return msg.trim();
}

// ---------- PENDENTES (listar numerado e confirmar)
async function listPendingPayments(userNorm){
  const sheet=await ensureSheet();
  const rows=await sheet.getRows();
  const mine=rows
    .filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm && getVal(r,"tipo")==="conta_pagar" && getVal(r,"status")!=="pago")
    .sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b));
  if (DEBUG_SHEETS){
    console.log(`🧾 listPendingPayments(): ${mine.length} pendentes`);
    await sendAdminDebug(`Pendentes: ${mine.length}`);
  }
  return mine;
}
async function showPendingWithNumbers(fromRaw, userNorm){
  const pend = await listPendingPayments(userNorm);
  if (!pend.length){
    await sendText(fromRaw,"✅ Você não tem contas a pagar no momento.");
    return;
  }
  let msg="📋 *Contas a pagar:*\n\n";
  pend.forEach((r, i)=>{
    const n=i+1;
    const nome=getVal(r,"conta")||"Conta";
    const val=formatCurrencyBR(parseFloat(getVal(r,"valor")||"0"));
    const data=getVal(r,"vencimento_br")||"—";
    msg += `${n}️⃣ ${nome} — ${val} — ${data}\n`;
  });

  const f=pend[0]; // usa a primeira para exemplo
  const exNome=getVal(f,"conta")||"Conta";
  const exVal=formatCurrencyBR(parseFloat(getVal(f,"valor")||"0"));
  const exData=getVal(f,"vencimento_br")||"";
  const exemplo = `${exNome} ${exVal}${exData?` dia ${exData}`:""}`;

  msg += `\n💡 Se quiser, me diga qual conta deseja confirmar o pagamento.\nEx: ${exemplo}\nOu envie apenas o número da conta (1, 2, 3…).`;
  await sendText(fromRaw, msg);
  return pend;
}
async function confirmPendingByNumber(fromRaw, userNorm, text){
  const m = (text||"").trim().match(/^\s*(\d{1,3})\s*$/);
  if(!m) return false;
  const idx = parseInt(m[1],10)-1;
  const pend = await listPendingPayments(userNorm);
  if(idx<0 || idx>=pend.length){
    await sendText(fromRaw, "⚠️ O número informado não corresponde a nenhuma conta.");
    return true;
  }
  const row=pend[idx];
  setVal(row,"status","pago");
  await saveRow(row);
  await sendText(fromRaw, `✅ O lançamento “${getVal(row,"conta")}” foi confirmado como pago.`);
  const saldo = await computeUserMonthlyBalance(await ensureSheet(), userNorm);
  await sendText(fromRaw, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
  return true;
}
async function confirmPendingByDescription(fromRaw, userNorm, text){
  const nomeMatch = (text||"").match(/confirmar pagamento\s+(.+)/i) || (text||"").match(/paguei\s+(.+)/i);
  if(!nomeMatch) return false;
  const tail = nomeMatch[1];
  const valor = parseCurrencyBR(tail);
  const data  = parseDueDate(tail);

  const sheet=await ensureSheet();
  const rows=await sheet.getRows();
  const pend=rows.filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm && getVal(r,"tipo")==="conta_pagar" && getVal(r,"status")!=="pago");

  const lc = (s)=> (s||"").toString().toLowerCase();
  let candidatos=pend.filter(r => lc(getVal(r,"conta")).includes(lc(tail)));
  if(!candidatos.length && valor!=null) candidatos = pend.filter(r => Math.abs(parseFloat(getVal(r,"valor")||"0")-valor) < 0.01);
  if(!candidatos.length && data) candidatos = pend.filter(r => {
    const d=getEffectiveDate(r); return d && startOfDay(d).getTime()===startOfDay(data).getTime();
  });

  if(!candidatos.length){
    await sendText(fromRaw,"🤔 Não encontrei esse lançamento.");
    await sendWA({ messaging_product:"whatsapp", to:fromRaw, type:"interactive",
      interactive:{ type:"button", body:{ text:"Você quer listar as contas a pagar?" },
        action:{ buttons:[{ type:"reply", reply:{ id:"LISTAR_PENDENTES", title:"Listar contas a pagar" } }]}}});
    return true;
  }

  const row=candidatos[0];
  setVal(row,"status","pago");
  await saveRow(row);
  await sendText(fromRaw, `✅ O lançamento “${getVal(row,"conta")}” foi confirmado como pago.`);
  const saldo = await computeUserMonthlyBalance(await ensureSheet(), userNorm);
  await sendText(fromRaw, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
  return true;
}

// ---------- Classificação sem verbo
function classifyWithoutVerb(text){
  const lower=(text||"").toLowerCase();
  const expenseWords = ["academia","aluguel","energia","luz","água","agua","internet","telefone","mercado","lanche","combustível","gasolina","iptu","ipva","condominio","feira","compras","cartão","cartao"];
  const incomeWords  = ["venda","comissão","comissao","salário","salario","ganho","ganhei","recebi","cliente","freela","entrada","receita"];
  let tipo="conta_pagar";
  if (incomeWords.some(w=>lower.includes(w))) tipo="conta_receber";
  else if (expenseWords.some(w=>lower.includes(w))) tipo="conta_pagar";
  return tipo;
}
function extractEntities(text, intent){
  const conta=guessBillName(text);
  const valor=parseCurrencyBR(text);
  const vencimento=parseDueDate(text);
  const pixKey=detectPixKey(text);
  const boleto=pixKey?null:detectBarcode(text);
  let tipo_pagamento="", codigo_pagamento="";
  if(pixKey){tipo_pagamento="pix";codigo_pagamento=pixKey;}
  else if(boleto){tipo_pagamento="boleto";codigo_pagamento=boleto;}

  const lower=(text||"").toLowerCase();
  const isFutureVerb = /\b(pagar|vou pagar|irei pagar|quitar|liquidar|enviar|transferir)\b/i.test(lower);
  const isPaidVerb   = /\b(paguei|efetuei|fiz|recebi|ganhei|gastei|transferi|enviei(?:\s+pix)?|pago)\b/i.test(lower);

  let tipo = (intent === "novo_movimento" || intent === "nova_conta") ? "conta_pagar" : "conta_pagar";
  if (intent === "novo_movimento") {
    if (/\b(recebi|ganhei|receber|entrada|venda|receita)\b/i.test(lower)) tipo = "conta_receber";
    if (/\b(gastei|paguei|pix\s+para|transferi|efetuei|fiz)\b/i.test(lower)) tipo = "conta_pagar";
  }
  if (!isFutureVerb && !isPaidVerb) { tipo = classifyWithoutVerb(text); }

  let status = null;
  if (pixKey) {
    status = "pago";
  } else if (isFutureVerb) {
    status = "pendente";
  } else if (isPaidVerb) {
    status = "pago";
  } else {
    if (vencimento) {
      const today = startOfDay(new Date()).getTime();
      const d = startOfDay(new Date(vencimento)).getTime();
      if (d > today) status = "pendente";
      else status = null; // hoje/passado sem verbo -> perguntar status
    } else {
      status = null; // sem data/sem verbo -> perguntar status
    }
  }
  return { conta, valor, vencimento, tipo_pagamento, codigo_pagamento, status, tipo };
}

// ---------- Edição simples (último lançamento)
async function handleEditLast(userNorm, fromRaw, text){
  const sheet = await ensureSheet();
  const rows = await sheet.getRows();
  const mine = rows.filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm);
  if (!mine.length) { await sendText(fromRaw, "✅ Nenhum lançamento encontrado para editar."); return; }
  mine.sort((a,b)=> new Date(getVal(b,"timestamp")) - new Date(getVal(a,"timestamp")));
  const row = mine[0];

  const newVal = parseCurrencyBR(text);
  if (newVal != null) { setVal(row,"valor", newVal); }

  const newDate = parseDueDate(text);
  if (newDate) {
    setVal(row,"vencimento_iso", toISODate(newDate));
    setVal(row,"vencimento_br", formatBRDate(newDate));
  }

  if (/\b(status\s+)?pago\b/i.test(text)) setVal(row,"status","pago");
  else if (/\b(status\s+)?pendente\b/i.test(text)) setVal(row,"status","pendente");

  const descMatch = text.match(/\b(descri[cç][aã]o|descricao|nome|t[ií]tulo|titulo)\s+(.+)/i);
  if (descMatch) setVal(row,"conta", capitalize(descMatch[2].trim()));

  await saveRow(row);

  const vf = formatCurrencyBR(parseFloat(getVal(row,"valor")||"0"));
  const df = getVal(row,"vencimento_br") || "";
  await sendText(fromRaw, `✅ Último lançamento atualizado:\n• Descrição: ${getVal(row,"conta")}\n• Valor: ${vf}\n• Data/Vencimento: ${df}\n• Status: ${statusIconLabel(getVal(row,"status"))}`);
}

// ---------- Principal
async function handleUserText(fromRaw, text){
  const userNorm = normalizeUser(fromRaw);
  const intent = await detectIntent(text);
  const sheet = await ensureSheet();

  // Debug: listagem rápida de linhas do usuário
  if (DEBUG_SHEETS){
    const rows = await sheet.getRows();
    const mine = rows.filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm);
    console.log(`👤 Usuário ${userNorm}: ${mine.length} linhas`);
    await sendAdminDebug(`Usuario ${userNorm}: ${mine.length} linhas`);
  }

  if (intent === "boas_vindas") { await sendText(fromRaw, MSG.BOAS_VINDAS); return; }
  if (intent === "funcoes") { await sendText(fromRaw, MSG.AJUDA); return; }
  if (intent === "relatorios_menu") { await sendReportMenu(fromRaw); return; }

  if (intent === "relatorio") {
    const win = parseInlineWindow(text, {defaultTo:"month"});
    const rows = await sheet.getRows();
    const msg = await computeAndBuildReport(userNorm, rows, win, "completo");
    await sendText(fromRaw, msg);
    await sendReportMenu(fromRaw);
    return;
  }

  if (intent === "listar_pendentes") { await showPendingWithNumbers(fromRaw, userNorm); return; }

  // Confirmar por número ou descrição (sempre tentar antes de qualquer fallback)
  if (await confirmPendingByNumber(fromRaw, userNorm, text)) return;
  if (await confirmPendingByDescription(fromRaw, userNorm, text)) return;

  if (intent === "responder_status_texto") {
    const rows = await sheet.getRows();
    const mine = rows.filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm);
    if (!mine.length) { await sendText(fromRaw, "✅ Nenhum lançamento encontrado."); return; }
    mine.sort((a,b)=> new Date(getVal(b,"timestamp")) - new Date(getVal(a,"timestamp")));
    const row = mine[0];
    const chosen = /^\s*pago\s*$/i.test(text) ? "pago" : "pendente";
    setVal(row,"status", chosen);
    await saveRow(row);
    if (chosen === "pago") {
      await sendText(fromRaw, "✅ Este lançamento foi registrado como pago.");
      const saldo = await computeUserMonthlyBalance(sheet, userNorm);
      await sendText(fromRaw, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
    } else {
      await sendText(fromRaw, "⏳ Mantido como pendente.");
    }
    return;
  }

  if (intent === "listar_lancamentos") {
    const win = parseInlineWindow(text, {defaultTo:"month"});
    const rows = await sheet.getRows();
    let itens = rows.filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm)
                    .filter(r => withinRange(getEffectiveDate(r), win.start, win.end))
                    .sort((a,b)=> getEffectiveDate(b) - getEffectiveDate(a));
    if (!itens.length) { await sendText(fromRaw, "✅ Nenhum lançamento encontrado."); return; }
    let msg = `📋 *Lançamentos (${formatBRDate(win.start)} a ${formatBRDate(win.end)})*:\n\n`;
    for (const r of itens) {
      const tip = getVal(r,"tipo")==="conta_pagar" ? "Gasto" : "Receb.";
      const when = getVal(r,"vencimento_br") || "";
      const val = formatCurrencyBR(parseFloat(getVal(r,"valor")||"0"));
      msg += `• ${when || "—"} — ${tip} — ${getVal(r,"conta")} (${val}) — ${statusIconLabel(getVal(r,"status"))}\n`;
    }
    msg += `\n🔎 Dica: envie *"Contas a pagar"* para confirmar por número.`;
    await sendText(fromRaw, msg.trim()); 
    return;
  }

  if (intent === "editar_lancamento") { await handleEditLast(userNorm, fromRaw, text); return; }

  // Cadastro padrão
  if (intent === "nova_conta" || intent === "novo_movimento" || intent === "desconhecido") {
    const { conta, valor, vencimento, tipo_pagamento, codigo_pagamento, status, tipo } = extractEntities(text, intent);
    const rowId = uuidShort();
    const finalStatus = status ?? "pendente"; // pergunta depois se for null

    const sheet2 = await ensureSheet();
    await sheet2.addRow({
      row_id: rowId,
      timestamp: new Date().toISOString(),
      user: userNorm,
      user_raw: fromRaw,
      tipo,
      conta,
      valor,
      vencimento_iso: toISODate(vencimento),
      vencimento_br: formatBRDate(vencimento),
      tipo_pagamento,
      codigo_pagamento,
      status: finalStatus,
      fixa: "",
      fix_parent_id: "",
      vencimento_dia: "",
    });

    const valorFmt = formatCurrencyBR(valor || 0);
    const dataStr  = formatBRDate(vencimento) || "";

    if (tipo === "conta_pagar") {
      await sendText(fromRaw, `🧾 *Lançamento registrado!*\n\n📘 Descrição: ${conta || "Lançamento"}\n💰 Valor: ${valorFmt}\n📅 Vencimento/Data: ${dataStr}\n${finalStatus==="pago" ? "✅ Status: Pago" : "⏳ Status: Pendente"}`);
      if (tipo_pagamento === "pix")    await sendCopyButton(fromRaw, "💳 Chave Pix:", codigo_pagamento, "Copiar Pix");
      if (tipo_pagamento === "boleto") await sendCopyButton(fromRaw, "🧾 Código de barras:", codigo_pagamento, "Copiar boleto");
      if (status === null) {
        // ⚠️ Conforme solicitado: NÃO enviar "Quando pagar, toque..." — apenas perguntar o status.
        await sendStatusChoiceButtons(fromRaw, rowId);
      }
    } else {
      await sendText(fromRaw, `💸 *Recebimento registrado!*\n\n📘 Descrição: ${conta || "Recebimento"}\n💰 Valor: ${valorFmt}\n📅 Data: ${dataStr}\n${finalStatus==="pago" ? "✅ Status: Pago" : "⏳ Status: Pendente"}`);
    }

    if (finalStatus === "pago") {
      const saldo = await computeUserMonthlyBalance(sheet2, userNorm);
      await sendText(fromRaw, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
    }

    return;
  }

  await sendText(fromRaw, MSG.NAO_ENTENDI);
}

// ---------- Webhook
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
              const id=m.interactive?.button_reply?.id;

              if(id==="LISTAR_PENDENTES"){ await showPendingWithNumbers(from, normalizeUser(from)); }

              if(id?.startsWith("SETSTATUS:")){
                const [, rowId, chosen] = id.split(":");
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const userNorm = normalizeUser(from);
                const row=rows.find(r=> getVal(r,"row_id")===rowId && (getVal(r,"user")||"").replace(/\D/g,"")===userNorm);
                if(row){
                  setVal(row,"status", chosen === "pago" ? "pago" : "pendente");
                  await saveRow(row);
                  if (chosen === "pago") {
                    await sendText(from, "✅ Este lançamento foi registrado como pago.");
                    const saldo = await computeUserMonthlyBalance(sheet, userNorm);
                    await sendText(from, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
                  } else {
                    await sendText(from, "⏳ Mantido como pendente.");
                  }
                } else {
                  await sendText(from, "⚠️ Não encontrei este lançamento.");
                }
              }

              if(id?.startsWith("REPORT:")){
                const kind = id.split("REPORT:")[1];
                await sendText(from, `✅ Mostrando *relatório ${kind}*`);
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const userNorm = normalizeUser(from);
                const win = parseInlineWindow("", {defaultTo:"month"});
                const msg = await computeAndBuildReport(userNorm, rows, win, kind);
                await sendText(from, msg);
              }
            }
          }
        }
      }
    }
    res.sendStatus(200);
  }catch(e){
    console.error("Erro no webhook:", e.message);
    await sendAdminDebug(`Webhook error: ${e.message}`);
    res.sendStatus(200);
  }
});

// ---------- CRON lembretes (30/30min) — usa user_raw quando disponível
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

    if (DEBUG_SHEETS){
      console.log(`⏰ CRON lembretes: ${due.length} lançamentos para hoje`);
      await sendAdminDebug(`CRON: ${due.length} lembretes hoje`);
    }

    for(const r of due){
      const toRaw=getVal(r,"user_raw") || getVal(r,"user");
      await sendText(toRaw, `⚠️ *Lembrete de pagamento!*\n\n📘 ${getVal(r,"conta")||"Conta"}\n💰 ${formatCurrencyBR(parseFloat(getVal(r,"valor")||"0"))}\n📅 Vence hoje (${formatBRDate(getVal(r,"vencimento_iso"))})`);
      if(getVal(r,"tipo_pagamento")==="pix")    await sendCopyButton(toRaw,"💳 Chave Pix:",getVal(r,"codigo_pagamento"),"Copiar Pix");
      if(getVal(r,"tipo_pagamento")==="boleto") await sendCopyButton(toRaw,"🧾 Código de barras:",getVal(r,"codigo_pagamento"),"Copiar boleto");
    }
  }catch(e){
    console.error("Erro no CRON:", e.message);
    await sendAdminDebug(`CRON error: ${e.message}`);
  }
});

// ---------- Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`FinPlanner IA v2025-10-21 (fix-reports+debug) rodando na porta ${PORT}`));
