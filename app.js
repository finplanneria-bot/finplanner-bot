// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-20.6)
// ============================
// Novidades nesta versão:
// - Normalização do número do usuário (normalizeUser) para gravação e filtros consistentes
// - Relatórios completos com botões interativos: Vencidos, Pagos, A Pagar, Completo
// - Confirmações ao tocar nos botões interativos
// - Interpretação natural (com e sem verbo), pergunta status quando necessário
// - Saldo do mês somente com lançamentos pagos (usa sinal – quando negativo)
// - Lembretes (CRON) com botões de copiar Pix/Boleto
// - Edição do último lançamento (valor, data, status, descrição)
// - Criação e validação automática de cabeçalhos na planilha
//
// Requisitos de ambiente (Render):
// SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_KEY
// WA_TOKEN, WA_PHONE_NUMBER_ID
// OPENAI_API_KEY (opcional), USE_OPENAI=true/false
//
// package.json deve ter: "type": "module"
// script start recomendado: "node --enable-source-maps app.js"

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

// ============== Helpers de ambiente / diagnóstico
console.log("🔧 FinPlanner boot:");
for (const k of ["SHEETS_ID","GOOGLE_SERVICE_ACCOUNT_EMAIL","GOOGLE_SERVICE_ACCOUNT_KEY","WA_TOKEN","WA_PHONE_NUMBER_ID","OPENAI_API_KEY","USE_OPENAI"]) {
  const v = process.env[k];
  console.log(`  ${k}:`, v ? (k==="GOOGLE_SERVICE_ACCOUNT_KEY" ? "✅ (set)" : v) : "❌ (missing)");
}

// ============== Normalização de usuário
const normalizeUser = (num) => (num || "").replace(/\D/g, "");

// ============== Config WhatsApp
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;

// ============== OpenAI (opcional)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_OPENAI = (process.env.USE_OPENAI || "false").toLowerCase() === "true";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ============== Google Sheets
const SHEETS_ID = process.env.SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}
const doc = new GoogleSpreadsheet(SHEETS_ID);

async function ensureAuth() {
  if (!SHEETS_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_KEY) {
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
    "vencimento_iso","vencimento_br","tipo_pagamento","codigo_pagamento","status"
  ];
  if (!sheet) {
    sheet = await doc.addSheet({ title: "finplanner", headerValues: headers });
    console.log("✅ Aba 'finplanner' criada com cabeçalhos.");
  } else {
    await sheet.loadHeaderRow();
    const current = sheet.headerValues || [];
    const missing = headers.filter(h => !current.includes(h));
    if (missing.length) {
      await sheet.setHeaderRow([...current, ...missing]);
      console.log("🧩 Cabeçalhos adicionados:", missing.join(", "));
    } else {
      console.log("📄 Cabeçalhos já existentes e completos.");
    }
  }
  return sheet;
}

// ============== Utils
const uuidShort = () => crypto.randomBytes(6).toString("hex");
const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = d => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
const startOfMonth = (y,m) => new Date(y, m, 1, 0,0,0,0);
const endOfMonth   = (y,m) => new Date(y, m+1, 0, 23,59,59,999);

function formatBRDate(d){ return d ? new Date(d).toLocaleDateString("pt-BR") : ""; } // pode retornar vazio
function toISODate(d){ if(!d) return ""; const x=new Date(d); x.setHours(0,0,0,0); return x.toISOString(); }
function formatCurrencyBR(v, showSign=false){
  const num = Number(v || 0);
  const sign = showSign && num < 0 ? "–" : "";
  const abs = Math.abs(num);
  return `${sign}R$${abs.toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2})}`;
}

function parseCurrencyBR(text){
  if(!text) return null;
  const clean = (text + " ").replace(/\s+/g, " ");
  // captura 17, 17,50, 120,00, R$ 99,90 — evita coincidir com datas 17/10
  const m = clean.match(/\b(?:r\$)?\s*(\d+(?:[.,]\d{1,2})?)(?!\/)\b/i);
  if(!m) return null;
  return parseFloat(m[1].replace(/\./g,"").replace(",", "."));
}

function detectBarcode(t){const m=(t||"").match(/[0-9.\s]{30,}/);return m?m[0].trim().replace(/\s+/g," "):null;}
function detectPixKey(t){
  const hasPix = /\b(pix|transfer[êe]ncia|transf\.)\b/i.test(t||"");
  if(!hasPix) return null;
  const email=(t||"").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone=(t||"").match(/\+?\d{10,14}/);
  const docid=(t||"").match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);
  return email?.[0]||phone?.[0]||docid?.[0]||"";
}

// Datas
function parseDueDate(text){
  const t = text || "";
  const now = new Date();

  // dd/mm[/aaaa]
  const dmY = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (dmY) {
    let [_, d, m, y] = dmY;
    const Y = y ? (y.length===2 ? 2000 + parseInt(y) : parseInt(y)) : now.getFullYear();
    return new Date(Y, parseInt(m)-1, parseInt(d));
  }

  // "dia 25/10[/aaaa]"
  const dia = t.match(/\bdia\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i);
  if (dia) {
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
  const labels=["energia","luz","água","agua","internet","aluguel","telefone","cartão","cartao","condominio","mercado","iptu","ipva","lanche","gasolina","academia","telegram","beatriz","pix","feira","compras"];
  const lower=(t||"").toLowerCase();
  for(const l of labels) if(lower.includes(l)) return l.charAt(0).toUpperCase()+l.slice(1);
  const who=(t||"").match(/\b(?:pra|para|ao|a|à|de)\s+([\wÁÉÍÓÚÂÊÔÃÕÇ]+)/i);
  return who ? capitalize(who[1]) : (capitalize(lower.split(/\s+/).slice(0,3).join(" ")) || "Lançamento");
}
const capitalize = s => (s||"").replace(/\b\w/g, c => c.toUpperCase());

function brToDate(s){const m=s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(!m)return null;return new Date(parseInt(m[3]),parseInt(m[2])-1,parseInt(m[1]));}
function formatMonthYear(d){const meses=["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"]; const dt=new Date(d); return `${meses[dt.getMonth()]} de ${dt.getFullYear()}`;}
function monthLabel(d=new Date()){const meses=["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"]; return meses[d.getMonth()];}
function withinRange(dt, start, end){ return dt && dt>=start && dt<=end; }
function getEffectiveDate(r){ return r.get("vencimento_iso") ? new Date(r.get("vencimento_iso")) : new Date(r.get("timestamp")); }

function parseInlineWindow(text, {defaultTo="month"} = {}){
  const t=(text||"").toLowerCase();

  if(/\bhoje\b/i.test(t)){
    const d = new Date();
    return { start: startOfDay(d), end: endOfDay(d), label: "hoje" };
  }
  if(/\b3\s*mes(es)?\b/i.test(t)){
    const end = endOfDay(new Date());
    const s = new Date(end);
    s.setMonth(s.getMonth()-2);
    const start = startOfMonth(s.getFullYear(), s.getMonth());
    return { start, end, label: "3meses" };
  }
  const m=t.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:a|até|ate|-)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if(m){
    const from=brToDate(m[1]), to=brToDate(m[2]);
    if(from&&to && (to-from)<=366*24*3600*1000) return { start:startOfDay(from), end:endOfDay(to), label: "range" };
  }
  if(/\b(geral|completo|todos|tudo)\b/i.test(t)){
    const end = endOfDay(new Date());
    const start = new Date(end);
    start.setFullYear(start.getFullYear()-1);
    return { start, end, label: "geral" };
  }
  const mm=t.match(/(\d{1,2})\/(\d{4})/);
  if(mm){
    const month=parseInt(mm[1])-1, year=parseInt(mm[2]);
    return { start: startOfMonth(year,month), end: endOfMonth(year,month), label: "mes" };
  }
  if (defaultTo==="month") {
    const now=new Date();
    return { start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()), label: "mes" };
  }
  const end = endOfDay(new Date());
  const start = new Date(end); start.setFullYear(start.getFullYear()-1);
  return { start, end, label: "geral" };
}

// ============== WhatsApp helpers
async function sendWA(p){try{await axios.post(WA_API,p,{headers:{Authorization:`Bearer ${WA_TOKEN}`,"Content-Type":"application/json"}});}catch(e){console.error("Erro WA:",e.response?.data||e.message);}}
async function sendText(to,body){return sendWA({messaging_product:"whatsapp",to,type:"text",text:{body}});}
async function sendCopyButton(to,title,code,btnTitle){
  if(!code)return;
  if(btnTitle.length>20)btnTitle=btnTitle.slice(0,20);
  return sendWA({messaging_product:"whatsapp",to,type:"interactive",
    interactive:{type:"button",body:{text:title},action:{buttons:[{type:"copy_code",copy_code:code,title:btnTitle}]}}});
}
async function sendConfirmButton(to,rowId){
  const title="Confirmar";
  return sendWA({messaging_product:"whatsapp",to,type:"interactive",
    interactive:{type:"button",body:{text:"Quando pagar, toque abaixo para confirmar:"},
    action:{buttons:[{type:"reply",reply:{id:`CONFIRMAR:${rowId}`,title:title}}]}}});
}
async function sendReportMenu(to){
  await sendWA({
    messaging_product:"whatsapp",
    to,
    type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"Escolha o relatório:" },
      action:{ buttons:[
        { type:"reply", reply:{ id:"REPORT:vencidos", title:"Vencidos" } },
        { type:"reply", reply:{ id:"REPORT:pagos",    title:"Pagos" } },
        { type:"reply", reply:{ id:"REPORT:apagar",   title:"A Pagar" } },
      ]}
    }
  });
  await sendWA({
    messaging_product:"whatsapp",
    to,
    type:"interactive",
    interactive:{
      type:"button",
      body:{ text:"Ou veja tudo:" },
      action:{ buttons:[
        { type:"reply", reply:{ id:"REPORT:completo", title:"Completo" } },
      ]}
    }
  });
}
async function sendStatusChoiceButtons(to,rowId){
  return sendWA({messaging_product:"whatsapp",to,type:"interactive",
    interactive:{type:"button",body:{text:"Esse lançamento já foi pago ou ainda está pendente?"},
    action:{buttons:[
      {type:"reply",reply:{id:`SETSTATUS:${rowId}:pago`,title:"Pago"}},
      {type:"reply",reply:{id:`SETSTATUS:${rowId}:pendente`,title:"Pendente"}},
    ]}}});
}

// ============== Intenções
async function detectIntent(t){
  const lower=(t||"").toLowerCase();
  if(/\b(oi|olá|ola|opa|bom dia|boa tarde|boa noite)\b/.test(lower)) return "boas_vindas";
  if(/\b(funções|funcoes|ajuda|help)\b/.test(lower)) return "funcoes";
  if(/\b(relat[óo]rios?)\b/.test(lower)) return "relatorios_menu";
  if(/\b(relat[óo]rio|resumo)\b/.test(lower)) return "relatorio";
  if(/^\s*(pago|pendente)\s*$/i.test(t||"")) return "responder_status_texto";
  if(/\b(editar|corrigir|alterar|atualizar)\b/i.test(lower)) return "editar_lancamento";
  if(/\b(lan[cç]amentos|meus lan[cç]amentos|lan[cç]amentos geral|registros|todos os lan[cç]amentos|extrato)\b/i.test(lower)) return "listar_lancamentos";
  if(/\b(categorias|gastos por categoria|listar categorias|categorias de gastos|categorias de ganhos)\b/i.test(lower)) return "listar_categorias";
  if(/\b(meus recebimentos|meus ganhos|listar recebimentos|mostrar recebimentos|ganhos)\b/i.test(lower)) return "listar_recebimentos";
  if(/\b(lan[cç]amentos de hoje)\b/i.test(lower)) return "listar_gastos_ext";
  if(/\b(pagar|pagamento|vou pagar|irei pagar|quitar|liquidar|pix\s+para|transferir|enviar)\b/i.test(lower)) return "nova_conta";
  if(/\b(receber|entrada|venda|ganhar|ganho|receita|recebi|ganhei|gastei|paguei|efetuei|enviei|fiz pix)\b/i.test(lower)) return "novo_movimento";

  if(USE_OPENAI&&openai){
    try{
      const r=await openai.responses.create({
        model:"gpt-4.1-mini",
        input:`Classifique: boas_vindas, funcoes, relatorios_menu, relatorio, responder_status_texto, editar_lancamento, listar_lancamentos, listar_categorias, listar_recebimentos, listar_gastos_ext, nova_conta, novo_movimento, fora_contexto.
Frase: ${t}`
      });
      const label=(r.output_text||"").trim().toLowerCase();
      const allowed=["boas_vindas","funcoes","relatorios_menu","relatorio","responder_status_texto","editar_lancamento","listar_lancamentos","listar_categorias","listar_recebimentos","listar_gastos_ext","nova_conta","novo_movimento","fora_contexto"];
      if(allowed.includes(label)) return label;
    }catch{}
  }
  return "desconhecido";
}

// Sem verbo ⇒ classificar por palavras usuais
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
  if (!isFutureVerb && !isPaidVerb) {
    tipo = classifyWithoutVerb(text);
  }

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
      else status = null; // hoje/ontem ⇒ perguntar
    } else {
      status = null; // perguntar
    }
  }

  return { conta, valor, vencimento, tipo_pagamento, codigo_pagamento, status, tipo };
}

async function computeUserMonthlyBalance(sheet, userNorm){
  const rows = await sheet.getRows();
  const now = new Date();
  const mStart = startOfMonth(now.getFullYear(), now.getMonth());
  const mEnd   = endOfMonth(now.getFullYear(), now.getMonth());

  const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===userNorm && r.get("status")==="pago");

  const inMonth = mine.filter(r => {
    const d = r.get("vencimento_iso") ? new Date(r.get("vencimento_iso")) : new Date(r.get("timestamp"));
    return d >= mStart && d <= mEnd;
  });

  const receitas = inMonth.filter(r => r.get("tipo")==="conta_receber").reduce((a,r)=> a + parseFloat(r.get("valor")||"0"), 0);
  const gastos   = inMonth.filter(r => r.get("tipo")==="conta_pagar").reduce((a,r)=> a + parseFloat(r.get("valor")||"0"), 0);

  return receitas - gastos;
}

// ============== Mensagens padrão
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

📋 *Ver movimentações*
→ \`Lançamentos de hoje\`
→ \`Meus lançamentos\` / \`Extrato\`

📊 *Relatórios*
→ \`Relatórios\` (você escolhe *Vencidos*, *Pagos*, *A Pagar* ou *Completo*)
→ \`Relatório do mês\`
→ \`Relatório 3 meses\`
→ \`Relatório 01/08/2025 a 30/09/2025\`
→ \`Relatório geral\` (últimos 12 meses)

🔔 *Eu te lembro dos vencimentos. Você também pode registrar gastos já pagos ou que acabou de pagar.*`,
  AJUDA:
`⚙️ *Funções da FinPlanner IA*

💰 *Registrar pagamentos*
→ \`Pagar energia R$150,00 amanhã\`
→ \`Pix 12,95 lanche\` (já pago)
→ \`Academia 50\` (sem verbo)

💸 *Registrar recebimentos*
→ \`Receber venda de óleo R$90,00 25/10/2025\`
→ \`Ganhei R$300,00 hoje\`

📅 *Listar*
→ \`Lançamentos de hoje\` / \`Meus lançamentos\`
→ \`Categorias\` / \`Categorias 3 meses\`

📊 *Relatórios*
→ \`Relatórios\` (Vencidos, Pagos, A Pagar ou Completo)
→ \`Relatório do mês\` / \`Relatório 3 meses\`
→ \`Relatório 10/2025\`
→ \`Relatório 01/08/2025 a 30/09/2025\`
→ \`Relatório geral\`

✏️ *Editar último lançamento*
→ \`Editar valor 100\` • \`Alterar data 20/10/2025\`
→ \`Alterar status pago\` • \`Editar descrição academia mensal\``,
  NAO_ENTENDI:
`🤔 *Não consegui entender sua mensagem.*

Experimente algo assim:

💰 \`Pagar aluguel R$800,00 05/11/2025\`
💸 \`Receber R$300,00 de João amanhã\`
📅 \`Lançamentos de hoje\`
📊 \`Relatórios\`
⚙️ \`Funções\``,
};

function statusIconLabel(status){ return status==="pago" ? "✅ Pago" : "⏳ Pendente"; }

function splitByStatusAndDate(itens){
  const today = startOfDay(new Date()).getTime();
  const vencidos = [];
  const apagar   = [];
  const pagos    = [];
  for (const r of itens){
    const d = r.get("vencimento_iso") ? startOfDay(new Date(r.get("vencimento_iso"))).getTime() : startOfDay(new Date(r.get("timestamp"))).getTime();
    const st = r.get("status");
    if (st === "pago") { pagos.push(r); continue; }
    if (d < today) vencidos.push(r);
    else apagar.push(r);
  }
  return { vencidos, apagar, pagos };
}

function formatLine(r){
  const tip = r.get("tipo")==="conta_pagar" ? "Gasto" : "Receb.";
  const when = r.get("vencimento_br") || "";
  const val = formatCurrencyBR(parseFloat(r.get("valor")||"0"));
  return `• ${when || "—"} — ${tip} — ${r.get("conta")} (${val}) — ${statusIconLabel(r.get("status"))}`;
}

async function buildReportMessage(userNorm, rows, win, kind="completo"){
  const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===userNorm)
                   .filter(r => withinRange(getEffectiveDate(r), win.start, win.end))
                   .sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b));

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

// ============== Edição do último lançamento
async function handleEditLast(userNorm, fromRaw, text){
  const sheet = await ensureSheet();
  const rows = await sheet.getRows();
  const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===userNorm);
  if (!mine.length) { await sendText(fromRaw, "✅ Nenhum lançamento encontrado para editar."); return; }

  mine.sort((a,b)=> new Date(b.get("timestamp")) - new Date(a.get("timestamp")));
  const row = mine[0];

  const newVal = parseCurrencyBR(text);
  if (newVal != null) { row.set("valor", newVal); }

  const newDate = parseDueDate(text);
  if (newDate) {
    row.set("vencimento_iso", toISODate(newDate));
    row.set("vencimento_br", formatBRDate(newDate));
  }

  if (/\b(status\s+)?pago\b/i.test(text)) row.set("status","pago");
  else if (/\b(status\s+)?pendente\b/i.test(text)) row.set("status","pendente");

  const descMatch = text.match(/\b(descri[cç][aã]o|descricao|nome|t[ií]tulo|titulo)\s+(.+)/i);
  if (descMatch) row.set("conta", capitalize(descMatch[2].trim()));

  await row.save();

  const vf = formatCurrencyBR(parseFloat(row.get("valor")||"0"));
  const df = row.get("vencimento_br") || "";
  await sendText(fromRaw, `✅ Último lançamento atualizado:\n• Descrição: ${row.get("conta")}\n• Valor: ${vf}\n• Data/Vencimento: ${df}\n• Status: ${statusIconLabel(row.get("status"))}`);
}

// ============== Principal
async function handleUserText(fromRaw, text){
  const userNorm = normalizeUser(fromRaw);
  const intent = await detectIntent(text);
  const sheet = await ensureSheet();

  // Boas-vindas / ajuda
  if (intent === "boas_vindas") { await sendText(fromRaw, MSG.BOAS_VINDAS); return; }
  if (intent === "funcoes") { await sendText(fromRaw, MSG.AJUDA); return; }

  // Menu de relatórios
  if (intent === "relatorios_menu") { await sendReportMenu(fromRaw); return; }

  // Relatório texto
  if (intent === "relatorio") {
    const win = parseInlineWindow(text, {defaultTo:"month"});
    const rows = await sheet.getRows();
    const msg = await buildReportMessage(userNorm, rows, win, "completo");
    await sendText(fromRaw, msg);
    await sendReportMenu(fromRaw);
    return;
  }

  // Responder "Pago"/"Pendente" digitado manualmente para último lançamento
  if (intent === "responder_status_texto") {
    const rows = await sheet.getRows();
    const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===userNorm);
    if (!mine.length) { await sendText(fromRaw, "✅ Nenhum lançamento encontrado."); return; }
    mine.sort((a,b)=> new Date(b.get("timestamp")) - new Date(a.get("timestamp")));
    const row = mine[0];
    const chosen = /^\s*pago\s*$/i.test(text) ? "pago" : "pendente";
    row.set("status", chosen);
    await row.save();
    if (chosen === "pago") {
      await sendText(fromRaw, "✅ Marcado como pago!");
      const saldo = await computeUserMonthlyBalance(sheet, userNorm);
      await sendText(fromRaw, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
    } else {
      await sendText(fromRaw, "⏳ Mantido como pendente.");
    }
    return;
  }

  // Listagens
  if (intent === "listar_lancamentos") {
    const win = parseInlineWindow(text, {defaultTo:"month"});
    const rows = await sheet.getRows();
    let itens = rows.filter(r => typeof r.get==="function" && r.get("user")===userNorm)
                    .filter(r => withinRange(getEffectiveDate(r), win.start, win.end))
                    .sort((a,b)=> getEffectiveDate(b) - getEffectiveDate(a));

    if (!itens.length) { await sendText(fromRaw, "✅ Nenhum lançamento encontrado."); return; }

    let msg = `📋 *Lançamentos (${formatBRDate(win.start)} a ${formatBRDate(win.end)})*:\n\n`;
    for (const r of itens) {
      const tip = r.get("tipo")==="conta_pagar" ? "Gasto" : "Receb.";
      const when = r.get("vencimento_br") || "";
      const val = formatCurrencyBR(parseFloat(r.get("valor")||"0"));
      msg += `• ${when || "—"} — ${tip} — ${r.get("conta")} (${val}) — ${statusIconLabel(r.get("status"))}\n`;
    }
    msg += `\n🔎 Dica: envie *"Relatórios"* para ver filtros prontos.`;
    await sendText(fromRaw, msg.trim()); 
    return;
  }

  if (intent === "listar_categorias") {
    const { start, end } = parseInlineWindow(text, {defaultTo:"month"});
    const rows = await sheet.getRows();
    const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===userNorm)
                     .filter(r => withinRange(getEffectiveDate(r), start, end));

    const gastos = mine.filter(r => r.get("tipo")==="conta_pagar");
    const ganhos = mine.filter(r => r.get("tipo")==="conta_receber");

    const toMap = (arr) => {
      const map={};
      for(const r of arr){ const k=r.get("conta")||"Outros"; const v=parseFloat(r.get("valor")||"0"); map[k]=(map[k]||0)+v; }
      return Object.entries(map).map(([conta,total])=>({conta,total})).filter(x=>x.total>0).sort((a,b)=>b.total-a.total);
    };

    const totG = toMap(gastos);
    const totR = toMap(ganhos);

    const title = `🏷️ *Categorias (${formatBRDate(start)} a ${formatBRDate(end)})*`;

    if (!totG.length && !totR.length) { await sendText(fromRaw, `${title}\n\n✅ Nenhum lançamento no período.`); return; }

    let msg = `${title}\n\n`;
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

    msg += `ℹ️ Você pode pedir: *"Relatórios"* para ver Vencidos, Pagos, A Pagar e Completo.`;
    await sendText(fromRaw, msg.trim());
    return;
  }

  if (intent === "editar_lancamento") { await handleEditLast(userNorm, fromRaw, text); return; }

  // Cadastro genérico
  if (intent === "nova_conta" || intent === "novo_movimento" || intent === "desconhecido") {
    const { conta, valor, vencimento, tipo_pagamento, codigo_pagamento, status, tipo } = extractEntities(text, intent);
    const rowId = uuidShort();
    const finalStatus = status ?? "pendente";

    const sheet2 = await ensureSheet();
    await sheet2.addRow({
      row_id: rowId,
      timestamp: new Date().toISOString(),
      user: userNorm,
      tipo,
      conta,
      valor,
      vencimento_iso: toISODate(vencimento),
      vencimento_br: formatBRDate(vencimento),
      tipo_pagamento,
      codigo_pagamento,
      status: finalStatus,
    });

    const valorFmt = formatCurrencyBR(valor || 0);
    const dataStr  = formatBRDate(vencimento) || ""; // se não houver data, fica vazio

    if (tipo === "conta_pagar") {
      await sendText(fromRaw, `🧾 *Lançamento registrado!*\n\n📘 Descrição: ${conta || "Lançamento"}\n💰 Valor: ${valorFmt}\n📅 Vencimento/Data: ${dataStr}\n${finalStatus==="pago" ? "✅ Status: Pago" : "⏳ Status: Pendente"}`);
      if (tipo_pagamento === "pix")    await sendCopyButton(fromRaw, "💳 Chave Pix:", codigo_pagamento, "Copiar Pix");
      if (tipo_pagamento === "boleto") await sendCopyButton(fromRaw, "🧾 Código de barras:", codigo_pagamento, "Copiar boleto");
      if (finalStatus !== "pago") await sendConfirmButton(fromRaw, rowId);
    } else {
      await sendText(fromRaw, `💸 *Recebimento registrado!*\n\n📘 Descrição: ${conta || "Recebimento"}\n💰 Valor: ${valorFmt}\n📅 Data: ${dataStr}\n${finalStatus==="pago" ? "✅ Status: Pago" : "⏳ Status: Pendente"}`);
    }

    if (status === null) {
      await sendStatusChoiceButtons(fromRaw, rowId);
    }

    if (finalStatus === "pago") {
      const saldo = await computeUserMonthlyBalance(sheet2, userNorm);
      await sendText(fromRaw, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
    }

    return;
  }

  // Fallback
  await sendText(fromRaw, MSG.NAO_ENTENDI);
}

// ============== Webhook (GET verifica / POST recebe)
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
          for(const m of c.value?.messages || []){
            const from=m.from;
            if(m.type==="text") await handleUserText(from, m.text?.body || "");
            if(m.type==="interactive"){
              const id=m.interactive?.button_reply?.id;

              if(id?.startsWith("CONFIRMAR:")){
                const rowId=id.split("CONFIRMAR:")[1];
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const userNorm = normalizeUser(from);
                const row=rows.find(r=>typeof r.get==="function"&&r.get("row_id")===rowId && r.get("user")===userNorm);
                if(row){
                  row.set("status","pago");
                  await row.save();
                  await sendText(from, "✅ *Pagamento confirmado!*");
                  const saldo = await computeUserMonthlyBalance(sheet, userNorm);
                  await sendText(from, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
                } else {
                  await sendText(from, "⚠️ Não encontrei este lançamento para confirmar.");
                }
              }

              if(id?.startsWith("SETSTATUS:")){
                const [, rowId, chosen] = id.split(":");
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const userNorm = normalizeUser(from);
                const row=rows.find(r=>typeof r.get==="function"&&r.get("row_id")===rowId && r.get("user")===userNorm);
                if(row){
                  row.set("status", chosen === "pago" ? "pago" : "pendente");
                  await row.save();
                  if (chosen === "pago") {
                    await sendText(from, "✅ *Marcado como pago!*");
                    const saldo = await computeUserMonthlyBalance(sheet, userNorm);
                    await sendText(from, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
                  } else {
                    await sendText(from, "⏳ *Mantido como pendente.*");
                  }
                } else {
                  await sendText(from, "⚠️ Não encontrei este lançamento.");
                }
              }

              if(id?.startsWith("REPORT:")){
                const kind = id.split("REPORT:")[1]; // vencidos | pagos | apagar | completo
                await sendText(from, `✅ Mostrando *relatório ${kind}*`);
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const userNorm = normalizeUser(from);
                const win = parseInlineWindow("", {defaultTo:"month"});
                const msg = await buildReportMessage(userNorm, rows, win, kind);
                await sendText(from, msg);
              }
            }
          }
        }
      }
    }
    res.sendStatus(200);
  }catch(e){ console.error("Erro no webhook:", e.message); res.sendStatus(200); }
});

// ============== CRON lembretes (30/30min)
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
      const toRaw=to; // já salvo como normalizado; WA exige com DDI, mas aqui estamos enviando para o mesmo from que veio antes; se necessário, guarde também o formato raw
      await sendText(toRaw, `⚠️ *Lembrete de pagamento!*\n\n📘 ${r.get("conta")||"Conta"}\n💰 ${formatCurrencyBR(parseFloat(r.get("valor")||"0"))}\n📅 Vence hoje (${formatBRDate(r.get("vencimento_iso"))})`);
      if(r.get("tipo_pagamento")==="pix")    await sendCopyButton(toRaw,"💳 Chave Pix:",r.get("codigo_pagamento"),"Copiar Pix");
      if(r.get("tipo_pagamento")==="boleto") await sendCopyButton(toRaw,"🧾 Código de barras:",r.get("codigo_pagamento"),"Copiar boleto");
    }
  }catch(e){ console.error("Erro no CRON:", e.message); }
});

// ============== Inicialização
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`FinPlanner IA v2025-10-20.6 rodando na porta ${PORT}`));
