// ============================
// ============================
// FinPlanner IA - WhatsApp Bot
// FinPlanner IA - WhatsApp Bot
// Versão: app.js (2025-10-23 • Menus+Relatórios+Saldo+Edição+Exclusão • Auth FIX • CRON 08:00)
// Versão: app.js v2025-10-23.1
// ============================
// ============================


import express from "express";
import express from "express";
import bodyParser from "body-parser";
import bodyParser from "body-parser";
import axios from "axios";
import axios from "axios";
import dotenv from "dotenv";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { JWT } from "google-auth-library";
import cron from "node-cron";
import cron from "node-cron";


dotenv.config();
dotenv.config();


// ============================
// ============================
// ENV
// ENV
// ============================
// ============================
const {
const {
  SHEETS_ID,
  PORT,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  SHEETS_ID,
  GOOGLE_SERVICE_ACCOUNT_KEY: RAW_KEY = "",
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  WA_TOKEN,
  GOOGLE_SERVICE_ACCOUNT_KEY: RAW_KEY = "",
  WA_PHONE_NUMBER_ID,
  WA_TOKEN,
  PORT,
  WA_PHONE_NUMBER_ID,
  USE_OPENAI: USE_OPENAI_RAW,
  ADMIN_WA_NUMBER,
  DEBUG_SHEETS: DEBUG_SHEETS_RAW,
  WEBHOOK_VERIFY_TOKEN,
  ADMIN_WA_NUMBER,
  USE_OPENAI: USE_OPENAI_RAW,
  WEBHOOK_VERIFY_TOKEN
  DEBUG_SHEETS: DEBUG_SHEETS_RAW,
} = process.env;
} = process.env;


const USE_OPENAI = (USE_OPENAI_RAW || "false").toLowerCase() === "true";
const USE_OPENAI = (USE_OPENAI_RAW || "false").toLowerCase() === "true";
const DEBUG_SHEETS = (DEBUG_SHEETS_RAW || "false").toLowerCase() === "true";
const DEBUG_SHEETS = (DEBUG_SHEETS_RAW || "false").toLowerCase() === "true";


// Aceita chave Google com \n literais OU quebras reais
// ============================
let GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY || "";
// Google Auth fix (supports literal \n)
if (GOOGLE_SERVICE_ACCOUNT_KEY && GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
// ============================
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n").replace(/\n/g, "\n");
let GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY || "";
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\n/g, "\n");
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.split("\n").join("\n");
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\n/g, "\n").replace(/\\n/g, "\n");
}
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\n/g, "\n");

  // Finalmente troca por quebras reais
// ============================
  GOOGLE_SERVICE_ACCOUNT_KEY = (RAW_KEY || "").replace(/\n/g, "\n").split("\n").join("\n");
// APP
  GOOGLE_SERVICE_ACCOUNT_KEY = (RAW_KEY || "").replace(/\n/g, "\n");
// ============================
  GOOGLE_SERVICE_ACCOUNT_KEY = (RAW_KEY || "").replace(/\n/g, "\n").replace(/\n/g, "\n");
const app = express();
  GOOGLE_SERVICE_ACCOUNT_KEY = (RAW_KEY || "").replace(/\n/g, "\n");
app.use(bodyParser.json());
}

if (RAW_KEY && RAW_KEY.includes("\n")) {
app.get("/", (_req, res) => {
  GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY.replace(/\n/g, "\n").split("\n").join("\n").replace(/\n/g, "\n");
  res.send("FinPlanner IA ativo! 🚀");
  GOOGLE_SERVICE_ACCOUNT_KEY = RAW_KEY.replace(/\n/g, "\n");
});
}


// ============================
// ============================
// Utils
// APP
// ============================
// ============================
const normalizeUser = (num) => (num || "").replace(/\D/g, "");
const app = express();
const NUMBER_WORDS = {
app.use(bodyParser.json());
  zero: 0,

  um: 1,
// ============================
  uma: 1,
// Utils
  dois: 2,
// ============================
  duas: 2,
const normalizeUser = (num) => (num || "").replace(/\D/g, "");
  tres: 3,
const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
  três: 3,
const endOfDay   = d => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
  quatro: 4,
const startOfMonth = (y,m) => new Date(y, m, 1, 0,0,0,0);
  cinco: 5,
const endOfMonth   = (y,m) => new Date(y, m+1, 0, 23,59,59,999);
  seis: 6,
const SEP = "────────────────";
  sete: 7,

  oito: 8,
function formatBRDate(d){ return d ? new Date(d).toLocaleDateString("pt-BR") : ""; }
  nove: 9,
function formatCurrencyBR(v){
  dez: 10,
  const num = Number(v || 0);
  onze: 11,
  return `R$${Math.abs(num).toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:2})}`;
  doze: 12,
}
  treze: 13,
function statusIconLabel(status){ return status==="pago" || status==="recebido" ? "✅ Pago" : "⏳ Pendente"; }
  quatorze: 14,
function numberToKeycapEmojis(n){
  catorze: 14,
  const map = { "0":"0️⃣","1":"1️⃣","2":"2️⃣","3":"3️⃣","4":"4️⃣","5":"5️⃣","6":"6️⃣","7":"7️⃣","8":"8️⃣","9":"9️⃣" };
  quinze: 15,
  return String(n).split("").map(d => map[d] || d).join("");
  dezesseis: 16,
}
  dezessete: 17,
function withinRange(dt, start, end){ return dt && dt>=start && dt<=end; }
  dezoito: 18,

  dezenove: 19,
// ============================
  vinte: 20,
// WhatsApp helpers
  trinta: 30,
// ============================
  quarenta: 40,
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;
  cinquenta: 50,

  sessenta: 60,
async function sendWA(p){
  setenta: 70,
  try{
  oitenta: 80,
    await axios.post(WA_API, p, { headers:{ Authorization:`Bearer ${WA_TOKEN}`, "Content-Type":"application/json" } });
  noventa: 90,
  }catch(e){
  cem: 100,
    console.error("Erro WA:", e.response?.data || e.message);
  cento: 100,
  }
  duzentos: 200,
}
  trezentos: 300,
async function sendText(to, body){
  quatrocentos: 400,
  return sendWA({ messaging_product:"whatsapp", to, type:"text", text:{ body } });
  quinhentos: 500,
}
  seiscentos: 600,
async function sendCopyButton(to, title, code, btnTitle){
  setecentos: 700,
  if(!code) return;
  oitocentos: 800,
  if(btnTitle.length>20) btnTitle = btnTitle.slice(0,20);
  novecentos: 900,
  return sendWA({
};
    messaging_product:"whatsapp", to, type:"interactive",

    interactive:{
const NUMBER_CONNECTORS = new Set([
      type:"button",
  "e",
      body:{ text:title },
  "de",
      action:{ buttons:[{ type:"copy_code", copy_code:code, title:btnTitle }] }
  "da",
    }
  "do",
  });
  "das",
}
  "dos",

  "reais",
// ============================
  "real",
// Google Sheets (AUTH Render FIX)
  "centavos",
// ============================
  "centavo",
let doc; // será instanciado já com auth
  "r$",
async function ensureAuth(){
]);
  const serviceAccountAuth = new JWT({

  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
const normalizeDiacritics = (text) =>
  key: GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
  (text || "")
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    .toString()
});
    .normalize("NFD")
 doc = new GoogleSpreadsheet(SHEETS_ID, serviceAccountAuth);
    .replace(/[\u0300-\u036f]/g, "");
  await doc.loadInfo();

}
const escapeRegex = (value) => (value || "").replace(/([.*+?^${}()|\[\]\\])/g, "\\$1");


async function ensureSheet(){
const parseNumberWordsTokens = (tokens) => {
  await ensureAuth();
  let total = 0;
  let sheet = doc.sheetsByTitle["finplanner"];
  let current = 0;
  const headers = [
  for (const token of tokens) {
    "row_id","timestamp","user","user_raw","tipo","conta","valor",
    if (!token) continue;
    "vencimento_iso","vencimento_br","tipo_pagamento","codigo_pagamento",
    if (NUMBER_CONNECTORS.has(token)) continue;
    "status","fixa","fix_parent_id","vencimento_dia",
    if (token === "mil") {
    "categoria","categoria_emoji","descricao"
      total += (current || 1) * 1000;
  ];
      current = 0;
  if (!sheet){
      continue;
    sheet = await doc.addSheet({ title:"finplanner", headerValues: headers });
    }
  }else{
    const value = NUMBER_WORDS[token];
    await sheet.loadHeaderRow();
    if (typeof value === "number") {
    const current = sheet.headerValues || [];
      current += value;
    const missing = headers.filter(h => !current.includes(h));
    } else {
    if (missing.length){
      return null;
      await sheet.setHeaderRow([...current, ...missing]);
    }
    }
  }
  }
  return total + current || null;
  return sheet;
};
}

function getVal(row, key){
const extractNumberWords = (text) => {
  if (!row) return undefined;
  const normalized = normalizeDiacritics(text).toLowerCase();
  if (typeof row.get === "function") return row.get(key);
  const tokens = normalized.split(/[^a-z$]+/).filter(Boolean);
  if (key in row) return row[key];
  let sequence = [];
  if (row._rawData && row._sheet?.headerValues){
  for (const token of tokens) {
    const idx = row._sheet.headerValues.indexOf(key);
    if (NUMBER_CONNECTORS.has(token) || NUMBER_WORDS[token] !== undefined || token === "mil") {
    if (idx >= 0) return row._rawData[idx];
      sequence.push(token);
  }
    } else if (sequence.length) {
  return undefined;
      break;
}
    }
function setVal(row, key, value){
  }
  if(!row) return;
  if (!sequence.length) return null;
  if(typeof row.set === "function") row.set(key, value);
  const parsed = parseNumberWordsTokens(sequence);
  else row[key] = value;
  if (!parsed) return null;
}
  return { amount: parsed, raw: sequence.join(" ") };
function saveRow(row){ return (typeof row.save === "function") ? row.save() : Promise.resolve(); }
};
function getEffectiveDate(row){

  const iso = getVal(row, "vencimento_iso");
const parseNumericToken = (rawToken) => {
  const ts  = getVal(row, "timestamp");
  if (rawToken === undefined || rawToken === null) return null;
  return iso ? new Date(iso) : (ts ? new Date(ts) : null);
  let token = rawToken.toString().trim().toLowerCase();
}
  if (!token) return null;


// ============================
  token = token.replace(/^r\$/i, "");
// Categoria automática

// ============================
  if (token.endsWith("mil")) {
function detectCategory(descRaw, tipo){
    const baseToken = token.slice(0, -3).trim();
  const text = (descRaw||"").toLowerCase();
    const baseValue = baseToken ? parseNumericToken(baseToken) : 1;
  const rules = [
    return baseValue ? baseValue * 1000 : null;
    { slug:"utilidades", emoji:"🔌", kws:["luz","energia","elétrica","eletrica","água","agua","esgoto","gás","gas"] },
  }
    { slug:"internet_telefonia", emoji:"🌐", kws:["internet","fibra","vivo","claro","tim","oi"] },

    { slug:"moradia", emoji:"🏠", kws:["aluguel","condomínio","condominio","iptu","aluguel"] },
  let multiplier = 1;
    { slug:"mercado", emoji:"🛒", kws:["mercado","supermercado","ifood","padaria","almoço","jantar","restaurante"] },
  if (token.endsWith("k")) {
    { slug:"transporte", emoji:"🚗", kws:["uber","99","gasolina","combustível","combustivel","passagem","ônibus","onibus"] },
    multiplier = 1000;
    { slug:"saude", emoji:"💊", kws:["academia","plano","consulta","dentista","farmácia","farmacia"] },
    token = token.slice(0, -1);
    { slug:"educacao", emoji:"🎓", kws:["curso","faculdade","escola","mensalidade"] },
  }
    { slug:"lazer", emoji:"🎭", kws:["netflix","spotify","cinema","show","lazer","entretenimento"] },

    { slug:"impostos_taxas", emoji:"🧾", kws:["multa","taxa","imposto","receita"] },
  token = token.replace(/^r\$/i, "").replace(/\s+/g, "");
    { slug:"salario_trabalho", emoji:"💼", kws:["salário","salario","pagamento","freela","freelance","contrato"] },
  token = token.replace(/[^0-9.,-]/g, "");
    { slug:"vendas_receitas", emoji:"💵", kws:["venda","recebimento","pix recebido","cliente","boleto recebido"] },
  if (!token) return null;
  ];

  for(const r of rules){
  if (token.includes(".") && token.includes(",")) {
    if (r.kws.some(k => text.includes(k))) return r;
    const lastDot = token.lastIndexOf(".");
  }
    const lastComma = token.lastIndexOf(",");
  if (tipo === "conta_receber") return { slug:"vendas_receitas", emoji:"💵" };
    const decimalSep = lastDot > lastComma ? "." : ",";
  if (tipo === "conta_pagar")   return { slug:"outros", emoji:"🧩" };
    const thousandsSep = decimalSep === "." ? "," : ".";
  return { slug:"outros", emoji:"🧩" };
    const thousandsRegex = new RegExp(`\\${thousandsSep}`, "g");
}
    token = token.replace(thousandsRegex, "");

    const decimalRegex = new RegExp(`\\${decimalSep}`, "g");
// ============================
    token = token.replace(decimalRegex, ".");
// Sessões
  } else if (token.includes(",")) {
// ============================
    const lastComma = token.lastIndexOf(",");
const sessionPeriod = new Map();
    const decimals = token.length - lastComma - 1;
const sessionEdit   = new Map();
    if (decimals === 3 && token.replace(/[^0-9]/g, "").length > 3) {
const sessionDelete = new Map();
      token = token.replace(/,/g, "");

    } else {
// ============================
      token = token.replace(/,/g, ".");
// Menus interativos
    }
// ============================
  } else if (token.includes(".")) {
async function sendWelcomeList(to){
    const lastDot = token.lastIndexOf(".");
  const body =
    const decimals = token.length - lastDot - 1;
`👋 Olá! Eu sou a FinPlanner IA.
    if (decimals === 3 && token.replace(/[^0-9]/g, "").length > 3) {

      token = token.replace(/\./g, "");
💡 Organizo seus pagamentos, ganhos e gastos de forma simples e automática.
    }

  }
Toque em *Abrir menu* ou digite o que deseja fazer.`;


  const parsed = parseFloat(token);
  return sendWA({
  if (!Number.isFinite(parsed)) return null;
    messaging_product:"whatsapp", to, type:"interactive",
  return parsed * multiplier;
    interactive:{
};
      type:"list",

      header:{ type:"text", text:"Abrir menu" },
const extractAmountFromText = (text) => {
      body:{ text: body },
  if (!text) return { amount: 0 };
      action:{
  const numericPattern = /(?:r\$\s*)?([0-9]+(?:[.,\s][0-9]+)*(?:k)?|[0-9]+\s?mil)/gi;
        button:"Abrir menu",
  let match;
        sections:[
  while ((match = numericPattern.exec(text)) !== null) {
          {
    const raw = match[0];
            title:"Lançamentos e Contas",
    const value = parseNumericToken(raw);
            rows:[
    if (value) return { amount: value, raw };
              { id:"MENU:registrar_pagamento",   title:"💰 Registrar pagamento",    description:"Adicionar um novo gasto." },
  }
              { id:"MENU:registrar_recebimento", title:"💵 Registrar recebimento",  description:"Adicionar uma entrada de dinheiro." },

              { id:"MENU:contas_pagar",          title:"📅 Contas a pagar",         description:"Ver e confirmar pagamentos pendentes." },
  const words = extractNumberWords(text);
              { id:"MENU:contas_fixas",          title:"♻️ Contas fixas",          description:"Cadastrar ou excluir contas recorrentes." },
  if (words) return words;
            ]

          },
  const fallbackMatch = text.toString().match(/\d+/);
          {
  if (fallbackMatch) {
            title:"Relatórios e Histórico",
    const value = parseNumericToken(fallbackMatch[0]);
            rows:[
    if (value) return { amount: value, raw: fallbackMatch[0] };
              { id:"MENU:relatorios",  title:"📊 Relatórios",        description:"Gerar por categoria e período." },
  }
              { id:"MENU:lancamentos", title:"🧾 Meus lançamentos",  description:"Ver por mês ou data personalizada." },

            ]
  return { amount: 0 };
          },
};
          {

            title:"Ajustes e Ajuda",
const toNumber = (value) => {
            rows:[
  if (value === undefined || value === null) return 0;
              { id:"MENU:editar",  title:"✏️ Editar lançamentos", description:"Alterar registros por número." },
  if (typeof value === "number") return value;
              { id:"MENU:excluir", title:"🗑️ Excluir lançamento", description:"Excluir último ou escolher por número." },
  const result = extractAmountFromText(String(value));
              { id:"MENU:ajuda",   title:"⚙️ Ajuda e exemplos",   description:"Como usar a FinPlanner IA." },
  return Number.isFinite(result.amount) ? result.amount : 0;
            ]
};
          }
const formatCurrencyBR = (value) => {
        ]
  const num = Number(value || 0);
      }
  return `R$${Math.abs(num).toLocaleString("pt-BR", {
    }
    minimumFractionDigits: 2,
  });
    maximumFractionDigits: 2,
}
  })}`;

};
async function sendRelatoriosButtons(to){
const statusIconLabel = (status) => {
  return sendWA({
  const normalized = (status || "").toString().toLowerCase();
    messaging_product:"whatsapp", to, type:"interactive",
  if (normalized === "pago") return "✅ Pago";
    interactive:{
  if (normalized === "recebido") return "✅ Recebido";
      type:"button",
  return "⏳ Pendente";
      body:{ text:"📊 Qual relatório você deseja gerar?" },
};
      action:{ buttons:[

        { type:"reply", reply:{ id:"REL:CAT:cp",  title:"Contas a pagar" } },
const startOfDay = (d) => {
        { type:"reply", reply:{ id:"REL:CAT:rec", title:"Recebimentos" } },
  const tmp = new Date(d);
        { type:"reply", reply:{ id:"REL:CAT:pag", title:"Pagamentos" } }
  tmp.setHours(0, 0, 0, 0);
      ]}
  return tmp;
    }
};
  });
const endOfDay = (d) => {
}
  const tmp = new Date(d);

  tmp.setHours(23, 59, 59, 999);
async function sendPeriodoButtons(to, prefix){
  return tmp;
  return sendWA({
};
    messaging_product:"whatsapp", to, type:"interactive",
const startOfMonth = (y, m) => new Date(y, m, 1, 0, 0, 0, 0);
    interactive:{
const endOfMonth = (y, m) => new Date(y, m + 1, 0, 23, 59, 59, 999);
      type:"button",

      body:{ text:"🗓️ Escolha o período:" },
const formatBRDate = (d) => {
      action:{ buttons:[
  if (!d) return "";
        { type:"reply", reply:{ id:`${prefix}:mes_atual`,        title:"Mês atual" } },
  try {
        { type:"reply", reply:{ id:`${prefix}:todo_periodo`,     title:"Todo período" } },
    return new Date(d).toLocaleDateString("pt-BR");
        { type:"reply", reply:{ id:`${prefix}:personalizado`,    title:"Data personalizada" } }
  } catch (e) {
      ]}
    return "";
    }
  }
  });
};
}


const numberToKeycapEmojis = (n) => {
async function sendLancPeriodoButtons(to){
  const map = {
  return sendWA({
    0: "0️⃣",
    messaging_product:"whatsapp", to, type:"interactive",
    1: "1️⃣",
    interactive:{
    2: "2️⃣",
      type:"button",
    3: "3️⃣",
      body:{ text:"🧾 Escolha o período:" },
    4: "4️⃣",
      action:{ buttons:[
    5: "5️⃣",
        { type:"reply", reply:{ id:`LANC:PER:mes_atual`,     title:"Mês atual" } },
    6: "6️⃣",
        { type:"reply", reply:{ id:`LANC:PER:personalizado`, title:"Data personalizada" } }
    7: "7️⃣",
      ]}
    8: "8️⃣",
    }
    9: "9️⃣",
  });
  };
}
  return String(n)

    .split("")
// ============================
    .map((d) => map[d] || d)
// Acesso aos dados
    .join("");
// ============================
};
async function allRowsForUser(userNorm){

  const sheet=await ensureSheet();
const withinRange = (dt, start, end) => {
  const rows=await sheet.getRows();
  if (!dt) return false;
  return rows.filter(r => (getVal(r,"user")||"").replace(/\D/g,"")===userNorm);
  const time = new Date(dt).getTime();
}
  return time >= start.getTime() && time <= end.getTime();
function withinPeriod(rows, start, end){
};
  return rows.filter(r => withinRange(getEffectiveDate(r), start, end));

}
const parseDateToken = (token) => {
function sumValues(rows){
  if (!token) return null;
  return rows.reduce((acc,r)=> acc + (parseFloat(getVal(r,"valor")||"0")||0), 0);
  const lower = token.toLowerCase();
}
  if (lower === "hoje") return new Date();

  if (lower === "amanha" || lower === "amanhã") {
// ============================
    const d = new Date();
// Renderização e helpers
    d.setDate(d.getDate() + 1);
// ============================
    return d;
function renderItem(r, idx){
  }
  const idxEmoji = numberToKeycapEmojis(idx);
  if (lower === "ontem") {
  const conta = getVal(r,"conta") || "Lançamento";
    const d = new Date();
  const valor = formatCurrencyBR(getVal(r,"valor"));
    d.setDate(d.getDate() - 1);
  const data  = formatBRDate(getEffectiveDate(r));
    return d;
  const status = statusIconLabel(getVal(r,"status"));
  }
  const catEmoji = getVal(r,"categoria_emoji") || "";
  const match = token.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  const cat = getVal(r,"categoria") ? `${catEmoji} ${getVal(r,"categoria")}` : "—";
  if (match) {
  const desc = getVal(r,"descricao") || conta;
    const day = Number(match[1]);
  return `${idxEmoji} ${conta}
    const month = Number(match[2]) - 1;
📝 Descrição: ${desc}
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
💰 Valor: ${valor}
    const d = new Date(year, month, day);
📅 Data: ${data}
    if (!Number.isNaN(d.getTime())) return d;
🏷️ Status: ${status}
  }
📂 Categoria: ${cat}
  return null;
${"────────────────"}
};
`;

}
const detectCategory = (description, tipo) => {

  const text = (description || "").toLowerCase();
function renderReportList(title, rows){
  const rules = [
  let msg = `📊 *${title}*\n\n`;
    { slug: "utilidades", emoji: "🔌", kws: ["luz", "energia", "água", "agua", "gás", "gas"] },
  if(!rows.length){
    { slug: "internet_telefonia", emoji: "🌐", kws: ["internet", "fibra", "vivo", "claro", "tim", "oi"] },
    msg += "✅ Nenhum lançamento encontrado para o período selecionado.";
    { slug: "moradia", emoji: "🏠", kws: ["aluguel", "condomínio", "condominio", "iptu"] },
    return msg;
    {
  }
      slug: "mercado",
  rows.forEach((r,i)=>{ msg += renderItem(r, i+1); });
      emoji: "🛒",
  msg += `\n💰 *Total:* ${formatCurrencyBR(sumValues(rows))}`;
      kws: ["mercado", "supermercado", "ifood", "padaria", "almoço", "jantar", "restaurante", "lanche", "espetinho"],
  return msg;
    },
}
    { slug: "transporte", emoji: "🚗", kws: ["uber", "99", "gasolina", "combustível", "combustivel", "passagem", "ônibus", "onibus"] },

    { slug: "saude", emoji: "💊", kws: ["academia", "plano", "consulta", "dentista", "farmácia", "farmacia"] },
function renderSaldoFooter(rowsAll, start, end){
    { slug: "educacao", emoji: "🎓", kws: ["curso", "faculdade", "escola", "mensalidade"] },
  const within = withinPeriod(rowsAll, start, end);
    { slug: "lazer", emoji: "🎭", kws: ["netflix", "spotify", "cinema", "show", "lazer", "entretenimento"] },
  const recebimentosPagos = within.filter(r => getVal(r,"tipo")==="conta_receber" && (getVal(r,"status")==="pago" || getVal(r,"status")==="recebido"));
    { slug: "impostos_taxas", emoji: "🧾", kws: ["multa", "taxa", "imposto", "receita"] },
  const pagamentosPagos   = within.filter(r => getVal(r,"tipo")==="conta_pagar"   && getVal(r,"status")==="pago");
    { slug: "salario_trabalho", emoji: "💼", kws: ["salário", "salario", "pagamento", "freela", "freelance", "contrato"] },
  const totalRec = sumValues(recebimentosPagos);
    { slug: "vendas_receitas", emoji: "💵", kws: ["venda", "recebimento", "pix recebido", "cliente", "boleto recebido"] },
  const totalPag = sumValues(pagamentosPagos);
  ];
  const saldo = totalRec - totalPag;
  for (const rule of rules) {
  const saldoStr = formatCurrencyBR(saldo);
    if (rule.kws.some((kw) => text.includes(kw))) {
  const saldoLine = saldo < 0 ? `🟥 🔹 *Saldo no período:* -${saldoStr}` : `🔹 *Saldo no período:* ${saldoStr}`;
      return { slug: rule.slug, emoji: rule.emoji };
  return `\n${"────────────────"}\n💰 *Total de Recebimentos:* ${formatCurrencyBR(totalRec)}\n💸 *Total de Pagamentos:* ${formatCurrencyBR(totalPag)}\n${saldoLine}`;
    }
}
  }

  if (tipo === "conta_receber") return { slug: "vendas_receitas", emoji: "💵" };
async function showReportByCategory(fromRaw, userNorm, category, range){
  return { slug: "outros", emoji: "🧩" };
  const rows = await allRowsForUser(userNorm);
};
  const {start,end} = range;

  const inRange = withinPeriod(rows, start, end);
const formatCategoryLabel = (slug, emoji) => {

  const raw = (slug || "").toString().trim();
  if(category==="cp"){
  if (!raw) return emoji ? `${emoji} —` : "—";
    const filtered = inRange.filter(r => getVal(r,"tipo")==="conta_pagar" && getVal(r,"status")!=="pago");
  const parts = raw.split(/[_-]+/).filter(Boolean);
    const msg = renderReportList("Relatório • Contas a pagar", filtered) + renderSaldoFooter(rows, start, end);
  const friendly =
    await sendText(fromRaw, msg); return;
    parts.length === 0
  }
      ? raw
  if(category==="rec"){
      : parts
    const filtered = inRange.filter(r => getVal(r,"tipo")==="conta_receber");
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    const msg = renderReportList("Relatório • Recebimentos", filtered) + renderSaldoFooter(rows, start, end);
          .join(" / ");
    await sendText(fromRaw, msg); return;
  return emoji ? `${emoji} ${friendly}` : friendly;
  }
};
  if(category==="pag"){

    const filtered = inRange.filter(r => getVal(r,"tipo")==="conta_pagar");
// ============================
    const msg = renderReportList("Relatório • Pagamentos", filtered) + renderSaldoFooter(rows, start, end);
// WhatsApp helpers
    await sendText(fromRaw, msg); return;
// ============================
  }
const WA_API = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;
  if(category==="all"){

    const filtered = inRange.slice().sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b));
async function sendWA(payload) {
    const msg = renderReportList("Relatório • Completo", filtered) + renderSaldoFooter(rows, start, end);
  try {
    await sendText(fromRaw, msg); return;
    await axios.post(WA_API, payload, {
  }
      headers: {
}
        Authorization: `Bearer ${WA_TOKEN}`,

        "Content-Type": "application/json",
async function showLancamentos(fromRaw, userNorm, range){
      },
  const rows = await allRowsForUser(userNorm);
    });
  const within = withinPeriod(rows, range.start, range.end)
  } catch (error) {
    .filter(r => parseFloat(getVal(r,"valor")||"0")>0)
    console.error("Erro WA:", error.response?.data || error.message);
    .sort((a,b)=> getEffectiveDate(a) - getEffectiveDate(b));
  }
  if (!within.length){
}
    await sendText(fromRaw,"✅ Nenhum lançamento encontrado para o período selecionado.");

    return;
const sendText = (to, body) =>
  }
  sendWA({
  let msg = `🧾 *Meus lançamentos*\n\n`;
    messaging_product: "whatsapp",
  within.forEach((r,i)=>{ msg += renderItem(r, i+1); });
    to,
  await sendText(fromRaw, msg);
    type: "text",
}
    text: { body },

  });
// ============================

// Exclusão/Edição (resumido – handlers principais no clique)
const sendCopyButton = (to, title, code, btnTitle) => {
// ============================
  if (!code) return;
async function handleDeleteMenu(fromRaw){
  const safeTitle = btnTitle.length > 20 ? `${btnTitle.slice(0, 17)}...` : btnTitle;
  return sendWA({
  return sendWA({
    messaging_product:"whatsapp", to:fromRaw, type:"interactive",
    messaging_product: "whatsapp",
    interactive:{
    to,
      type:"button",
    type: "interactive",
      body:{ text:"🗑️ Como deseja excluir?" },
    interactive: {
      action:{ buttons:[
      type: "button",
        { type:"reply", reply:{ id:"DEL:LAST", title:"Último lançamento" } },
      body: { text: title },
        { type:"reply", reply:{ id:"DEL:LIST", title:"Listar lançamentos" } }
      action: {
      ]}
        buttons: [
    }
          {
  });
            type: "copy_code",
}
            copy_code: code,

            title: safeTitle,
// ============================
          },
// Intents e handler
        ],
// ============================
      },
async function detectIntent(t){
    },
  const lower=(t||"").toLowerCase();
  });
  const norm = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
};
  if(/(oi|ola|opa|bom dia|boa tarde|boa noite)/i.test(norm)) return "boas_vindas";

  if(/\b(relat[óo]rios?)\b/.test(lower)) return "relatorios_menu";
// ============================
  if(/\b(relat[óo]rio\s+completo|completo)\b/.test(lower)) return "relatorio_completo";
// Google Sheets helpers
  if(/\b(lan[cç]amentos|meus lan[cç]amentos|registros|extrato)\b/i.test(lower)) return "listar_lancamentos";
// ============================
  if(/\b(contas?\s+a\s+pagar|pendentes|a pagar|contas pendentes|contas a vencer|pagamentos pendentes)\b/i.test(lower)) return "listar_pendentes";
const SHEET_HEADERS = [
  if(/\beditar lan[cç]amentos?\b/.test(lower)) return "editar";
  "row_id",
  if(/\bexcluir lan[cç]amentos?\b/.test(lower)) return "excluir";
  "timestamp",
  return "desconhecido";
  "user",
}
  "user_raw",

  "tipo",
async function handleUserText(fromRaw, text){
  "conta",
  const userNorm = normalizeUser(fromRaw);
  "valor",
  const trimmed = (text||"").trim();
  "vencimento_iso",

  "vencimento_br",
  const sp = sessionPeriod.get(userNorm);
  "tipo_pagamento",
  if (sp && sp.awaiting === "range"){
  "codigo_pagamento",
    const pretty =
  "status",
`🗓️ *Selecione um período personalizado*
  "fixa",

  "fix_parent_id",
Envie no formato:
  "vencimento_dia",
01/10/2025 a 31/10/2025
  "categoria",

  "categoria_emoji",
💡 Dica: você pode usar "a", "-", "até".`;
  "descricao",
    const m = trimmed.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:a|-|até|ate|–|—)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
];
    if(!m){ await sendText(fromRaw, pretty); return; }

    const [_, d1, d2] = m;
let doc;
    const [d1d,d1m,d1y]=d1.split("/").map(n=>parseInt(n,10));

    const [d2d,d2m,d2y]=d2.split("/").map(n=>parseInt(n,10));
async function ensureAuth() {
    let start = startOfDay(new Date(d1y, d1m-1, d1d));
  if (doc) return doc;
    let end   = endOfDay(new Date(d2y, d2m-1, d2d));
  const auth = new JWT({
    if (start > end){ const t=start; start=end; end=t; }
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    sessionPeriod.delete(userNorm);
    key: GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
    if (sp.mode === "report"){
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      await showReportByCategory(fromRaw, userNorm, sp.category, {start,end});
  });
      return;
  doc = new GoogleSpreadsheet(SHEETS_ID, auth);
    } else if (sp.mode === "lanc"){
  await doc.loadInfo();
      await showLancamentos(fromRaw, userNorm, {start,end});
  return doc;
      return;
}
    }

  }
async function ensureSheet() {

  await ensureAuth();
  const intent = await detectIntent(text);
  let sheet = doc.sheetsByTitle["finplanner"];
  if (intent === "boas_vindas") { await sendWelcomeList(fromRaw); return; }
  if (!sheet) {

    sheet = await doc.addSheet({ title: "finplanner", headerValues: SHEET_HEADERS });
  if (/^relat[óo]rios?$/i.test(trimmed)) { await sendRelatoriosButtons(fromRaw); return; }
  } else {
  if (/^relat[óo]rios? de contas a pagar$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:cp"); return; }
    await sheet.loadHeaderRow();
  if (/^relat[óo]rios? de recebimentos$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:rec"); return; }
    const current = sheet.headerValues || [];
  if (/^relat[óo]rios? de pagamentos$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:pag"); return; }
    const normalized = current.map((header) => (header || "").trim());
  if (intent === "relatorio_completo" || /^relat[óo]rio(s)? completo(s)?$/i.test(trimmed)) { await sendPeriodoButtons(fromRaw, "REL:PER:all"); return; }
    const hasDuplicate = new Set(normalized.filter(Boolean)).size !== normalized.filter(Boolean).length;

    const missing = SHEET_HEADERS.filter((header) => !normalized.includes(header));
  if (/^lan[cç]amentos( do m[eê]s)?$/i.test(trimmed)) {
    const orderMismatch = SHEET_HEADERS.some((header, index) => normalized[index] !== header);
    const now=new Date();

    const range={ start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()) };
    if (hasDuplicate || missing.length || orderMismatch || normalized.length !== SHEET_HEADERS.length) {
    await showLancamentos(fromRaw, userNorm, range);
      await sheet.setHeaderRow(SHEET_HEADERS);
    return;
    }
  }
  }

  return sheet;
  if (intent === "editar") { await sendText(fromRaw,"✏️ Em breve (já em desenvolvimento)."); return; }
}
  if (intent === "excluir") { await handleDeleteMenu(fromRaw); return; }


const getVal = (row, key) => {
  await sendText(fromRaw, `😕 *Não entendi o que você quis dizer.*
  if (!row) return undefined;

  if (typeof row.get === "function") return row.get(key);
Toque em *Abrir menu* ou digite o que deseja fazer.`);
  if (key in row) return row[key];
  await sendWelcomeList(fromRaw);
  if (row._rawData && row._sheet?.headerValues) {
}
    const index = row._sheet.headerValues.indexOf(key);

    if (index >= 0) return row._rawData[index];
// ============================
  }
// Webhook
  return undefined;
// ============================
};
app.get("/webhook",(req,res)=>{

  const token=WEBHOOK_VERIFY_TOKEN || "verify_token";
const setVal = (row, key, value) => {
  if(req.query["hub.mode"]==="subscribe"&&req.query["hub.verify_token"]===token)
  if (!row) return;
    return res.status(200).send(req.query["hub.challenge"]);
  if (typeof row.set === "function") row.set(key, value);
  res.sendStatus(403);
  else row[key] = value;
});
};


app.post("/webhook",async(req,res)=>{
const saveRow = (row) => (typeof row.save === "function" ? row.save() : Promise.resolve());
  try{

    const body=req.body;
const getEffectiveDate = (row) => {
    if(body.object&&body.entry){
  const iso = getVal(row, "vencimento_iso");
      for(const e of body.entry){
  const ts = getVal(row, "timestamp");
        for(const c of e.changes||[]){
  if (iso) return new Date(iso);
          const messages = c.value?.messages || [];
  if (ts) return new Date(ts);
          for(const m of messages){
  return null;
            const from=m.from;
};


            if(m.type==="text") await handleUserText(from, m.text?.body || "");
const getRowIdentifier = (row) => (getVal(row, "row_id") || getVal(row, "timestamp") || "").toString();


            if(m.type==="interactive"){
async function allRowsForUser(userNorm) {
              const btn = m.interactive?.button_reply;
  const sheet = await ensureSheet();
              const list= m.interactive?.list_reply;
  const rows = await sheet.getRows();

  return rows.filter((row) => normalizeUser(getVal(row, "user")) === userNorm);
              if (btn?.id){
}
                const id=btn.id;


const findRowById = async (userNorm, rowId) => {
                if(id==="REL:CAT:cp"){ await sendPeriodoButtons(from, "REL:PER:cp"); }
  if (!rowId) return null;
                if(id==="REL:CAT:rec"){ await sendPeriodoButtons(from, "REL:PER:rec"); }
  const rows = await allRowsForUser(userNorm);
                if(id==="REL:CAT:pag"){ await sendPeriodoButtons(from, "REL:PER:pag"); }
  const target = rowId.toString();

  return rows.find((row) => getRowIdentifier(row) === target);
                if(id.startsWith("REL:PER:")){
};
                  const parts = id.split(":");

                  const cat = parts[2]; const opt = parts[3];
const withinPeriod = (rows, start, end) => rows.filter((row) => withinRange(getEffectiveDate(row), start, end));
                  const userNorm = normalizeUser(from);
const sumValues = (rows) => rows.reduce((acc, row) => acc + toNumber(getVal(row, "valor")), 0);
                  const now=new Date();

                  if(opt==="mes_atual"){
// ============================
                    const range={ start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()) };
// Rendering helpers
                    await showReportByCategory(from, userNorm, cat, range);
// ============================
                  } else if (opt==="todo_periodo"){
const formatEntryBlock = (row, options = {}) => {
                    const rows=await allRowsForUser(userNorm);
  const { index, headerLabel, dateText } = options;
                    let min = null;
  const descricao = (getVal(row, "descricao") || getVal(row, "conta") || "Lançamento").toString().trim();
                    for(const r of rows){ const d=getEffectiveDate(r); if(d && (!min || d<min)) min=d; }
  const categoriaLabel = formatCategoryLabel(getVal(row, "categoria"), getVal(row, "categoria_emoji"));
                    const start = min ? startOfDay(min) : startOfDay(new Date());
  const valor = formatCurrencyBR(toNumber(getVal(row, "valor")));
                    const end   = endOfDay(new Date());
  const data = dateText || formatBRDate(getEffectiveDate(row)) || "—";
                    await showReportByCategory(from, userNorm, cat, {start,end});
  const statusRaw = (getVal(row, "status") || "pendente").toString().toLowerCase();
                  } else if (opt==="personalizado"){
  const statusLabel = statusRaw === "recebido" ? "✅ Recebido" : statusRaw === "pago" ? "✅ Pago" : "⏳ Pendente";
                    sessionPeriod.set(userNorm, { mode:"report", category:cat, awaiting:"range" });
  const tipoRaw = (getVal(row, "tipo") || "conta_pagar").toString();
                    await sendText(from,
  const tipoLabel = tipoRaw === "conta_receber" ? "💵 Receita" : "💸 Despesa";
`🗓️ *Selecione um período personalizado*
  const fields = [

    `📝 Descrição: ${descricao}`,
Envie no formato:
    `📂 Categoria: ${categoriaLabel}`,
01/10/2025 a 31/10/2025
    `💰 Valor: ${valor}`,

    `📅 Data: ${data}`,
💡 Dica: você pode usar "a", "-", "até".`);
    `🏷 Status: ${statusLabel}`,
                  }
    `🔁 Tipo: ${tipoLabel}`,
                }
  ];

  if (headerLabel) {
                if(id.startsWith("LANC:PER:")){
    return `${headerLabel}\n\n${fields.join("\n")}`;
                  const [, , opt] = id.split(":");
  }
                  const userNorm = normalizeUser(from);
  if (typeof index === "number") {
                  const now=new Date();
    const [first, ...rest] = fields;
                  if(opt==="mes_atual"){
    const prefix = `${numberToKeycapEmojis(index)} ${first}`;
                    const range={ start: startOfMonth(now.getFullYear(),now.getMonth()), end: endOfMonth(now.getFullYear(),now.getMonth()) };
    return [prefix, ...rest].join("\n");
                    await showLancamentos(from, userNorm, range);
  }
                  } else if (opt==="personalizado"){
  return `📘 Lançamento\n\n${fields.join("\n")}`;
                    sessionPeriod.set(userNorm, { mode:"lanc", awaiting:"range" });
};
                    await sendText(from,

`🗓️ *Selecione um período personalizado*
const formatEntrySummary = (row, options = {}) =>

  formatEntryBlock(row, { ...options, headerLabel: options.headerLabel || "📘 Resumo do lançamento" });
Envie no formato:

01/10/2025 a 31/10/2025
const renderReportList = (title, rows) => {

  let message = `📊 *${title}*\n\n`;
💡 Dica: você pode usar "a", "-", "até".`);
  if (!rows.length) {
                  }
    return `${message}✅ Nenhum lançamento encontrado para o período selecionado.`;
                }
  }

  const blocks = rows.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
                if(id==="DEL:LAST"){ /* handler completo no arquivo final */ }
  message += blocks.join("\n\n");
                if(id==="DEL:LIST"){ /* handler completo no arquivo final */ }
  message += `\n\n💰 *Total:* ${formatCurrencyBR(sumValues(rows))}`;
                if(id==="DEL:CONFIRM"){ /* handler completo no arquivo final */ }
  return message;
              }
};


              if (list?.id){
const renderSaldoFooter = (rowsAll, start, end) => {
                const id=list.id;
  const within = withinPeriod(rowsAll, start, end);
                if(id==="MENU:registrar_pagamento"){
  const recebimentosPagos = within.filter(
                  await sendText(from,
    (row) => getVal(row, "tipo") === "conta_receber" && ["pago", "recebido"].includes((getVal(row, "status") || "").toLowerCase())
`💰 *Registrar pagamento ou gasto*
  );

  const pagamentosPagos = within.filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") === "pago");
Digite o pagamento ou gasto que deseja registrar, informando:
  const totalRec = sumValues(recebimentosPagos);

  const totalPag = sumValues(pagamentosPagos);
📝 Descrição: (ex: Internet)
  const saldo = totalRec - totalPag;
💰 Valor: (ex: 150,00)
  const saldoStr = formatCurrencyBR(saldo);
📅 Data: (ex: hoje, amanhã ou 05/11/2025)
  const saldoLine = saldo < 0 ? `🟥 🔹 *Saldo no período:* -${saldoStr}` : `🔹 *Saldo no período:* ${saldoStr}`;
🏷️ Status: (pago ou pendente)
  return `\n\n💰 *Total de Recebimentos:* ${formatCurrencyBR(totalRec)}\n💸 *Total de Pagamentos:* ${formatCurrencyBR(totalPag)}\n${saldoLine}`;
📂 Categoria: (opcional, será detectada automaticamente)`);
};
                }

                if(id==="MENU:registrar_recebimento"){
// ============================
                  await sendText(from,
// Menus interativos
`💵 *Registrar recebimento*
// ============================

const MAIN_MENU_SECTIONS = [
Digite o recebimento que deseja registrar, informando:
  {

    title: "Lançamentos e Contas",
📝 Descrição: (ex: Venda curso)
    rows: [
💰 Valor: (ex: 200,00)
      { id: "MENU:registrar_pagamento", title: "💰 Registrar pagamento", description: "Adicionar um novo gasto." },
📅 Data: (ex: hoje, amanhã ou 05/11/2025)
      { id: "MENU:registrar_recebimento", title: "💵 Registrar recebimento", description: "Adicionar uma entrada." },
🏷️ Status: (recebido ou pendente)
      { id: "MENU:contas_pagar", title: "📅 Contas a pagar", description: "Ver e confirmar pagamentos pendentes." },
📂 Categoria: (opcional, será detectada automaticamente)`);
      { id: "MENU:contas_fixas", title: "♻️ Contas fixas", description: "Cadastrar ou excluir contas recorrentes." },
                }
    ],
                if(id==="MENU:contas_pagar"){ /* lista pendentes no arquivo final */ }
  },
                if(id==="MENU:contas_fixas"){ await sendText(from,"♻️ Ex.: *Conta fixa internet 100 todo dia 01* | *Excluir conta fixa internet*"); }
  {
                if(id==="MENU:relatorios"){ await sendRelatoriosButtons(from); }
    title: "Relatórios e Histórico",
                if(id==="MENU:lancamentos"){ await sendLancPeriodoButtons(from); }
    rows: [
                if(id==="MENU:editar"){ await sendText(from,"✏️ Em breve (já em desenvolvimento)."); }
      { id: "MENU:relatorios", title: "📊 Relatórios", description: "Gerar por categoria e período." },
                if(id==="MENU:excluir"){ await handleDeleteMenu(from); }
      { id: "MENU:lancamentos", title: "🧾 Meus lançamentos", description: "Ver por mês ou período personalizado." },
                if(id==="MENU:ajuda"){
    ],
                  await sendText(from,
  },
`⚙️ *Ajuda & Exemplos*
  {

    title: "Ajustes e Ajuda",
🧾 *Registrar pagamento*
    rows: [
Ex.: Academia 150,00 pago hoje
      { id: "MENU:editar", title: "✏️ Editar lançamentos", description: "Alterar registros por número." },
Ex.: Pagar internet 120 amanhã
      { id: "MENU:excluir", title: "🗑️ Excluir lançamento", description: "Excluir último ou escolher por número." },

      { id: "MENU:ajuda", title: "⚙️ Ajuda e exemplos", description: "Como usar a FinPlanner IA." },
💵 *Registrar recebimento*
    ],
Ex.: Venda curso 200,00 recebido hoje
  },
Ex.: Receber aluguel 900,00 05/11/2025
];


📊 *Relatórios*
const sendMainMenu = (to, { greeting = false } = {}) =>
Toque em Relatórios → escolha *Contas a pagar*, *Recebimentos* ou *Pagamentos* → selecione o período.
  sendWA({

    messaging_product: "whatsapp",
🧾 *Meus lançamentos*
    to,
Toque em Meus lançamentos → escolha *Mês atual* ou *Data personalizada*.
    type: "interactive",

    interactive: {
✏️ *Editar lançamentos*
      type: "list",
Toque em Editar lançamentos → escolha pelo número → selecione o que deseja alterar.
      body: {

        text: greeting
🗑️ *Excluir lançamento*
          ? `👋 Olá! Eu sou a FinPlanner IA.\n\n💡 Organizo seus pagamentos, ganhos e gastos de forma simples e automática.\n\nToque em *Abrir menu* ou digite o que deseja fazer.`
Toque em Excluir lançamento → *Último lançamento* ou *Listar lançamentos*.`);
          : "Toque em *Abrir menu* ou digite o que deseja fazer.",
                }
      },
              }
      action: {
            }
        button: "Abrir menu",
          }
        sections: MAIN_MENU_SECTIONS,
        }
      },
      }
    },
    }
  });
    res.sendStatus(200);

  }catch(e){
const sendWelcomeList = (to) => sendMainMenu(to, { greeting: true });
    console.error("Erro no webhook:", e.message);

    res.sendStatus(200);
const sendRelatoriosButtons = (to) =>
  }
  sendWA({
});
    messaging_product: "whatsapp",

    to,
// ============================
    type: "interactive",
// CRON: 08:00 America/Maceio
    interactive: {
// ============================
      type: "list",
cron.schedule("0 8 * * *", async()=>{
      body: { text: "📊 Qual relatório você deseja gerar?" },
  try{
      action: {
    const sheet=await ensureSheet();
        button: "Abrir opções",
    const rows=await sheet.getRows();
        sections: [
    const today = startOfDay(new Date()).getTime();
          {

            title: "Tipos de relatório",
    const duePay = rows.filter(r =>
            rows: [
      getVal(r,"tipo")==="conta_pagar" &&
              { id: "REL:CAT:cp", title: "Contas a pagar", description: "Pagamentos pendentes e quitados." },
      getVal(r,"status")!=="pago" &&
              { id: "REL:CAT:rec", title: "Recebimentos", description: "Entradas registradas." },
      getVal(r,"vencimento_iso")
              { id: "REL:CAT:pag", title: "Pagamentos", description: "Todos os gastos registrados." },
    ).filter(r => startOfDay(new Date(getVal(r,"vencimento_iso"))).getTime()===today);
              { id: "REL:CAT:all", title: "Completo", description: "Visão geral de tudo." },

            ],
    const dueRecv = rows.filter(r =>
          },
      getVal(r,"tipo")==="conta_receber" &&
        ],
      getVal(r,"status")!=="pago" && getVal(r,"status")!=="recebido" &&
      },
      getVal(r,"vencimento_iso")
    },
    ).filter(r => startOfDay(new Date(getVal(r,"vencimento_iso"))).getTime()===today);
  });


    const notify = async (r, isRecv=false)=>{
const sendPeriodoButtons = (to, prefix) =>
      const toRaw=getVal(r,"user_raw") || getVal(r,"user");
  sendWA({
      const tipoTxt = isRecv ? "recebimento" : "pagamento";
    messaging_product: "whatsapp",
      await sendText(toRaw, `⚠️ *Lembrete de ${tipoTxt}!*
    to,

    type: "interactive",
📘 ${getVal(r,"conta")||"Lançamento"}
    interactive: {
📝 Descrição: ${getVal(r,"descricao")||getVal(r,"conta")||"—"}
      type: "button",
💰 ${formatCurrencyBR(parseFloat(getVal(r,"valor")||"0"))}
      body: { text: "🗓️ Escolha o período:" },
📅 Para hoje (${formatBRDate(getVal(r,"vencimento_iso"))})`);
      action: {
      if(getVal(r,"tipo_pagamento")==="pix")    await sendCopyButton(toRaw,"💳 Chave Pix:",getVal(r,"codigo_pagamento"),"Copiar Pix");
        buttons: [
      if(getVal(r,"tipo_pagamento")==="boleto") await sendCopyButton(toRaw,"🧾 Código de barras:",getVal(r,"codigo_pagamento"),"Copiar boleto");
          { type: "reply", reply: { id: `${prefix}:mes_atual`, title: "Mês atual" } },
    };
          { type: "reply", reply: { id: `${prefix}:todo_periodo`, title: "Todo período" } },

          { type: "reply", reply: { id: `${prefix}:personalizado`, title: "Data personalizada" } },
    for(const r of duePay)  await notify(r,false);
        ],
    for(const r of dueRecv) await notify(r,true);
      },

    },
  }catch(e){ 
  });
    console.error("Erro no CRON:", e.message); 

  }
const sendLancPeriodoButtons = (to) =>
}, { timezone: "America/Maceio" });
  sendWA({

    messaging_product: "whatsapp",
// ============================
    to,
// Server
    type: "interactive",
// ============================
    interactive: {
const port = PORT || 10000;
      type: "button",
app.listen(port, ()=> console.log(`FinPlanner IA (2025-10-23) rodando na porta ${port}`));
      body: { text: "🧾 Escolha o período:" },

      action: {
        buttons: [
          { type: "reply", reply: { id: `LANC:PER:hoje`, title: "Hoje" } },
          { type: "reply", reply: { id: `LANC:PER:mes_atual`, title: "Mês atual" } },
          { type: "reply", reply: { id: `LANC:PER:personalizado`, title: "Data personalizada" } },
        ],
      },
    },
  });

const sendDeleteMenu = (to) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "🗑️ Como deseja excluir?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "DEL:LAST", title: "Último lançamento" } },
          { type: "reply", reply: { id: "DEL:LIST", title: "Listar lançamentos" } },
        ],
      },
    },
  });

const sendContasFixasMenu = (to) =>
  sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Escolha uma opção:" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "CFIX:CAD", title: "Cadastrar fixa" } },
          { type: "reply", reply: { id: "CFIX:LIST", title: "Listar fixas" } },
          { type: "reply", reply: { id: "CFIX:DEL", title: "Excluir fixas" } },
        ],
      },
    },
  });

const sendCadastrarContaFixaMessage = (to) =>
  sendText(
    to,
    `♻ Cadastro de conta fixa\n\nUse este formato para registrar contas que se repetem todo mês automaticamente:\n\n📝 Descrição: Nome da conta\n(ex: Internet, Academia, Aluguel)\n\n💰 Valor: Valor fixo da conta\n(ex: 120,00)\n\n📅 Dia de vencimento: Data que vence todo mês\n(ex: todo dia 05)\n\n💡 Exemplo pronto:\n➡ Conta fixa internet 120,00 todo dia 05\n\n🔔 A FinPlanner IA lançará esta conta automaticamente todo mês e te avisará no dia do vencimento.`
  );

const sendListarContasFixasMessage = async (to, userNorm) => {
  const fixed = await getFixedAccounts(userNorm);
  if (!fixed.length) {
    await sendText(to, "Você ainda não possui contas fixas cadastradas.");
    return;
  }
  const list = buildFixedAccountList(fixed);
  await sendText(to, `♻️ *Contas fixas cadastradas*\n\n${list}`);
};

const buildFixedAccountList = (rows) =>
  rows
    .map((row, index) => {
      const dia = Number(getVal(row, "vencimento_dia"));
      const dateText = Number.isFinite(dia) && dia > 0 ? `Dia ${String(dia).padStart(2, "0")}` : undefined;
      return formatEntryBlock(row, {
        index: index + 1,
        dateText,
      });
    })
    .join("\n\n");

const isFixedAccount = (row) => String(getVal(row, "fixa") || "").toLowerCase() === "sim";

const getFixedAccounts = async (userNorm) => {
  const rows = await allRowsForUser(userNorm);
  return rows.filter((row) => isFixedAccount(row));
};

async function sendExcluirContaFixaMessage(to, userNorm) {
  const fixed = await getFixedAccounts(userNorm);
  if (!fixed.length) {
    sessionFixedDelete.delete(userNorm);
    await sendText(to, "Você ainda não possui contas fixas cadastradas.");
    return;
  }
  const sorted = fixed.slice().sort((a, b) => {
    const diaA = Number(getVal(a, "vencimento_dia")) || 0;
    const diaB = Number(getVal(b, "vencimento_dia")) || 0;
    if (diaA && diaB) return diaA - diaB;
    if (diaA) return -1;
    if (diaB) return 1;
    const contaA = (getVal(a, "conta") || "").toString().toLowerCase();
    const contaB = (getVal(b, "conta") || "").toString().toLowerCase();
    return contaA.localeCompare(contaB);
  });
  sessionFixedDelete.set(userNorm, { awaiting: "index", rows: sorted });
  const list = buildFixedAccountList(sorted);
  const message = `🗑 Excluir conta fixa\n\nPara remover uma conta recorrente, digite o número de qual deseja excluir:\n\n${list}\n\nEnvie o número da conta fixa que deseja excluir.`;
  await sendText(to, message);
}

// ============================
// Sessões (estado do usuário)
// ============================
const sessionPeriod = new Map();
const sessionEdit = new Map();
const sessionDelete = new Map();
const sessionRegister = new Map();
const sessionFixedDelete = new Map();
const sessionStatusConfirm = new Map();
const sessionPaymentCode = new Map();
const sessionPayConfirm = new Map();

const startReportCategoryFlow = async (to, userNorm, category) => {
  sessionPeriod.set(userNorm, { mode: "report", category, awaiting: null });
  await sendPeriodoButtons(to, `REL:PER:${category}`);
};

const resetSession = (userNorm) => {
  sessionPeriod.delete(userNorm);
  sessionEdit.delete(userNorm);
  sessionDelete.delete(userNorm);
  sessionRegister.delete(userNorm);
  sessionFixedDelete.delete(userNorm);
  sessionStatusConfirm.delete(userNorm);
  sessionPaymentCode.delete(userNorm);
  sessionPayConfirm.delete(userNorm);
};

// ============================
// Sheets operations
// ============================
const createRow = async (payload) => {
  const sheet = await ensureSheet();
  if (DEBUG_SHEETS) console.log("[Sheets] Adding row", payload);
  await sheet.addRow(payload);
};

const deleteRow = async (row) => {
  if (!row) return;
  if (DEBUG_SHEETS) console.log("[Sheets] Removing row", getVal(row, "row_id"));
  if (typeof row.delete === "function") await row.delete();
};

const generateRowId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ============================
// Parse de lançamento
// ============================
const parseRegisterText = (text) => {
  const original = (text || "").toString();
  const normalized = normalizeDiacritics(original).toLowerCase();
  const isReceber = /\b(receb|receita|entrada|venda|vendi|ganhei)\b/.test(normalized);
  const tipo = isReceber ? "conta_receber" : "conta_pagar";

  let status = "pendente";
  let statusDetected = false;
  const receivedRegex = /\b(recebid[oa]?|recebi|recebemos|creditad[oa]|caiu|confirmad[oa])\b/;
  const pendingRegex = /\b(pendente|a pagar|pagar|a receber|aguardando|em aberto)\b/;
  const paidRegex = /\b(pag[ouei]|paguei|quitad[oa]|liquidad[oa]|transferi|transferido|pix)\b/;
  if (receivedRegex.test(normalized)) {
    status = "recebido";
    statusDetected = true;
  } else if (pendingRegex.test(normalized)) {
    status = "pendente";
    statusDetected = true;
  } else if (paidRegex.test(normalized)) {
    status = "pago";
    statusDetected = true;
  }
  if (tipo === "conta_receber" && status === "pago") status = "recebido";
  if (tipo === "conta_pagar" && status === "recebido") status = "pago";

  const amountInfo = extractAmountFromText(original);
  const valor = amountInfo.amount || 0;

  let data = null;
  const dateMatch = original.match(/(hoje|amanh[ãa]|ontem|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);
  if (dateMatch) data = parseDateToken(dateMatch[1]);

  let descricao = original;
  if (amountInfo.raw) {
    const rawEscaped = escapeRegex(amountInfo.raw);
    descricao = descricao.replace(new RegExp(rawEscaped, "i"), "");
  }
  descricao = descricao
    .replace(/(hoje|amanh[ãa]|ontem)/gi, "")
    .replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/gi, "")
    .replace(/\b(recebimento|receber|recebido|recebi|pagamento|pagar|pago|paguei|pendente|quitad[oa]|liquidad[oa]|entrada|receita)\b/gi, "")
    .replace(/\b(valor|lançamento|lancamento|novo)\b/gi, "")
    .replace(/r\$/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (descricao) {
    const tokens = descricao.split(/\s+/);
    const filtered = tokens.filter((token) => {
      const normalizedToken = normalizeDiacritics(token).toLowerCase();
      if (NUMBER_CONNECTORS.has(normalizedToken)) return false;
      if (NUMBER_WORDS[normalizedToken] !== undefined) return false;
      if (normalizedToken === "mil") return false;
      return true;
    });
    descricao = filtered.join(" ");
  }

  descricao = descricao.trim();
  if (!descricao) descricao = tipo === "conta_receber" ? "Recebimento" : "Pagamento";

  let tipoPagamento = "";
  if (/\bpix\b/.test(normalized)) tipoPagamento = "pix";
  else if (/\bboleto\b/.test(normalized)) tipoPagamento = "boleto";
  else if (/\b(cart[aã]o\s*de\s*cr[eé]dito|cart[aã]o\s*cr[eé]dito|cr[eé]dito\s*no?\s*cart[aã]o|credito\b.*cartao)\b/.test(normalized))
    tipoPagamento = "cartao_credito";
  else if (/\b(cart[aã]o\s*de\s*d[eé]bito|cart[aã]o\s*d[eé]bito|d[eé]bito\s*no?\s*cart[aã]o|debito\b.*cartao)\b/.test(normalized))
    tipoPagamento = "cartao_debito";
  else if (/\bdinheiro\b/.test(normalized)) tipoPagamento = "dinheiro";
  else if (/\btransfer/i.test(normalized)) tipoPagamento = "transferencia";

  return {
    tipo,
    valor,
    data: data || new Date(),
    status,
    statusDetected,
    descricao,
    tipoPagamento,
  };
};

// ============================
// Fluxos de mensagens
// ============================
async function showReportByCategory(fromRaw, userNorm, category, range) {
  const rows = await allRowsForUser(userNorm);
  const { start, end } = range;
  const inRange = withinPeriod(rows, start, end);

  if (category === "cp") {
    const filtered = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") !== "pago");
    const message = renderReportList("Relatório • Contas a pagar", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, message);
    return;
  }
  if (category === "rec") {
    const filtered = inRange.filter((row) => getVal(row, "tipo") === "conta_receber");
    const message = renderReportList("Relatório • Recebimentos", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, message);
    return;
  }
  if (category === "pag") {
    const filtered = inRange.filter((row) => getVal(row, "tipo") === "conta_pagar");
    const message = renderReportList("Relatório • Pagamentos", filtered) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, message);
    return;
  }
  if (category === "all") {
    const sorted = inRange.slice().sort((a, b) => getEffectiveDate(a) - getEffectiveDate(b));
    const message = renderReportList("Relatório • Completo", sorted) + renderSaldoFooter(rows, start, end);
    await sendText(fromRaw, message);
  }
}

async function showLancamentos(fromRaw, userNorm, range) {
  const rows = await allRowsForUser(userNorm);
  const filtered = withinPeriod(rows, range.start, range.end)
    .filter((row) => toNumber(getVal(row, "valor")) > 0)
    .sort((a, b) => getEffectiveDate(a) - getEffectiveDate(b));
  if (!filtered.length) {
    await sendText(fromRaw, "✅ Nenhum lançamento encontrado para o período selecionado.");
    return;
  }
  const blocks = filtered.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  const message = `🧾 *Meus lançamentos*\n\n${blocks.join("\n\n")}`;
  await sendText(fromRaw, message);
}

async function listPendingPayments(fromRaw, userNorm) {
  const rows = await allRowsForUser(userNorm);
  const pending = rows.filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") !== "pago");
  if (!pending.length) {
    await sendText(fromRaw, "🎉 Você não possui contas pendentes no momento!");
    return;
  }
  const blocks = pending.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  const message =
    `📅 *Contas a pagar pendentes*\n\n${blocks.join("\n\n")}` +
    `\n\n✅ Para confirmar pagamento, envie o número da conta.\nExemplo: Confirmar 1 ou Confirmar 1,2,3.`;
  setPayState(userNorm, { awaiting: "index", rows: pending, queue: [], currentIndex: 0, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
  await sendText(fromRaw, message);
}

async function listRowsForSelection(fromRaw, userNorm, mode) {
  const rows = await allRowsForUser(userNorm);
  const sorted = rows
    .slice()
    .sort((a, b) => getEffectiveDate(b) - getEffectiveDate(a))
    .slice(0, 15);
  if (!sorted.length) {
    await sendText(fromRaw, "Não encontrei lançamentos recentes.");
    return;
  }
  const blocks = sorted.map((row, index) => formatEntryBlock(row, { index: index + 1 }));
  if (mode === "edit") {
    const message = `✏️ Selecione o lançamento que deseja editar:\n\n${blocks.join("\n\n")}\n\nEnvie o número correspondente (1-${sorted.length}).`;
    sessionEdit.set(userNorm, { awaiting: "index", rows: sorted, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    await sendText(fromRaw, message);
  } else {
    const message =
      "📋 Selecione o lançamento que deseja excluir:\n\n" +
      `${blocks.join("\n\n")}\n\n📋 Selecione os lançamentos que deseja excluir:\n\nEnvie os números separados por vírgula ou espaço.\nExemplo: 1, 3, 5 ou 2 4 6`;
    sessionDelete.set(userNorm, { awaiting: "index", rows: sorted, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    await sendText(fromRaw, message);
  }
}

const SESSION_TIMEOUT_MS = 2 * 60 * 1000;

const selectionStopWords = new Set(
  [
    "excluir",
    "exclua",
    "remover",
    "remova",
    "apagar",
    "apague",
    "deletar",
    "delete",
    "editar",
    "edita",
    "lancamento",
    "lancamentos",
    "numero",
    "numeros",
    "número",
    "números",
    "item",
    "itens",
    "selecionar",
    "selecione",
    "selecao",
    "escolher",
    "escolha",
    "confirmar",
    "confirm",
    "quero",
    "para",
    "pra",
    "de",
    "do",
    "da",
    "dos",
    "das",
    "o",
    "a",
    "os",
    "as",
    "um",
    "uma",
  ].map((word) => normalizeDiacritics(word))
);

const cleanSelectionTerms = (normalizedText) =>
  normalizedText
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !selectionStopWords.has(token))
    .join(" ");

const parseSelectionIndexes = (text, max) => {
  const normalized = normalizeDiacritics(text).toLowerCase();
  const indexes = new Set();
  const rangeRegex = /(\d+)\s*(?:a|ate|até|ate|ao|à|\-|–|—)\s*(\d+)/g;
  let rangeMatch;
  while ((rangeMatch = rangeRegex.exec(normalized))) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    for (let i = from; i <= to; i += 1) {
      indexes.add(i);
    }
  }
  const numberRegex = /\b\d+\b/g;
  let match;
  while ((match = numberRegex.exec(normalized))) {
    indexes.add(Number(match[0]));
  }
  const filtered = [...indexes].filter((idx) => Number.isFinite(idx) && idx >= 1 && idx <= max);
  filtered.sort((a, b) => a - b);
  return filtered;
};

const parseSelectionByDescription = (text, rows) => {
  const normalized = normalizeDiacritics(text).toLowerCase();
  const cleaned = cleanSelectionTerms(normalized).replace(/\d+/g, " ").trim();
  if (!cleaned) return [];
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = [];
  rows.forEach((row, idx) => {
    const base = normalizeDiacritics(
      `${getVal(row, "descricao") || ""} ${getVal(row, "conta") || ""}`
    )
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (words.every((word) => base.includes(word))) {
      matches.push(idx + 1);
    }
  });
  return matches;
};

const resolveSelectionIndexes = (text, rows) => {
  const indexes = parseSelectionIndexes(text, rows.length);
  if (indexes.length) return indexes;
  const byDescription = parseSelectionByDescription(text, rows);
  return byDescription;
};

const uniqueSelections = (selections) => {
  const seen = new Set();
  const list = [];
  for (const item of selections) {
    if (!item || !item.row) continue;
    const rowId = getVal(item.row, "row_id") || getVal(item.row, "timestamp") || `${item.displayIndex}-${Math.random()}`;
    if (seen.has(rowId)) continue;
    seen.add(rowId);
    list.push(item);
  }
  return list;
};

const setDeleteState = (userNorm, state) => {
  const current = sessionDelete.get(userNorm) || {};
  sessionDelete.set(userNorm, { ...current, ...state });
};

const resetDeleteTimeout = (state) => ({ ...state, expiresAt: Date.now() + SESSION_TIMEOUT_MS });

const deleteStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

async function promptNextDeleteConfirmation(to, userNorm) {
  const state = sessionDelete.get(userNorm);
  if (!state || !Array.isArray(state.queue) || !state.queue.length) return;
  const currentIndex = state.currentIndex || 0;
  const currentItem = state.queue[currentIndex];
  if (!currentItem || !currentItem.row) {
    sessionDelete.delete(userNorm);
    return;
  }
  const summary = formatEntrySummary(currentItem.row, { headerLabel: "🧾 Lançamento selecionado:" });
  const body = `⚠ Confirmar exclusão do lançamento:\n\n${summary}\n\nDeseja realmente excluir este lançamento?`;
  const nextState = resetDeleteTimeout({ ...state, awaiting: "confirm", currentIndex });
  sessionDelete.set(userNorm, nextState);
  await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: "DEL:CONFIRM:YES", title: "✅ Sim, excluir" } },
          { type: "reply", reply: { id: "DEL:CONFIRM:NO", title: "❌ Cancelar" } },
        ],
      },
    },
  });
}

async function confirmDeleteRows(fromRaw, userNorm, selections) {
  const validSelections = uniqueSelections(selections || []);
  if (!validSelections.length) return;
  setDeleteState(userNorm, {
    awaiting: "confirm",
    queue: validSelections,
    currentIndex: 0,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await promptNextDeleteConfirmation(fromRaw, userNorm);
}

async function finalizeDeleteConfirmation(fromRaw, userNorm, confirmed) {
  const state = sessionDelete.get(userNorm);
  if (!state || state.awaiting !== "confirm") return false;
  if (deleteStateExpired(state)) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  if (!confirmed) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada.");
    return true;
  }
  const currentIndex = state.currentIndex || 0;
  const currentItem = state.queue?.[currentIndex];
  if (!currentItem || !currentItem.row) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Nenhum lançamento selecionado para excluir.");
    return true;
  }
  await deleteRow(currentItem.row);
  await sendText(
    fromRaw,
    "🗑 Lançamento excluído com sucesso!\n\n💡 Dica: envie *Meus lançamentos* para visualizar sua lista atualizada."
  );
  const nextIndex = currentIndex + 1;
  if (!state.queue || nextIndex >= state.queue.length) {
    sessionDelete.delete(userNorm);
    return true;
  }
  setDeleteState(userNorm, {
    queue: state.queue,
    currentIndex: nextIndex,
    awaiting: "confirm",
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await promptNextDeleteConfirmation(fromRaw, userNorm);
  return true;
}

async function handleDeleteConfirmation(fromRaw, userNorm, text) {
  const normalized = normalizeDiacritics(text).toLowerCase().trim();
  if (!normalized) return false;
  if (/^(s|sim)(\b|\s)/.test(normalized) || /excluir/.test(normalized) || /confirm/.test(normalized)) {
    return finalizeDeleteConfirmation(fromRaw, userNorm, true);
  }
  if (/^(nao|não|n)(\b|\s)/.test(normalized) || /cancel/.test(normalized) || /parar/.test(normalized)) {
    return finalizeDeleteConfirmation(fromRaw, userNorm, false);
  }
  return false;
}

async function handleEditFlow(fromRaw, userNorm, text) {
  const state = sessionEdit.get(userNorm);
  if (!state) return false;
  if (state.expiresAt && Date.now() > state.expiresAt) {
    sessionEdit.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  if (state.awaiting === "index") {
    const indexes = resolveSelectionIndexes(text, state.rows || []);
    if (!indexes.length) {
      await sendText(fromRaw, "Não entendi qual lançamento deseja editar. Informe o número ou o nome.");
      return true;
    }
    const selections = indexes
      .map((idx) => ({ row: state.rows[idx - 1], displayIndex: idx }))
      .filter((item) => item.row);
    if (!selections.length) {
      await sendText(fromRaw, "Não encontrei os lançamentos informados. Tente novamente.");
      return true;
    }
    const first = selections[0];
    sessionEdit.set(userNorm, {
      awaiting: "field",
      rows: state.rows,
      queue: selections,
      currentIndex: 0,
      row: first.row,
      displayIndex: first.displayIndex,
      expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    });
    const summary = formatEntrySummary(first.row, { headerLabel: "🧾 Lançamento selecionado:" });
    await sendText(
      fromRaw,
      `${summary}\n\n✏ Editar lançamento\n\nEscolha o que deseja alterar:\n\n🏷 Conta\n📝 Descrição\n💰 Valor\n📅 Data\n📌 Status\n📂 Categoria\n\n💡 Dica: Digite exatamente o nome do item que deseja editar.\n(ex: valor, data, categoria...)`
    );
    return true;
  }
  if (state.awaiting === "field") {
    const field = text.trim().toLowerCase();
    if (/^cancelar/.test(field)) {
      sessionEdit.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      return true;
    }
    const valid = ["conta", "descricao", "valor", "data", "status", "categoria"];
    if (!valid.includes(field)) {
      await sendText(fromRaw, "Campo inválido. Tente novamente.");
      return true;
    }
    sessionEdit.set(userNorm, {
      ...state,
      awaiting: "value",
      field,
      expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    });
    if (field === "status") {
      await sendText(fromRaw, "Digite a nova situação para status.");
    } else {
      await sendText(fromRaw, `Digite o novo valor para *${field}*.`);
    }
    return true;
  }
  if (state.awaiting === "value") {
    if (/^cancelar/i.test(text.trim())) {
      sessionEdit.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      return true;
    }
    const { row, field } = state;
    if (field === "valor") {
      setVal(row, "valor", toNumber(text));
    } else if (field === "data") {
      const date = parseDateToken(text.trim());
      if (!date) {
        await sendText(fromRaw, "Data inválida. Use dd/mm/aaaa ou palavras como hoje/amanhã.");
        return true;
      }
      const iso = date.toISOString();
      setVal(row, "vencimento_iso", iso);
      setVal(row, "vencimento_br", formatBRDate(date));
      setVal(row, "timestamp", date.toISOString());
    } else if (field === "status") {
      const lower = text.trim().toLowerCase();
      const validStatus = ["pago", "pendente", "recebido"];
      if (!validStatus.includes(lower)) {
        await sendText(fromRaw, "Status inválido. Use pago, pendente ou recebido.");
        return true;
      }
      setVal(row, "status", lower);
    } else if (field === "categoria") {
      const categoria = text.trim();
      const detected = detectCategory(categoria, getVal(row, "tipo"));
      setVal(row, "categoria", categoria || detected.slug);
      setVal(row, "categoria_emoji", detected.emoji);
    } else {
      setVal(row, field === "conta" ? "conta" : "descricao", text.trim());
    }
    await saveRow(row);
    await sendText(fromRaw, "✅ Lançamento atualizado com sucesso!");
    const queue = state.queue || [];
    const nextIndex = (state.currentIndex || 0) + 1;
    if (queue.length && nextIndex < queue.length) {
      const next = queue[nextIndex];
      sessionEdit.set(userNorm, {
        ...state,
        awaiting: "field",
        currentIndex: nextIndex,
        row: next.row,
        displayIndex: next.displayIndex,
        field: undefined,
        expiresAt: Date.now() + SESSION_TIMEOUT_MS,
      });
      const summary = formatEntrySummary(next.row, { headerLabel: "🧾 Lançamento selecionado:" });
      await sendText(
        fromRaw,
        `${summary}\n\n✏ Editar lançamento\n\nEscolha o que deseja alterar:\n\n🏷 Conta\n📝 Descrição\n💰 Valor\n📅 Data\n📌 Status\n📂 Categoria\n\n💡 Dica: Digite exatamente o nome do item que deseja editar.\n(ex: valor, data, categoria...)`
      );
    } else {
      sessionEdit.delete(userNorm);
    }
    return true;
  }
  return false;
}

async function handleFixedDeleteFlow(fromRaw, userNorm, text) {
  const state = sessionFixedDelete.get(userNorm);
  if (!state || state.awaiting !== "index") return false;
  const idx = Number(text.trim());
  if (!idx || idx < 1 || idx > state.rows.length) {
    await sendText(fromRaw, "Número inválido. Tente novamente.");
    return true;
  }
  const row = state.rows[idx - 1];
  sessionFixedDelete.delete(userNorm);
  await confirmDeleteRows(fromRaw, userNorm, [{ row, displayIndex: idx }]);
  return true;
}

async function handleDeleteFlow(fromRaw, userNorm, text) {
  const state = sessionDelete.get(userNorm);
  if (!state) return false;
  if (deleteStateExpired(state)) {
    sessionDelete.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  if (state.awaiting === "index") {
    const indexes = resolveSelectionIndexes(text, state.rows || []);
    if (!indexes.length) {
      await sendText(fromRaw, "Não entendi quais lançamentos você deseja excluir. Informe os números ou o nome.");
      return true;
    }
    const selections = indexes
      .map((idx) => ({ row: state.rows[idx - 1], displayIndex: idx }))
      .filter((item) => item.row);
    if (!selections.length) {
      await sendText(fromRaw, "Não encontrei os lançamentos informados. Tente novamente.");
      return true;
    }
    await confirmDeleteRows(fromRaw, userNorm, selections);
    return true;
  }
  if (state.awaiting === "confirm") {
    return handleDeleteConfirmation(fromRaw, userNorm, text);
  }
  return false;
}

// ============================
// Registro de lançamentos helpers
// ============================
const setStatusState = (userNorm, state) => {
  const current = sessionStatusConfirm.get(userNorm) || {};
  sessionStatusConfirm.set(userNorm, { ...current, ...state });
};

const statusStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

async function sendStatusConfirmationPrompt(to) {
  await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Esse lançamento já foi pago ou ainda está pendente?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "REG:STATUS:PAGO", title: "Pago" } },
          { type: "reply", reply: { id: "REG:STATUS:PENDENTE", title: "Pendente" } },
        ],
      },
    },
  });
}

const sendRegistrationEditPrompt = async (to, rowId, statusLabel) => {
  if (!rowId) return;
  await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `Status identificado automaticamente: ${statusLabel}.\n\nDeseja editar este lançamento?` },
      action: {
        buttons: [
          { type: "reply", reply: { id: `REG:EDIT:${rowId}`, title: "✏ Editar" } },
          { type: "reply", reply: { id: `REG:KEEP:${rowId}`, title: "✅ Manter" } },
        ],
      },
    },
  });
};

const setPaymentCodeState = (userNorm, state) => {
  const current = sessionPaymentCode.get(userNorm) || {};
  sessionPaymentCode.set(userNorm, { ...current, ...state });
};

const paymentCodeStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

const promptAttachPaymentCode = async (to, userNorm, entry, statusSource) => {
  const method = (entry.tipo_pagamento || "").toLowerCase();
  if (!["pix", "boleto"].includes(method)) return;
  setPaymentCodeState(userNorm, {
    awaiting: "choice",
    rowId: entry.row_id,
    metodo: method,
    statusSource,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "💳 Deseja anexar o código do Pix ou boleto para facilitar o pagamento?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: `PAYCODE:ADD:${entry.row_id}`, title: "🔗 Adicionar código" } },
          { type: "reply", reply: { id: `PAYCODE:SKIP:${entry.row_id}`, title: "🚫 Pular" } },
        ],
      },
    },
  });
};

const setPayState = (userNorm, state) => {
  const current = sessionPayConfirm.get(userNorm) || {};
  sessionPayConfirm.set(userNorm, { ...current, ...state });
};

const payStateExpired = (state) => state?.expiresAt && Date.now() > state.expiresAt;

async function promptNextPaymentConfirmation(to, userNorm) {
  const state = sessionPayConfirm.get(userNorm);
  if (!state || !Array.isArray(state.queue) || !state.queue.length) return;
  const currentIndex = state.currentIndex || 0;
  const currentItem = state.queue[currentIndex];
  if (!currentItem || !currentItem.row) {
    sessionPayConfirm.delete(userNorm);
    return;
  }
  const summary = formatEntrySummary(currentItem.row, { headerLabel: "🧾 Lançamento selecionado:" });
  const rowId = getRowIdentifier(currentItem.row);
  const code = (getVal(currentItem.row, "codigo_pagamento") || "").toString().trim();
  const metodo = (getVal(currentItem.row, "tipo_pagamento") || "").toLowerCase();
  const buttons = [{ type: "reply", reply: { id: `PAY:MARK:${rowId}`, title: "✅ Pago" } }];
  if (code) {
    const copyTitle = metodo === "boleto" ? "📋 Copiar boleto" : "📋 Copiar Pix";
    buttons.push({ type: "reply", reply: { id: `PAY:COPY:${rowId}`, title: copyTitle } });
  }
  buttons.push({ type: "reply", reply: { id: "PAY:CANCEL", title: "❌ Cancelar" } });
  setPayState(userNorm, {
    ...state,
    awaiting: "confirm",
    currentIndex,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    currentRowId: rowId,
  });
  const body = `✅ Confirmar pagamento?\n\n${summary}\n\nDeseja marcar como pago agora?`;
  await sendWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: { buttons },
    },
  });
}

async function finalizeRegisterEntry(fromRaw, userNorm, entry, options = {}) {
  const statusSource = options.statusSource || "auto";
  await createRow(entry);
  const resumo = formatEntrySummary(entry);
  const statusLabel = statusIconLabel(entry.status);
  if (entry.tipo === "conta_receber") {
    let message = `💵 Recebimento registrado com sucesso!\n\n${resumo}\n\n🎯 O saldo foi atualizado automaticamente, refletindo sua nova entrada.`;
    if (options.autoStatus) {
      message += `\n\nStatus identificado automaticamente: ${statusLabel}.`;
    }
    await sendText(fromRaw, message);
  } else {
    let message = `✅ Pagamento registrado com sucesso!\n\n${resumo}\n\n💡 A FinPlanner IA já atualizou seu saldo e adicionou este pagamento ao relatório do período.`;
    if (options.autoStatus) {
      message += `\n\nStatus identificado automaticamente: ${statusLabel}.`;
    }
    await sendText(fromRaw, message);
  }

  if (options.autoStatus) {
    await sendRegistrationEditPrompt(fromRaw, entry.row_id, statusLabel);
  }

  if (
    entry.tipo === "conta_pagar" &&
    entry.status === "pendente" &&
    ["pix", "boleto"].includes((entry.tipo_pagamento || "").toLowerCase()) &&
    (options.autoStatus || statusSource === "user_confirm")
  ) {
    await promptAttachPaymentCode(fromRaw, userNorm, entry, statusSource);
  }

  await sendMainMenu(fromRaw);
}

async function handleStatusSelection(fromRaw, userNorm, selectedStatus) {
  const state = sessionStatusConfirm.get(userNorm);
  if (!state) return;
  if (statusStateExpired(state)) {
    sessionStatusConfirm.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return;
  }
  const entry = { ...state.entry };
  if (!entry) {
    sessionStatusConfirm.delete(userNorm);
    return;
  }
  let status = selectedStatus;
  if (entry.tipo === "conta_receber" && status === "pago") status = "recebido";
  entry.status = status;
  entry.timestamp = new Date().toISOString();
  sessionStatusConfirm.delete(userNorm);
  await finalizeRegisterEntry(fromRaw, userNorm, entry, { statusSource: "user_confirm", autoStatus: false });
}

async function handleStatusConfirmationFlow(fromRaw, userNorm, text) {
  const state = sessionStatusConfirm.get(userNorm);
  if (!state) return false;
  if (statusStateExpired(state)) {
    sessionStatusConfirm.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  const normalized = normalizeDiacritics(text).toLowerCase().trim();
  if (!normalized) {
    await sendText(fromRaw, "Não entendi. Toque em Pago ou Pendente para continuar.");
    return true;
  }
  if (/\b(pago|pagou|paguei|pagamos|recebido|recebi|quitado|liquidado)\b/.test(normalized)) {
    await handleStatusSelection(fromRaw, userNorm, "pago");
    return true;
  }
  if (/\b(pendente|a pagar|pagar|em aberto)\b/.test(normalized)) {
    await handleStatusSelection(fromRaw, userNorm, "pendente");
    return true;
  }
  await sendText(fromRaw, "Por favor, informe se o lançamento está Pago ou Pendente.");
  return true;
}

async function handlePaymentCodeFlow(fromRaw, userNorm, text) {
  const state = sessionPaymentCode.get(userNorm);
  if (!state) return false;
  if (paymentCodeStateExpired(state)) {
    sessionPaymentCode.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  if (state.awaiting !== "input") return false;
  const code = text.trim();
  if (!code) {
    await sendText(fromRaw, "Não entendi o código. Envie novamente ou escreva cancelar.");
    return true;
  }
  if (/^cancelar/i.test(code)) {
    sessionPaymentCode.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada.");
    return true;
  }
  const row = await findRowById(userNorm, state.rowId);
  if (!row) {
    sessionPaymentCode.delete(userNorm);
    await sendText(fromRaw, "Não encontrei o lançamento para salvar o código.");
    return true;
  }
  setVal(row, "codigo_pagamento", code);
  await saveRow(row);
  sessionPaymentCode.delete(userNorm);
  const descricao = getVal(row, "descricao") || getVal(row, "conta") || "Lançamento";
  await sendText(
    fromRaw,
    `✅ Código anexado com sucesso!\n\nDescrição do lançamento\n\n📝 Descrição: ${descricao}\n📎 Código armazenado com segurança.`
  );
  return true;
}

async function handlePaymentConfirmFlow(fromRaw, userNorm, text) {
  const state = sessionPayConfirm.get(userNorm);
  if (!state) return false;
  if (payStateExpired(state)) {
    sessionPayConfirm.delete(userNorm);
    await sendText(fromRaw, "Operação cancelada por tempo excedido.");
    return true;
  }
  const normalizedText = normalizeDiacritics(text).toLowerCase().trim();
  if (state.awaiting === "index") {
    if (/cancel/.test(normalizedText)) {
      sessionPayConfirm.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      return true;
    }
    const indexes = resolveSelectionIndexes(text, state.rows || []);
    if (!indexes.length) {
      await sendText(fromRaw, "Não entendi quais contas deseja confirmar. Informe os números.");
      return true;
    }
    const selections = indexes
      .map((idx) => ({ row: state.rows[idx - 1], displayIndex: idx }))
      .filter((item) => item.row);
    if (!selections.length) {
      await sendText(fromRaw, "Não encontrei os lançamentos informados. Tente novamente.");
      return true;
    }
    setPayState(userNorm, {
      rows: state.rows,
      queue: selections,
      currentIndex: 0,
      awaiting: "confirm",
      expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    });
    await promptNextPaymentConfirmation(fromRaw, userNorm);
    return true;
  }
  if (state.awaiting === "confirm") {
    if (!normalizedText) {
      await sendText(fromRaw, "Responda com Pago ou Cancelar para continuar.");
      return true;
    }
    if (/pago|confirm/.test(normalizedText)) {
      const current = state.queue?.[state.currentIndex || 0];
      if (!current || !current.row) {
        sessionPayConfirm.delete(userNorm);
        return true;
      }
      await markPaymentAsPaid(fromRaw, userNorm, current.row);
      return true;
    }
    if (/cancel/.test(normalizedText)) {
      sessionPayConfirm.delete(userNorm);
      await sendText(fromRaw, "Operação cancelada.");
      return true;
    }
    if (/copiar|codigo|boleto|pix/.test(normalizedText)) {
      const current = state.queue?.[state.currentIndex || 0];
      if (current?.row) {
        await sendPaymentCode(fromRaw, current.row);
        setPayState(userNorm, { ...state, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      }
      return true;
    }
    await sendText(fromRaw, "Responda com Pago ou escolha uma opção nos botões.");
    return true;
  }
  return false;
}

async function sendPaymentCode(to, row) {
  const code = (getVal(row, "codigo_pagamento") || "").toString().trim();
  if (!code) {
    await sendText(to, "Não há código salvo para este lançamento.");
    return;
  }
  const metodo = (getVal(row, "tipo_pagamento") || "").toLowerCase();
  const label = metodo === "boleto" ? "código de barras" : "chave Pix";
  await sendText(to, `📎 Aqui está o ${label}:\n${code}`);
}

async function markPaymentAsPaid(fromRaw, userNorm, row) {
  if (!row) return;
  setVal(row, "status", "pago");
  setVal(row, "timestamp", new Date().toISOString());
  await saveRow(row);
  await sendText(fromRaw, `✅ Pagamento confirmado com sucesso!\n\n${formatEntrySummary(row)}`);
  const state = sessionPayConfirm.get(userNorm);
  if (!state) {
    sessionPayConfirm.delete(userNorm);
    return;
  }
  const nextIndex = (state.currentIndex || 0) + 1;
  if (!state.queue || nextIndex >= state.queue.length) {
    sessionPayConfirm.delete(userNorm);
    return;
  }
  setPayState(userNorm, {
    ...state,
    currentIndex: nextIndex,
    awaiting: "confirm",
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  });
  await promptNextPaymentConfirmation(fromRaw, userNorm);
}

// ============================
// Registro de lançamentos
// ============================
async function registerEntry(fromRaw, userNorm, text, tipoPreferencial) {
  const parsed = parseRegisterText(text);
  if (tipoPreferencial) parsed.tipo = tipoPreferencial;
  if (!parsed.valor) {
    await sendText(fromRaw, "Não consegui identificar o valor. Informe algo como 150, R$150,00 ou \"cem reais\".");
    return;
  }
  let data = parsed.data instanceof Date ? parsed.data : null;
  if (!data || Number.isNaN(data.getTime())) data = new Date();
  const iso = data.toISOString();
  const categoria = detectCategory(parsed.descricao, parsed.tipo);
  const payload = {
    row_id: generateRowId(),
    timestamp: new Date().toISOString(),
    user: userNorm,
    user_raw: fromRaw,
    tipo: parsed.tipo,
    conta: parsed.descricao,
    valor: parsed.valor,
    vencimento_iso: iso,
    vencimento_br: formatBRDate(data),
    tipo_pagamento: parsed.tipoPagamento || "",
    codigo_pagamento: "",
    status: parsed.status || "pendente",
    fixa: "nao",
    fix_parent_id: "",
    vencimento_dia: data.getDate(),
    categoria: categoria.slug,
    categoria_emoji: categoria.emoji,
    descricao: parsed.descricao,
  };
  if (!parsed.statusDetected) {
    payload.status = "pendente";
    setStatusState(userNorm, { entry: { ...payload }, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
    await sendStatusConfirmationPrompt(fromRaw);
    return;
  }

  await finalizeRegisterEntry(fromRaw, userNorm, payload, { autoStatus: true, statusSource: "auto" });
}

// ============================
// Intent detection
// ============================
const detectIntent = (text) => {
  const lower = (text || "").toLowerCase();
  const normalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/(oi|ola|opa|bom dia|boa tarde|boa noite)/.test(normalized)) return "boas_vindas";
  if (/\brelat[óo]rios?\b/.test(lower)) return "relatorios_menu";
  if (/\brelat[óo]rio\s+completo\b/.test(lower) || /\bcompleto\b/.test(lower)) return "relatorio_completo";
  if (/\blan[cç]amentos\b|extrato/.test(lower)) return "listar_lancamentos";
  if (/contas?\s+a\s+pagar|pendentes|a pagar/.test(lower)) return "listar_pendentes";
  if (/editar lan[cç]amentos?/.test(lower)) return "editar";
  if (/excluir lan[cç]amentos?/.test(lower)) return "excluir";
  if (/registrar recebimento|recebimento/.test(lower)) return "registrar_recebimento";
  if (/registrar pagamento|pagamento/.test(lower)) return "registrar_pagamento";
  return "desconhecido";
};

// ============================
// Webhook
// ============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

async function handleInteractiveMessage(from, payload) {
  const { type } = payload;
  const userNorm = normalizeUser(from);
  if (type === "button_reply") {
    const id = payload.button_reply.id;
    if (id === "REG:STATUS:PAGO") {
      await handleStatusSelection(from, userNorm, "pago");
      return;
    }
    if (id === "REG:STATUS:PENDENTE") {
      await handleStatusSelection(from, userNorm, "pendente");
      return;
    }
    if (id.startsWith("REG:EDIT:")) {
      const [, , rowId] = id.split(":");
      const row = await findRowById(userNorm, rowId);
      if (!row) {
        await sendText(from, "Não encontrei o lançamento para editar.");
        return;
      }
      sessionEdit.set(userNorm, {
        awaiting: "field",
        rows: [row],
        queue: [{ row, displayIndex: 1 }],
        currentIndex: 0,
        row,
        displayIndex: 1,
        expiresAt: Date.now() + SESSION_TIMEOUT_MS,
      });
      const summary = formatEntrySummary(row, { headerLabel: "🧾 Lançamento selecionado:" });
      await sendText(
        from,
        `${summary}\n\n✏ Editar lançamento\n\nEscolha o que deseja alterar:\n\n🏷 Conta\n📝 Descrição\n💰 Valor\n📅 Data\n📌 Status\n📂 Categoria\n\n💡 Dica: Digite exatamente o nome do item que deseja editar.\n(ex: valor, data, categoria...)`
      );
      return;
    }
    if (id.startsWith("REG:KEEP:")) {
      await sendText(from, "Perfeito! O lançamento foi mantido como está.");
      return;
    }
    if (id.startsWith("PAYCODE:ADD:")) {
      const [, , rowId] = id.split(":");
      const state = sessionPaymentCode.get(userNorm);
      if (state && state.rowId === rowId) {
        setPaymentCodeState(userNorm, { awaiting: "input", rowId, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      } else {
        setPaymentCodeState(userNorm, { awaiting: "input", rowId, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      }
      await sendText(from, "🔗 Envie o código do Pix (cópia e cola ou chave Pix) ou o código de barras do boleto.");
      return;
    }
    if (id.startsWith("PAYCODE:SKIP:")) {
      sessionPaymentCode.delete(userNorm);
      await sendText(from, "Tudo bem! Se precisar anexar depois, é só me avisar.");
      return;
    }
    if (id.startsWith("PAY:MARK:")) {
      const [, , rowId] = id.split(":");
      const state = sessionPayConfirm.get(userNorm);
      const current = state?.queue?.[state.currentIndex || 0];
      if (current?.row && getRowIdentifier(current.row) === rowId) {
        await markPaymentAsPaid(from, userNorm, current.row);
      } else {
        await sendText(from, "Não encontrei o lançamento selecionado para confirmar.");
      }
      return;
    }
    if (id === "PAY:CANCEL") {
      sessionPayConfirm.delete(userNorm);
      await sendText(from, "Operação cancelada.");
      return;
    }
    if (id.startsWith("PAY:COPY:")) {
      const [, , rowId] = id.split(":");
      const row = await findRowById(userNorm, rowId);
      if (row) {
        await sendPaymentCode(from, row);
      } else {
        await sendText(from, "Não encontrei um código salvo para este lançamento.");
      }
      const state = sessionPayConfirm.get(userNorm);
      if (state) setPayState(userNorm, { ...state, expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      return;
    }
    if (id === "DEL:CONFIRM:YES") {
      const handled = await finalizeDeleteConfirmation(from, userNorm, true);
      if (!handled) {
        await sendText(from, "Nenhum lançamento selecionado para excluir.");
      }
      return;
    }
    if (id === "DEL:CONFIRM:NO") {
      await finalizeDeleteConfirmation(from, userNorm, false);
      return;
    }
    if (id.startsWith("REL:CAT:")) {
      const [, , cat] = id.split(":");
      await startReportCategoryFlow(from, userNorm, cat);
      return;
    }
    if (id.startsWith("REL:PER:")) {
      const [, , cat, opt] = id.split(":");
      const now = new Date();
      if (opt === "mes_atual") {
        const range = {
          start: startOfMonth(now.getFullYear(), now.getMonth()),
          end: endOfMonth(now.getFullYear(), now.getMonth()),
        };
        await showReportByCategory(from, userNorm, cat, range);
        sessionPeriod.delete(userNorm);
      }
      if (opt === "todo_periodo") {
        const rows = await allRowsForUser(userNorm);
        let min = null;
        rows.forEach((row) => {
          const dt = getEffectiveDate(row);
          if (dt && (!min || dt < min)) min = dt;
        });
        const start = min ? startOfDay(min) : startOfDay(new Date());
        const end = endOfDay(new Date());
        await showReportByCategory(from, userNorm, cat, { start, end });
        sessionPeriod.delete(userNorm);
      }
      if (opt === "personalizado") {
        sessionPeriod.set(userNorm, { mode: "report", category: cat, awaiting: "range" });
        await sendText(
          from,
          `🗓️ *Selecione um período personalizado*\n\nEnvie no formato:\n01/10/2025 a 31/10/2025\n\n💡 Dica: você pode usar "a", "-", "até".`
        );
      }
      return;
    }
    if (id.startsWith("LANC:PER:")) {
      const [, , opt] = id.split(":");
      const now = new Date();
      if (opt === "hoje") {
        const start = startOfDay(now);
        const end = endOfDay(now);
        await showLancamentos(from, userNorm, { start, end });
      } else if (opt === "mes_atual") {
        const range = {
          start: startOfMonth(now.getFullYear(), now.getMonth()),
          end: endOfMonth(now.getFullYear(), now.getMonth()),
        };
        await showLancamentos(from, userNorm, range);
      } else if (opt === "personalizado") {
        sessionPeriod.set(userNorm, { mode: "lanc", awaiting: "range" });
        await sendText(
          from,
          `🗓️ *Selecione um período personalizado*\n\nEnvie no formato:\n01/10/2025 a 31/10/2025\n\n💡 Dica: você pode usar "a", "-", "até".`
        );
      }
      return;
    }
    if (id === "DEL:LAST") {
      const rows = await allRowsForUser(userNorm);
      const sorted = rows.sort((a, b) => new Date(getVal(b, "timestamp")) - new Date(getVal(a, "timestamp")));
      const last = sorted[0];
      if (!last) {
        await sendText(from, "Não há lançamentos para excluir.");
        return;
      }
      await confirmDeleteRows(from, userNorm, [{ row: last, displayIndex: 1 }]);
      return;
    }
    if (id === "DEL:LIST") {
      await listRowsForSelection(from, userNorm, "delete");
      return;
    }
    if (id === "CFIX:CAD") {
      await sendCadastrarContaFixaMessage(from);
      return;
    }
    if (id === "CFIX:LIST") {
      await sendListarContasFixasMessage(from, userNorm);
      return;
    }
    if (id === "CFIX:DEL") {
      await sendExcluirContaFixaMessage(from, userNorm);
      return;
    }
  }

  if (type === "list_reply") {
    const id = payload.list_reply.id;
    if (id.startsWith("REL:CAT:")) {
      const [, , cat] = id.split(":");
      await startReportCategoryFlow(from, userNorm, cat);
      return;
    }
    if (id === "MENU:registrar_pagamento") {
      sessionRegister.set(userNorm, { tipo: "conta_pagar" });
      await sendText(
        from,
        `💰 Novo lançamento de pagamento ou gasto\n\nInforme os detalhes abaixo para registrar corretamente:\n\n📝 Descrição: O que foi pago?\n(ex: Conta de luz, Internet, Academia)\n\n💰 Valor: Quanto custou?\n(ex: 120,00)\n\n📅 Data: Quando foi pago ou deve ser pago?\n(ex: hoje, amanhã ou 25/10/2025)\n\n🏷 Status: Já foi pago ou ainda está pendente?\n(ex: pago / pendente)\n\n📂 Categoria: (opcional)\nA FinPlanner identifica automaticamente, mas você pode informar (ex: Internet, Energia, Alimentação).\n\n💡 Dica: Você também pode escrever tudo em uma linha!\nExemplo:\n➡ Pagar internet 120 amanhã\n➡ Academia 80,00 pago hoje`
      );
      return;
    }
    if (id === "MENU:registrar_recebimento") {
      sessionRegister.set(userNorm, { tipo: "conta_receber" });
      await sendText(
        from,
        `💵 Novo lançamento de recebimento\n\nInforme os detalhes abaixo para registrar sua entrada de dinheiro:\n\n📝 Descrição: O que você recebeu?\n(ex: Venda de peças, Salário, Reembolso)\n\n💰 Valor: Quanto foi recebido?\n(ex: 300,00)\n\n📅 Data: Quando foi ou será recebido?\n(ex: hoje, amanhã ou 30/10/2025)\n\n🏷 Status: Já recebeu ou ainda está pendente?\n(ex: recebido / pendente)\n\n📂 Categoria: (opcional)\nA FinPlanner identifica automaticamente (ex: Venda, Salário, Transferência).\n\n💡 Dica: Você pode enviar tudo de uma vez!\nExemplo:\n➡ Receber venda 300 amanhã\n➡ Pix recebido cliente 150 hoje`
      );
      return;
    }
    if (id === "MENU:contas_pagar") {
      await listPendingPayments(from, userNorm);
      return;
    }
    if (id === "MENU:contas_fixas") {
      await sendContasFixasMenu(from);
      return;
    }
    if (id === "MENU:relatorios") {
      await sendRelatoriosButtons(from);
      return;
    }
    if (id === "MENU:lancamentos") {
      await sendLancPeriodoButtons(from);
      return;
    }
    if (id === "MENU:editar") {
      await listRowsForSelection(from, userNorm, "edit");
      return;
    }
    if (id === "MENU:excluir") {
      await sendDeleteMenu(from);
      return;
    }
    if (id === "MENU:ajuda") {
      await sendText(
        from,
        `⚙️ *Ajuda & Exemplos*\n\n🧾 Registrar pagamento\nEx.: Internet 120 pago hoje\n\n💵 Registrar recebimento\nEx.: Venda curso 200 recebido hoje\n\n📊 Relatórios\nToque em Relatórios → escolha *Contas a pagar*, *Recebimentos* ou *Pagamentos* → selecione o período.\n\n🧾 Meus lançamentos\nToque em Meus lançamentos → escolha *Mês atual* ou *Data personalizada*.\n\n✏️ Editar lançamentos\nToque em Editar lançamentos → escolha pelo número → selecione o que deseja alterar.\n\n🗑️ Excluir lançamento\nToque em Excluir lançamento → Último lançamento ou Listar lançamentos.`
      );
      return;
    }
  }
}

function parseRangeMessage(text) {
  const match = text.match(/(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}).*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/);
  if (!match) return null;
  const start = parseDateToken(match[1]);
  const end = parseDateToken(match[2]);
  if (!start || !end) return null;
  return { start: startOfDay(start), end: endOfDay(end) };
}

async function handleUserText(fromRaw, text) {
  const userNorm = normalizeUser(fromRaw);
  const trimmed = (text || "").trim();

  if (await handlePaymentCodeFlow(fromRaw, userNorm, trimmed)) return;
  if (await handleStatusConfirmationFlow(fromRaw, userNorm, trimmed)) return;
  if (await handlePaymentConfirmFlow(fromRaw, userNorm, trimmed)) return;
  if (await handleFixedDeleteFlow(fromRaw, userNorm, trimmed)) return;
  if (await handleEditFlow(fromRaw, userNorm, trimmed)) return;
  if (await handleDeleteFlow(fromRaw, userNorm, trimmed)) return;

  const regState = sessionRegister.get(userNorm);
  if (regState) {
    await registerEntry(fromRaw, userNorm, text, regState.tipo);
    sessionRegister.delete(userNorm);
    return;
  }

  const perState = sessionPeriod.get(userNorm);
  if (perState && perState.awaiting === "range") {
    const range = parseRangeMessage(trimmed.replace(/até/gi, "-").replace(/a/gi, "-"));
    if (!range) {
      await sendText(fromRaw, "Formato inválido. Use 01/10/2025 a 31/10/2025.");
      return;
    }
    if (perState.mode === "report") {
      await showReportByCategory(fromRaw, userNorm, perState.category, range);
    } else if (perState.mode === "lanc") {
      await showLancamentos(fromRaw, userNorm, range);
    }
    sessionPeriod.delete(userNorm);
    return;
  }

  const intent = detectIntent(trimmed);
  switch (intent) {
    case "boas_vindas":
      await sendWelcomeList(fromRaw);
      break;
    case "relatorios_menu":
      await sendRelatoriosButtons(fromRaw);
      break;
    case "relatorio_completo": {
      const now = new Date();
      const range = {
        start: startOfMonth(now.getFullYear(), now.getMonth()),
        end: endOfMonth(now.getFullYear(), now.getMonth()),
      };
      await showReportByCategory(fromRaw, userNorm, "all", range);
      break;
    }
    case "listar_lancamentos":
      await sendLancPeriodoButtons(fromRaw);
      break;
    case "listar_pendentes":
      await listPendingPayments(fromRaw, userNorm);
      break;
    case "editar":
      await listRowsForSelection(fromRaw, userNorm, "edit");
      break;
    case "excluir":
      await sendDeleteMenu(fromRaw);
      break;
    case "registrar_recebimento":
      await registerEntry(fromRaw, userNorm, text, "conta_receber");
      break;
    case "registrar_pagamento":
      await registerEntry(fromRaw, userNorm, text, "conta_pagar");
      break;
    default:
      if (extractAmountFromText(trimmed).amount) {
        await registerEntry(fromRaw, userNorm, text);
      } else {
        await sendMainMenu(fromRaw);
      }
      break;
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body?.object === "whatsapp_business_account") {
      const entry = body.entry || [];
      for (const ent of entry) {
        const changes = ent.changes || [];
        for (const change of changes) {
          const value = change.value || {};
          const messages = value.messages || [];
          const statuses = value.statuses || [];

          for (const status of statuses) {
            if (status.status === "failed" && ADMIN_WA_NUMBER) {
              await sendText(
                ADMIN_WA_NUMBER,
                `⚠️ Falha ao entregar mensagem para ${status.recipient_id}: ${status.errors?.[0]?.title || ""}`
              );
            }
          }

          for (const message of messages) {
            const from = message.from;
            const type = message.type;
            if (type === "text") {
              await handleUserText(from, message.text?.body || "");
            } else if (type === "interactive") {
              await handleInteractiveMessage(from, message.interactive);
            } else if (type === "button") {
              await handleInteractiveMessage(from, { type: "button_reply", button_reply: message.button });
            } else {
              await sendText(from, "Ainda não entendi esse tipo de mensagem, envie texto ou use o menu.");
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error.message);
    res.sendStatus(200);
  }
});

// ============================
// CRON diário 08:00 (America/Maceio)
// ============================
cron.schedule(
  "0 8 * * *",
  async () => {
    try {
      const sheet = await ensureSheet();
      const rows = await sheet.getRows();
      const today = startOfDay(new Date()).getTime();

      const duePay = rows
        .filter((row) => getVal(row, "tipo") === "conta_pagar" && getVal(row, "status") !== "pago" && getVal(row, "vencimento_iso"))
        .filter((row) => startOfDay(new Date(getVal(row, "vencimento_iso"))).getTime() === today);

      const dueRecv = rows
        .filter(
          (row) =>
            getVal(row, "tipo") === "conta_receber" &&
            !["pago", "recebido"].includes((getVal(row, "status") || "").toLowerCase()) &&
            getVal(row, "vencimento_iso")
        )
        .filter((row) => startOfDay(new Date(getVal(row, "vencimento_iso"))).getTime() === today);

      const notify = async (row, isReceber = false) => {
        const toRaw = getVal(row, "user_raw") || getVal(row, "user");
        const tipoTxt = isReceber ? "recebimento" : "pagamento";
        await sendText(
          toRaw,
          `⚠️ *Lembrete de ${tipoTxt}!*\n\n📘 ${getVal(row, "conta") || "Lançamento"}\n📝 ${getVal(row, "descricao") || getVal(row, "conta") || "—"}\n💰 ${formatCurrencyBR(
            getVal(row, "valor")
          )}\n📅 Para hoje (${formatBRDate(getVal(row, "vencimento_iso"))})`
        );
        if (getVal(row, "tipo_pagamento") === "pix")
          await sendCopyButton(toRaw, "💳 Chave Pix:", getVal(row, "codigo_pagamento"), "Copiar Pix");
        if (getVal(row, "tipo_pagamento") === "boleto")
          await sendCopyButton(toRaw, "🧾 Código de barras:", getVal(row, "codigo_pagamento"), "Copiar boleto");
      };

      for (const row of duePay) await notify(row, false);
      for (const row of dueRecv) await notify(row, true);
    } catch (error) {
      console.error("Erro no CRON:", error.message);
    }
  },
  { timezone: "America/Maceio" }
);

// ============================
// Server
// ============================
const port = PORT || 10000;
app.listen(port, () => {
  console.log(`FinPlanner IA (2025-10-23) rodando na porta ${port}`);
});
