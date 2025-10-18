// ============================
// FinPlanner IA - WhatsApp Bot (versão 2025-10-18.7)
// ============================
// 🧠 IA apenas interpreta → respostas SEMPRE padronizadas
// 💾 Registra contas/recebimentos (passado e futuro)
// 💬 Valores sempre no formato “R$0,00”
// 🔔 Lembretes + botões Pix/Boleto/Confirmar (≤20 chars)
// 📊 Relatórios: mensal e período personalizado (até 1 ano)
// 🚫 Nunca menciona "planilha" ao usuário
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
// Logs de diagnóstico
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
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}
const doc = new GoogleSpreadsheet(SHEETS_ID);

async function ensureAuth() {
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_KEY || !SHEETS_ID) {
    console.error("❌ Auth Google Sheets: variáveis ausentes");
    throw new Error("Variáveis de autenticação ausentes");
  }
  try {
    await doc.useServiceAccountAuth({
      client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: GOOGLE_SERVICE_ACCOUNT_KEY,
    });
    await doc.loadInfo();
  } catch (e) {
    console.error("❌ Falha auth Google Sheets:", e.message);
    throw e;
  }
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
// Utilitários
// ----------------------------
const uuidShort = () => crypto.randomBytes(6).toString("hex");
const today0 = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
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
  const cpf=(t||"").match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
  const cnpj=(t||"").match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/);
  const chave=(t||"").match(/[0-9a-f]{32,}|[0-9a-f-]{36}/i);
  return hasPix?(email?.[0]||phone?.[0]||cpf?.[0]||cnpj?.[0]||chave?.[0]):null;
}

// datas relativas e exatas dentro da frase
function parseDueDate(t){
  const now=new Date();
  const dmY=(t||"").match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if(dmY){
    let[_,d,m,y]=dmY;
    const year=y? (y.length===2?2000+parseInt(y):parseInt(y)):now.getFullYear();
    return new Date(year,parseInt(m)-1,parseInt(d));
  }
  if(/\bontem\b/i.test(t||"")){const d=new Date(now);d.setDate(d.getDate()-1);return d;}
  if(/\bamanh[aã]\b/i.test(t||"")){const d=new Date(now);d.setDate(d.getDate()+1);return d;}
  if(/\bhoje\b/i.test(t||"")) return now;
  if(/\bsegunda\b/i.test(t||""))return proxWeekday(now,1);
  if(/\bterça|terca\b/i.test(t||""))return proxWeekday(now,2);
  if(/\bquarta\b/i.test(t||""))return proxWeekday(now,3);
  if(/\bquinta\b/i.test(t||""))return proxWeekday(now,4);
  if(/\bsexta\b/i.test(t||""))return proxWeekday(now,5);
  return null;
}
function proxWeekday(ref, dow){ // 0=dom, 1=seg...
  const d=new Date(ref); const delta=(dow - d.getDay() + 7) % 7 || 7; d.setDate(d.getDate()+delta); return d;
}
function guessBillName(t){
  const labels=["energia","luz","água","agua","internet","aluguel","telefone","cartão","cartao","condominio","mercado","iptu","ipva"];
  const lower=(t||"").toLowerCase();
  for(const l of labels) if(lower.includes(l)) return l.charAt(0).toUpperCase()+l.slice(1);
  const who=(t||"").match(/\b(?:pra|para|ao|a|à|de)\s+([\wÁÉÍÓÚÂÊÔÃÕÇ]+)/i);
  return who? capitalize(who[1]) : (capitalize(lower.split(/\s+/).slice(0,3).join(" ")) || "Lançamento");
}
const capitalize = s => (s||"").replace(/\b\w/g, c => c.toUpperCase());

// ----------------------------
// WhatsApp - envio
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

// ----------------------------
// Intenções (regras + IA)
// ----------------------------
async function detectIntent(t){
  const lower=(t||"").toLowerCase();
  // novas palavras: ganho, receita; meus recebimentos; relatorio; funcoes/ajuda
  if(/\b(oi|olá|ola|opa|bom dia|boa tarde|boa noite)\b/.test(lower)) return "boas_vindas";
  if(/\b(funções|funcoes|ajuda|help)\b/.test(lower)) return "funcoes";
  if(/\b(meus pagamentos|listar pagamentos|mostrar pagamentos)\b/.test(lower)) return "listar_contas";
  if(/\b(meus recebimentos|listar recebimentos|mostrar recebimentos)\b/.test(lower)) return "listar_recebimentos";
  if(/\b(relat[óo]rio|resumo)\b/.test(lower)) return "relatorio";
  if(/\b(pagar|pagamento|transferir|enviar|quitar|liquidar)\b/.test(lower)) return "nova_conta";
  if(/\b(receber|entrada|venda|ganhar|ganho|receita)\b/.test(lower)) return "novo_recebimento";
  if(/\bconfirm(ar)? pagamento|paguei|pago|liquidei|baixei\b/.test(lower)) return "confirmar_pagamento";

  if(USE_OPENAI&&openai){
    try{
      const r=await openai.responses.create({
        model:"gpt-4.1-mini",
        input:`Classifique a frase em: boas_vindas, funcoes, listar_contas, listar_recebimentos, relatorio, nova_conta, novo_recebimento, confirmar_pagamento, fora_contexto, desconhecido.\nFrase: ${t}`
      });
      const label=(r.output_text||"").trim().toLowerCase();
      if(["boas_vindas","funcoes","listar_contas","listar_recebimentos","relatorio","nova_conta","novo_recebimento","confirmar_pagamento","fora_contexto"].includes(label))
        return label;
    }catch{/* ignora */}
  }
  return "desconhecido";
}

// ----------------------------
// Extrações
// ----------------------------
function extractEntities(text){
  const conta=guessBillName(text);
  const valor=parseCurrencyBR(text);
  const vencimento=parseDueDate(text);
  const pix=detectPixKey(text);
  const boleto=pix?null:detectBarcode(text);
  let tipo_pagamento="", codigo_pagamento="";
  if(pix){tipo_pagamento="pix";codigo_pagamento=pix;}
  else if(boleto){tipo_pagamento="boleto";codigo_pagamento=boleto;}
  return { conta, valor, vencimento, tipo_pagamento, codigo_pagamento };
}

// Períodos de relatório
function parseReportPeriod(t){
  // Padrão: "dd/mm/yyyy a dd/mm/yyyy" ou "dd/mm/yyyy até dd/mm/yyyy"
  const reRange=/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:a|até|ate|-)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i;
  const m=t.match(reRange);
  if(m){
    const from=brToDate(m[1]); const to=brToDate(m[2]);
    if(from && to && (to - from) <= 366*24*3600*1000) return { type:"custom", start:today0(from), end:endOfDay(to) };
    return null;
  }
  // "mês 10/2025" ou "10/2025" ou "Outubro/2025"
  const reMonth=/(?:m[eê]s\s*)?(\d{1,2})\/(\d{4})/i;
  const mm=t.match(reMonth);
  if(mm){
    const month=parseInt(mm[1])-1, year=parseInt(mm[2]);
    const start=new Date(year,month,1);
    const end=new Date(year,month+1,0); // último dia
    return { type:"monthly", start:today0(start), end:endOfDay(end) };
  }
  // Se só "relatório" → mês atual
  const now=new Date();
  const start=new Date(now.getFullYear(), now.getMonth(), 1);
  const end=new Date(now.getFullYear(), now.getMonth()+1, 0);
  return { type:"monthly", start:today0(start), end:endOfDay(end) };
}
function brToDate(s){const m=s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(!m)return null;return new Date(parseInt(m[3]),parseInt(m[2])-1,parseInt(m[1]));}
const endOfDay = d => { const x = new Date(d); x.setHours(23,59,59,999); return x; };

// ----------------------------
// Mensagens padrão (NUNCA citar planilha)
// ----------------------------
const MSG = {
  BOAS_VINDAS:
`👋 *Olá! Eu sou a FinPlanner IA.*

💡 *Sou sua assistente financeira. Organizo seus pagamentos e recebimentos de forma simples e automática.*

Você pode me enviar mensagens como:

💰 *Pagar uma conta*
→ \`Pagar internet R$120,00 amanhã\`
→ \`Energia R$157,68 vence 25/10/2025\`

💸 *Registrar um recebimento*
→ \`Receber venda de óleo R$90,00 sexta\`
→ \`Ganhar R$300,00 com entrega 28/10/2025\`

📋 *Ver seus lançamentos*
→ \`Meus pagamentos\`
→ \`Meus recebimentos\`

🔔 *Eu te aviso automaticamente no dia do vencimento.*`,
  AJUDA:
`⚙️ *Funções principais da FinPlanner IA*

💰 *Registrar pagamentos*
→ \`Pagar energia R$150,00 amanhã\`

💸 *Registrar recebimentos*
→ \`Receber venda de óleo R$90,00 25/10/2025\`

📅 *Listar movimentações*
→ \`Meus pagamentos\`
→ \`Meus recebimentos\`

📊 *Relatórios*
→ \`Relatório 10/2025\`
→ \`Relatório 01/08/2025 a 30/09/2025\`

✅ *Confirmar pagamentos*
→ \`Paguei aluguel\`

🔔 *Receba lembretes automáticos no dia do vencimento.*`,
  NAO_ENTENDI:
`🤔 *Não consegui entender sua mensagem.*

Experimente algo assim:

💰 \`Pagar aluguel R$800,00 05/11/2025\`
💸 \`Receber R$300,00 de João amanhã\`
📅 \`Energia R$157,68 vence hoje\`
📊 \`Relatório 10/2025\`
⚙️ \`Funções\` (para ver tudo o que posso fazer)`,
  CONTA_OK: (conta, valorFmt, dataFmt) =>
`🧾 *Lançamento registrado!*

📘 Descrição: ${conta || "Conta"}
💰 Valor: ${valorFmt}
📅 Vencimento: ${dataFmt}`,
  RECEB_OK: (conta, valorFmt, dataFmt) =>
`💸 *Recebimento registrado!*

📘 Descrição: ${conta || "Recebimento"}
💰 Valor: ${valorFmt}
📅 Data: ${dataFmt}`,
  CONFIRM_OK: "✅ *Pagamento confirmado!*",
  LISTA_PAG_VAZIA: "✅ Você não tem pagamentos pendentes.",
  LISTA_REC_VAZIA: "✅ Você não tem recebimentos futuros.",
  LEMBRETE: (conta, valorFmt, dataFmt) =>
`⚠️ *Lembrete de pagamento!*

📘 ${conta || "Conta"}
💰 ${valorFmt}
📅 Vence hoje (${dataFmt})`,
};

// ----------------------------
// Fluxos
// ----------------------------
async function handleUserText(from, text){
  const intent = await detectIntent(text);
  const sheet = await ensureSheet();

  if (intent === "boas_vindas") { await sendText(from, MSG.BOAS_VINDAS); return; }
  if (intent === "funcoes") { await sendText(from, MSG.AJUDA); return; }

  if (intent === "listar_contas") {
    const rows = await sheet.getRows();
    const pend = rows
      .filter(r => typeof r.get==="function" && r.get("user")===from && r.get("tipo")==="conta_pagar" && r.get("status")!=="pago")
      .map(r => ({ conta: r.get("conta"), valor: parseFloat(r.get("valor")||"0"), ven: r.get("vencimento_iso")? new Date(r.get("vencimento_iso")): null }))
      .sort((a,b)=> (a.ven?.getTime()||0)-(b.ven?.getTime()||0))
      .slice(0,12);
    if(!pend.length){ await sendText(from, MSG.LISTA_PAG_VAZIA); return; }
    let msg="📋 *Pagamentos pendentes:*\n\n";
    for(const p of pend){ msg += `• ${formatBRDate(p.ven)} — ${p.conta} (${formatCurrencyBR(p.valor)})\n`; }
    await sendText(from, msg.trim()); return;
  }

  if (intent === "listar_recebimentos") {
    const rows = await sheet.getRows();
    const recs = rows
      .filter(r => typeof r.get==="function" && r.get("user")===from && r.get("tipo")==="conta_receber" && r.get("status")!=="pago")
      .map(r => ({ conta: r.get("conta"), valor: parseFloat(r.get("valor")||"0"), ven: r.get("vencimento_iso")? new Date(r.get("vencimento_iso")): null }))
      .sort((a,b)=> (a.ven?.getTime()||0)-(b.ven?.getTime()||0))
      .slice(0,12);
    if(!recs.length){ await sendText(from, MSG.LISTA_REC_VAZIA); return; }
    let msg="📋 *Recebimentos futuros:*\n\n";
    for(const p of recs){ msg += `• ${formatBRDate(p.ven)} — ${p.conta} (${formatCurrencyBR(p.valor)})\n`; }
    await sendText(from, msg.trim()); return;
  }

  if (intent === "relatorio") {
    const prd = parseReportPeriod(text.toLowerCase());
    if(!prd){ await sendText(from, "⚠️ *Período inválido.* Tente:\n• `Relatório 10/2025`\n• `Relatório 01/08/2025 a 30/09/2025`"); return; }
    const rows = await sheet.getRows();
    const inRange = (dt) => dt && (dt >= prd.start && dt <= prd.end);

    const mine = rows.filter(r => typeof r.get==="function" && r.get("user")===from);
    const gastos = mine.filter(r => r.get("tipo")==="conta_pagar" && inRange(r.get("vencimento_iso")? new Date(r.get("vencimento_iso")): null));
    const receitas = mine.filter(r => r.get("tipo")==="conta_receber" && inRange(r.get("vencimento_iso")? new Date(r.get("vencimento_iso")): null));

    const totGastos = gastos.reduce((a,r)=> a + parseFloat(r.get("valor")||"0"), 0);
    const totReceitas = receitas.reduce((a,r)=> a + parseFloat(r.get("valor")||"0"), 0);
    const saldo = totReceitas - totGastos;

    const title = prd.type==="monthly"
      ? `📊 *Relatório de ${formatMonthYear(prd.start)}*`
      : `📊 *Relatório ${formatBRDate(prd.start)} a ${formatBRDate(prd.end)}*`;

    let msg = `${title}\n\n`;
    msg += `💸 Receitas: ${formatCurrencyBR(totReceitas)}\n`;
    msg += `💰 Gastos: ${formatCurrencyBR(totGastos)}\n`;
    msg += `🧮 Saldo: ${formatCurrencyBR(saldo)}\n\n`;

    // Destaques (top 3 por valor)
    const top = (arr) => arr
      .map(r => ({ conta: r.get("conta"), valor: parseFloat(r.get("valor")||"0") }))
      .sort((a,b)=> b.valor-a.valor)
      .slice(0,3);

    const topG = top(gastos), topR = top(receitas);
    if (topG.length) {
      msg += `🏷️ *Maiores gastos:*\n`;
      topG.forEach(it => msg += `• ${it.conta} (${formatCurrencyBR(it.valor)})\n`);
      msg += `\n`;
    }
    if (topR.length) {
      msg += `🏷️ *Maiores receitas:*\n`;
      topR.forEach(it => msg += `• ${it.conta} (${formatCurrencyBR(it.valor)})\n`);
      msg += `\n`;
    }

    await sendText(from, msg.trim());
    return;
  }

  if (intent === "nova_conta" || intent === "novo_recebimento") {
    const { conta, valor, vencimento, tipo_pagamento, codigo_pagamento } = extractEntities(text);
    const tipo = (intent==="novo_recebimento") ? "conta_receber" : "conta_pagar";
    const rowId = uuidShort();
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
      status: "pendente",
    });

    const valorFmt = formatCurrencyBR(valor);
    const dataFmt = formatBRDate(vencimento);

    if (tipo === "conta_pagar") {
      await sendText(from, MSG.CONTA_OK(conta, valorFmt, dataFmt));
      if (tipo_pagamento === "pix")   await sendCopyButton(from, "💳 Chave Pix:", codigo_pagamento, "Copiar Pix");
      if (tipo_pagamento === "boleto")await sendCopyButton(from, "🧾 Código de barras:", codigo_pagamento, "Copiar boleto");
      await sendConfirmButton(from, rowId);
    } else {
      await sendText(from, MSG.RECEB_OK(conta, valorFmt, dataFmt));
    }
    return;
  }

  if (intent === "confirmar_pagamento") {
    const rows = await sheet.getRows();
    const row = rows.find(r => typeof r.get==="function" && r.get("user")===from && r.get("tipo")==="conta_pagar" && r.get("status")!=="pago");
    if (row) { row.set("status","pago"); await row.save(); await sendText(from, MSG.CONFIRM_OK); }
    else await sendText(from, "✅ Nenhum pagamento pendente encontrado.");
    return;
  }

  if (intent === "fora_contexto") { await sendText(from, "💬 *Sou sua assistente financeira e posso te ajudar a organizar pagamentos e recebimentos.*"); return; }

  await sendText(from, MSG.NAO_ENTENDI);
}

function formatMonthYear(d){
  const meses=["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  const dt=new Date(d);
  return `${meses[dt.getMonth()]} de ${dt.getFullYear()}`;
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
              if(id?.startsWith("CONFIRMAR:")){
                const rowId=id.split("CONFIRMAR:")[1];
                const sheet=await ensureSheet();
                const rows=await sheet.getRows();
                const row=rows.find(r=>typeof r.get==="function"&&r.get("row_id")===rowId);
                if(row){ row.set("status","pago"); await row.save(); await sendText(from, "✅ *Pagamento confirmado!*"); }
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
// CRON - lembretes
// ----------------------------
cron.schedule("*/30 * * * *", async()=>{
  try{
    const sheet=await ensureSheet();
    const rows=await sheet.getRows();
    const today = today0(new Date());
    const due = rows.filter(r =>
      typeof r.get==="function" &&
      r.get("tipo")==="conta_pagar" &&
      r.get("status")!=="pago" &&
      r.get("vencimento_iso") &&
      today0(new Date(r.get("vencimento_iso"))).getTime()===today.getTime()
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
