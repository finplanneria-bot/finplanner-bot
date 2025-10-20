// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-20.4)
// ============================
// Recursos completos (vide descrição no topo do arquivo)

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

// Diagnóstico mínimo
console.log("🔍 FinPlanner env:");
console.log("SHEETS_ID:", process.env.SHEETS_ID ? "✅" : "❌");
console.log("GOOGLE_SERVICE_ACCOUNT_EMAIL:", process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "❌");
console.log("GOOGLE_SERVICE_ACCOUNT_KEY:", process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? "✅" : "❌");
console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "✅" : "❌");
console.log("USE_OPENAI:", process.env.USE_OPENAI);

// WhatsApp Cloud API
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;

// OpenAI (opcional)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_OPENAI = (process.env.USE_OPENAI || "false").toLowerCase() === "true";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Google Sheets
const SHEETS_ID = process.env.SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\n/g, "\n").replace(/\\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n").replace(/\n/g, "\n");
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

// Utils
const uuidShort = () => crypto.randomBytes(6).toString("hex");
const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = d => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
const startOfMonth = (y,m) => new Date(y, m, 1, 0,0,0,0);
const endOfMonth   = (y,m) => new Date(y, m+1, 0, 23,59,59,999);

function formatBRDate(d){ return d ? new Date(d).toLocaleDateString("pt-BR") : ""; } // pode retornar vazio
function toISODate(d){ if(!d) return ""; const x=new Date(d); x.setHours(0,0,0,0); return x.toISOString(); }
function formatCurrencyBR(v, showSign=false){
  const sign = showSign && Number(v) < 0 ? "–" : "";
  const abs = Math.abs(Number(v||0));
  return `${sign}R$${abs.toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2})}`;
}

// Aceita 17 -> R$17,00 | 17,50 -> R$17,50 | R$ 120,00 | evita datas 17/10
function parseCurrencyBR(text){
  if(!text) return null;
  const clean = text.replace(/\s+/g, " ");
  const m = clean.match(/\b(?:r\$)?\s*(\d+(?:[.,]\d{2})?)(?!\/)\b/i);
  if(!m) return null;
  let val = m[1].replace(/\./g,"").replace(",","."); // 1.234,56 -> 1234.56
  return parseFloat(val);
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
  const now=new Date();
  const dmY=(text||"").match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if(dmY){let[_,d,m,y]=dmY;const Y=y? (y.length===2?2000+parseInt(y):parseInt(y)):now.getFullYear();return new Date(Y,parseInt(m)-1,parseInt(d));}
  const dia=(text||"").match(/\bdia\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i);
  if(dia){let[_,d,m,y]=dia;const Y=y? (y.length===2?2000+parseInt(y):parseInt(y)):now.getFullYear();return new Date(Y,parseInt(m)-1,parseInt(d));}
  if(/\bontem\b/i.test(text||"")){const d=new Date(now);d.setDate(d.getDate()-1);return d;}
  if(/\bhoje\b/i.test(text||"")) return now;
  if(/\bamanh[aã]\b/i.test(text||"")){const d=new Date(now);d.setDate(d.getDate()+1);return d;}
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

// WhatsApp helpers
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

// Intenções
async function detectIntent(t){
  const lower=(t||"").toLowerCase();
  if(/\b(oi|olá|ola|opa|bom dia|boa tarde|boa noite)\b/.test(lower)) return "boas_vindas";
  if(/\b(funções|funcoes|ajuda|help)\b/.test(lower)) return "funcoes";
  if(/\b(relat[óo]rios?|ver lan[cç]amentos|meus pagamentos|meus gastos)\b/i.test(lower)) return "relatorios_menu";
  if(/\b(meus recebimentos|meus ganhos|listar recebimentos|mostrar recebimentos|ganhos)\b/i.test(lower)) return "listar_recebimentos";
  if(/\b(lan[cç]amentos de hoje)\b/i.test(lower)) return "listar_gastos_ext";
  if(/\b(lan[cç]amentos|meus lan[cç]amentos|lan[cç]amentos geral|registros|todos os lan[cç]amentos|extrato)\b/i.test(lower)) return "listar_lancamentos";
  if(/\b(categorias|gastos por categoria|listar categorias|categorias de gastos|categorias de ganhos)\b/i.test(lower)) return "listar_categorias";
  if(/\b(relat[óo]rio|resumo)\b/i.test(lower)) return "relatorio";
  if(/\b(editar|corrigir|alterar|atualizar)\b/i.test(lower)) return "editar_lancamento";
  if(/\b(pagar|pagamento|vou pagar|irei pagar|quitar|liquidar|pix\s+para|transferir|enviar)\b/i.test(lower)) return "nova_conta";
  if(/\b(receber|entrada|venda|ganhar|ganho|receita|recebi|ganhei|gastei|paguei|efetuei|enviei|fiz pix)\b/i.test(lower)) return "novo_movimento";

  if(USE_OPENAI&&openai){
    try{
      const r=await openai.responses.create({
        model:"gpt-4.1-mini",
        input:`Classifique: boas_vindas, funcoes, relatorios_menu, listar_recebimentos, listar_gastos_ext, listar_lancamentos, listar_categorias, relatorio, editar_lancamento, nova_conta, novo_movimento, fora_contexto.
Frase: ${t}`
      });
      const label=(r.output_text||"").trim().toLowerCase();
      if(["boas_vindas","funcoes","relatorios_menu","listar_recebimentos","listar_gastos_ext","listar_lancamentos","listar_categorias","relatorio","editar_lancamento","nova_conta","novo_movimento","fora_contexto"].includes(label))
        return label;
    }catch{}
  }
  return "desconhecido";
}

// Classificação sem verbo
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
      else status = null;
    } else {
      status = null;
    }
  }

  return { conta, valor, vencimento, tipo_pagamento, codigo_pagamento, status, tipo };
}

async function computeUserMonthlyBalance(sheet, user){
  const rows = await sheet.getRows();
  const now = new Date();
  const mStart = startOfMonth(now.getFullYear(), now.getMonth());
  const mEnd   = endOfMonth(now.getFullYear(), now.getMonth());

  const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===user && r.get("status")==="pago");

  const inMonth = mine.filter(r => {
    const d = r.get("vencimento_iso") ? new Date(r.get("vencimento_iso")) : new Date(r.get("timestamp"));
    return d >= mStart && d <= mEnd;
  });

  const receitas = inMonth.filter(r => r.get("tipo")==="conta_receber").reduce((a,r)=> a + parseFloat(r.get("valor")||"0"), 0);
  const gastos   = inMonth.filter(r => r.get("tipo")==="conta_pagar").reduce((a,r)=> a + parseFloat(r.get("valor")||"0"), 0);

  return receitas - gastos;
}

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
  CONTA_OK: (conta, valorFmt, dataStr, status) =>
`🧾 *Lançamento registrado!*

📘 Descrição: ${conta || "Lançamento"}
💰 Valor: ${valorFmt}
📅 Vencimento/Data: ${dataStr}
${status==="pago" ? "✅ Status: Pago" : "⏳ Status: Pendente"}`,
  RECEB_OK: (conta, valorFmt, dataStr, status) =>
`💸 *Recebimento registrado!*

📘 Descrição: ${conta || "Recebimento"}
💰 Valor: ${valorFmt}
📅 Data: ${dataStr}
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

function statusIconLabel(status){ return status==="pago" ? "✅ Pago" : "⏳ Pendente"; }

function parseReportQuery(tRaw){
  const t = (tRaw||"").toLowerCase();

  let filter="all";
  if(/\b(gastos|despesas|pagamentos|contas a pagar)\b/i.test(t)) filter="gastos";
  if(/\b(ganhos|receitas|entradas|recebimentos)\b/i.test(t)) filter="ganhos";

  if(/\b(geral|completo|todos|tudo)\b/i.test(t)){
    const end = endOfDay(new Date());
    const start = new Date(end); start.setFullYear(start.getFullYear()-1);
    return { type:"range", start, end, filter };
  }

  if(/\b3\s*mes(es)?\b/i.test(t)){
    const end = endOfDay(new Date());
    const s = new Date(end); s.setMonth(s.getMonth()-2);
    const start = startOfMonth(s.getFullYear(), s.getMonth());
    return { type:"range", start, end, filter };
  }

  const reRange=/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:a|até|ate|-)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i;
  const m=t.match(reRange);
  if(m){
    const from=brToDate(m[1]); const to=brToDate(m[2]);
    if(from && to && (to - from) <= 366*24*3600*1000) return { type:"range", start: startOfDay(from), end: endOfDay(to), filter };
    return null;
  }

  if(/\b(do m[eê]s|m[eê]s atual)\b/i.test(t)){
    const now=new Date(); const start=startOfMonth(now.getFullYear(), now.getMonth()); const end=endOfMonth(now.getFullYear(), now.getMonth());
    return { type:"monthly", start, end, filter };
  }

  const reMonth=/(?:m[eê]s\s*)?(\d{1,2})\/(\d{4})/i;
  const mm=t.match(reMonth);
  if(mm){
    const month=parseInt(mm[1])-1, year=parseInt(mm[2]);
    return { type:"monthly", start: startOfMonth(year,month), end: endOfMonth(year,month), filter };
  }

  const now=new Date(); return { type:"monthly", start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()), filter };
}

function buildCategoryTotals(rows){
  const map = {};
  for(const r of rows){
    const nome = r.get("conta") || "Outros";
    const val  = parseFloat(r.get("valor")||"0");
    map[nome] = (map[nome]||0) + val;
  }
  return Object.entries(map)
    .map(([conta, total])=>({conta,total}))
    .filter(x => x.total > 0)
    .sort((a,b)=> b.total - a.total);
}

async function handleEditLast(from, text){
  const sheet = await ensureSheet();
  const rows = await sheet.getRows();
  const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===from);
  if (!mine.length) { await sendText(from, "✅ Nenhum lançamento encontrado para editar."); return; }

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
  await sendText(from, `✅ Último lançamento atualizado:\n• Descrição: ${row.get("conta")}\n• Valor: ${vf}\n• Data/Vencimento: ${df}\n• Status: ${statusIconLabel(row.get("status"))}`);
}

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

async function buildReportMessage(from, rows, win, kind="completo"){
  const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===from)
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
    const sal = await computeUserMonthlyBalance(await ensureSheet(), from);
    msg += `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(sal, true)}`;
  }

  return msg.trim();
}

async function handleUserText(from, text){
  const intent = await detectIntent(text);
  const sheet = await ensureSheet();

  if (intent === "boas_vindas") { await sendText(from, MSG.BOAS_VINDAS); return; }
  if (intent === "funcoes") { await sendText(from, MSG.AJUDA); return; }

  if (intent === "relatorios_menu") {
    await sendReportMenu(from);
    return;
  }

  if (intent === "listar_recebimentos") {
    const win = parseInlineWindow(text, {defaultTo:"month"});
    const rows = await sheet.getRows();
    const recs = rows
      .filter(r => typeof r.get==="function" && r.get("user")===from && r.get("tipo")==="conta_receber" && r.get("status")!=="pago")
      .filter(r => withinRange(getEffectiveDate(r), win.start, win.end))
      .map(r => ({ conta: r.get("conta"), valor: parseFloat(r.get("valor")||"0"), ven: r.get("vencimento_iso")? new Date(r.get("vencimento_iso")): null, st:r.get("status") }))
      .sort((a,b)=> (a.ven?.getTime()||0)-(b.ven?.getTime()||0));
    if(!recs.length){ await sendText(from, MSG.LISTA_REC_VAZIA); return; }
    let msg=`📋 *Recebimentos futuros* (${formatBRDate(win.start)} a ${formatBRDate(win.end)}):\n\n`;
    for(const p of recs){ msg += `• ${formatBRDate(p.ven)} — ${p.conta} (${formatCurrencyBR(p.valor)}) — ${statusIconLabel(p.st)}\n`; }
    await sendText(from, msg.trim()); return;
  }

  if (intent === "listar_gastos_ext" || intent === "listar_lancamentos") {
    const win = parseInlineWindow(text, {defaultTo:"month"});
    const rows = await sheet.getRows();
    let itens = rows.filter(r => typeof r.get==="function" && r.get("user")===from)
                    .filter(r => withinRange(getEffectiveDate(r), win.start, win.end))
                    .sort((a,b)=> getEffectiveDate(b) - getEffectiveDate(a));

    if (!itens.length) { await sendText(from, "✅ Nenhum lançamento encontrado."); return; }

    let msg = `📋 *Lançamentos (${formatBRDate(win.start)} a ${formatBRDate(win.end)})*:\n\n`;
    for (const r of itens) {
      const tip = r.get("tipo")==="conta_pagar" ? "Gasto" : "Receb.";
      const when = r.get("vencimento_br") || "";
      const val = formatCurrencyBR(parseFloat(r.get("valor")||"0"));
      msg += `• ${when || "—"} — ${tip} — ${r.get("conta")} (${val}) — ${statusIconLabel(r.get("status"))}\n`;
    }
    msg += `\n🔎 Dica: envie *"Relatórios"* para ver filtros prontos.`;
    await sendText(from, msg.trim()); 
    return;
  }

  if (intent === "listar_categorias") {
    const { start, end } = parseInlineWindow(text, {defaultTo:"month"});
    const rows = await sheet.getRows();
    const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===from)
                     .filter(r => withinRange(getEffectiveDate(r), start, end));

    const gastos = mine.filter(r => r.get("tipo")==="conta_pagar");
    const ganhos = mine.filter(r => r.get("tipo")==="conta_receber");

    const totG = buildCategoryTotals(gastos);
    const totR = buildCategoryTotals(ganhos);

    const title = `🏷️ *Categorias (${formatBRDate(start)} a ${formatBRDate(end)})*`;

    if (!totG.length && !totR.length) {
      await sendText(from, `${title}\n\n✅ Nenhum lançamento no período.`);
      return;
    }

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
    await sendText(from, msg.trim());
    return;
  }

  if (intent === "relatorio") {
    const pr = parseReportQuery(text);
    if(!pr){ await sendText(from, "⚠️ *Período inválido.* Tente:\n• \`Relatório do mês\`\n• \`Relatório 3 meses\`\n• \`Relatório 01/08/2025 a 30/09/2025\`\n• \`Relatório geral\`"); return; }

    const rows = await sheet.getRows();
    const msg = await buildReportMessage(from, rows, {start:pr.start, end:pr.end}, "completo");
    await sendText(from, msg);
    await sendReportMenu(from);
    return;
  }

  if (intent === "editar_lancamento") {
    await handleEditLast(from, text);
    return;
  }

  if (intent === "nova_conta" || intent === "novo_movimento" || intent === "desconhecido") {
    const { conta, valor, vencimento, tipo_pagamento, codigo_pagamento, status, tipo } = extractEntities(text, intent);
    const rowId = uuidShort();
    const finalStatus = status ?? "pendente";

    const sheet2 = await ensureSheet();
    await sheet2.addRow({
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

    const valorFmt = formatCurrencyBR(valor || 0);
    const dataStr  = formatBRDate(vencimento);

    if (tipo === "conta_pagar") {
      await sendText(from, `🧾 *Lançamento registrado!*\n\n📘 Descrição: ${conta || "Lançamento"}\n💰 Valor: ${valorFmt}\n📅 Vencimento/Data: ${dataStr}\n${finalStatus==="pago" ? "✅ Status: Pago" : "⏳ Status: Pendente"}`);
      if (tipo_pagamento === "pix")    await sendCopyButton(from, "💳 Chave Pix:", codigo_pagamento, "Copiar Pix");
      if (tipo_pagamento === "boleto") await sendCopyButton(from, "🧾 Código de barras:", codigo_pagamento, "Copiar boleto");
      if (finalStatus !== "pago") await sendConfirmButton(from, rowId);
    } else {
      await sendText(from, `💸 *Recebimento registrado!*\n\n📘 Descrição: ${conta || "Recebimento"}\n💰 Valor: ${valorFmt}\n📅 Data: ${dataStr}\n${finalStatus==="pago" ? "✅ Status: Pago" : "⏳ Status: Pendente"}`);
    }

    if (status === null) {
      await sendStatusChoiceButtons(from, rowId);
    }

    if (finalStatus === "pago") {
      const saldo = await computeUserMonthlyBalance(sheet2, from);
      await sendText(from, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
    }

    return;
  }

  await sendText(from, `🤔 *Não consegui entender sua mensagem.*\n\nExperimente algo assim:\n\n💰 \`Pagar aluguel R$800,00 05/11/2025\`\n💸 \`Receber R$300,00 de João amanhã\`\n📅 \`Lançamentos de hoje\`\n📊 \`Relatórios\`\n⚙️ \`Funções\``);
}

// Webhook
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
                const row=rows.find(r=>typeof r.get==="function"&&r.get("row_id")===rowId);
                if(row){
                  row.set("status","pago");
                  await row.save();
                  await sendText(from, "✅ *Pagamento confirmado!*");
                  const saldo = await computeUserMonthlyBalance(sheet, from);
                  await sendText(from, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
                }
              }

              if(id?.startsWith("SETSTATUS:")){
                const [, rowId, chosen] = id.split(":");
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const row=rows.find(r=>typeof r.get==="function"&&r.get("row_id")===rowId);
                if(row){
                  row.set("status", chosen === "pago" ? "pago" : "pendente");
                  await row.save();
                  if (chosen === "pago") {
                    await sendText(from, "✅ *Marcado como pago!*");
                    const saldo = await computeUserMonthlyBalance(sheet, from);
                    await sendText(from, `💼 *Seu saldo de ${monthLabel()}:* ${formatCurrencyBR(saldo, true)}`);
                  } else {
                    await sendText(from, "⏳ *Mantido como pendente.*");
                  }
                }
              }

              if(id?.startsWith("REPORT:")){
                const kind = id.split("REPORT:")[1];
                await sendText(from, `✅ Mostrando *relatório ${kind}*`);
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const win = parseInlineWindow("", {defaultTo:"month"});
                const msg = await buildReportMessage(from, rows, win, kind);
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

// CRON lembretes (30/30min)
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
      await sendText(to, `⚠️ *Lembrete de pagamento!*\n\n📘 ${r.get("conta")||"Conta"}\n💰 ${formatCurrencyBR(parseFloat(r.get("valor")||"0"))}\n📅 Vence hoje (${formatBRDate(r.get("vencimento_iso"))})`);
      if(r.get("tipo_pagamento")==="pix")    await sendCopyButton(to,"💳 Chave Pix:",r.get("codigo_pagamento"),"Copiar Pix");
      if(r.get("tipo_pagamento")==="boleto") await sendCopyButton(to,"🧾 Código de barras:",r.get("codigo_pagamento"),"Copiar boleto");
    }
  }catch(e){ console.error("Erro no CRON:", e.message); }
});

// Inicialização
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`FinPlanner IA rodando na porta ${PORT}`));
