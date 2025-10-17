// ============================
// FinPlanner IA - WhatsApp Bot (v3 com recebimento + confirmação)
// ============================

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import OpenAI from "openai";
import cron from "node-cron";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// ============================
// Variáveis de ambiente
// ============================
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "finplanner_verify";
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_DOC_ID;

// ============================
// OpenAI (apenas para extrair intenção/campos; nunca para conversar)
// ============================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ============================
// Utilitários
// ============================
const TZ = "America/Maceio";

const firstUp = (s) => (!s ? "" : s.toString().trim().replace(/^./, (c) => c.toUpperCase()));
const normalizePhone = (n) => (n || "").replace(/\D/g, "");
const nowTZ = () => new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
const addDaysUTC = (date, days) => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

const toISODate = (dt) => (dt ? dt.toISOString().slice(0, 10) : "");
const toBRDate = (dt) =>
  dt ? `${String(dt.getUTCDate()).padStart(2, "0")}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${dt.getUTCFullYear()}` : "";

const parseBRDate = (s) => {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?$/);
  if (!m) return null;
  let [_, dd, mm, yyyy] = m;
  const base = nowTZ();
  const year = yyyy ? (yyyy.length === 2 ? Number("20" + yyyy) : Number(yyyy)) : base.getFullYear();
  const dt = new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
  return isNaN(dt) ? null : dt;
};

const BRL = (n) =>
  "R$ " +
  (Number(n || 0))
    .toFixed(2)
    .replace(".", ",")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const guessCategory = (desc = "") => {
  const d = (desc || "").toLowerCase();
  if (/(luz|energia|eletric|conta de luz)/.test(d)) return "Contas Domésticas";
  if (/(água|agua|gás|gas)/.test(d)) return "Contas Domésticas";
  if (/(mercado|supermerc|carrefour|assai|atacad|compras)/.test(d)) return "Alimentação";
  if (/(restaurante|lanche|pizza|ifood|bar)/.test(d)) return "Alimentação";
  if (/(gasolina|combust|uber|99|transporte)/.test(d)) return "Transporte";
  if (/(internet|claro|vivo|tim|oi|netflix|spotify|prime)/.test(d)) return "Serviços";
  if (/(emprést|emprest|juros|banco|taxa)/.test(d)) return "Financeiro";
  if (/(salári|salario|venda|serviço|servico|pix recebido|receb)/.test(d)) return "Renda";
  return "Outros";
};

const parseMoney = (s) => {
  if (typeof s !== "string") return NaN;
  const t = s.replace(/\s/g, "").replace(/[R$\u00A0]/g, "");
  if (/,/.test(t) && /\./.test(t)) return Number(t.replace(/\./g, "").replace(",", "."));
  if (/,/.test(t)) return Number(t.replace(",", "."));
  return Number(t);
};

// ============================
// Google Sheets helpers
// ============================
async function getDoc() {
  const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
  await doc.useServiceAccountAuth({ client_email: SERVICE_ACCOUNT_EMAIL, private_key: PRIVATE_KEY });
  await doc.loadInfo();
  return doc;
}

async function getOrCreateSheet(title, headerValues) {
  const doc = await getDoc();
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[title];
  if (!sheet) {
    sheet = await doc.addSheet({ title, headerValues });
    console.log(`✅ Aba criada: ${title}`);
  } else {
    await sheet.loadHeaderRow();
    if ((!sheet.headerValues || sheet.headerValues.length === 0) && headerValues?.length) {
      await sheet.setHeaderRow(headerValues);
      console.log(`🛠️ Cabeçalhos ajustados na aba: ${title}`);
    } else {
      console.log(`📄 Aba já existente: ${title}`);
    }
  }
  return sheet;
}

async function ensureAllSheets() {
  await getOrCreateSheet("Usuarios", ["Numero", "Nome", "CriadoEm"]);
  await getOrCreateSheet("Movimentos", ["Data", "Numero", "Nome", "Tipo", "Descricao", "Valor", "Categoria", "Origem", "IdMsg"]);
  await getOrCreateSheet("Contas_Pagar", ["DataCad", "Numero", "Nome", "Descricao", "Valor", "VencimentoISO", "VencimentoBR", "Categoria", "Status", "Chave"]);
  await getOrCreateSheet("Contas_Receber", ["DataCad", "Numero", "Nome", "Descricao", "Valor", "VencimentoISO", "VencimentoBR", "Categoria", "Status"]);
  await getOrCreateSheet("Limites", ["Numero", "Categoria", "Limite", "MesRef", "Usado", "UltimoAviso", "AtualizadoEm"]);
  await getOrCreateSheet("Logs", ["Data", "Numero", "Acao", "Detalhes"]);
}

async function saveUserIfNeeded(numero, nomePossivel) {
  const sheet = await getOrCreateSheet("Usuarios", ["Numero", "Nome", "CriadoEm"]);
  const rows = await sheet.getRows();
  const r = rows.find((x) => normalizePhone(x.Numero) === normalizePhone(numero));
  if (!r) {
    await sheet.addRow({ Numero: numero, Nome: nomePossivel || "", CriadoEm: new Date().toISOString() });
  } else if (nomePossivel && !r.Nome) {
    r.Nome = nomePossivel;
    await r.save();
  }
}
async function getUserName(numero) {
  const sheet = await getOrCreateSheet("Usuarios", ["Numero", "Nome", "CriadoEm"]);
  const rows = await sheet.getRows();
  return rows.find((x) => normalizePhone(x.Numero) === normalizePhone(numero))?.Nome || "";
}

async function logAction(numero, acao, detalhes) {
  const sheet = await getOrCreateSheet("Logs", ["Data", "Numero", "Acao", "Detalhes"]);
  await sheet.addRow({ Data: new Date().toISOString(), Numero: numero, Acao: acao, Detalhes: detalhes || "" });
}

// gravações
async function addMovimento({ numero, nome, tipo, desc, valor, categoria, origem, idMsg }) {
  const sheet = await getOrCreateSheet("Movimentos", []);
  await sheet.addRow({
    Data: new Date().toISOString(),
    Numero: numero,
    Nome: nome || "",
    Tipo: firstUp(tipo),
    Descricao: firstUp(desc || ""),
    Valor: Number(valor || 0),
    Categoria: firstUp(categoria || guessCategory(desc || "")),
    Origem: origem || "texto",
    IdMsg: idMsg || "",
  });
}

async function addContaPagar({ numero, nome, desc, valor, vencISO, vencBR, categoria, chave }) {
  const sheet = await getOrCreateSheet("Contas_Pagar", []);
  await sheet.addRow({
    DataCad: new Date().toISOString(),
    Numero: numero,
    Nome: nome || "",
    Descricao: firstUp(desc),
    Valor: Number(valor || 0),
    VencimentoISO: vencISO || "",
    VencimentoBR: vencBR || "",
    Categoria: firstUp(categoria || guessCategory(desc || "")),
    Status: "pendente",
    Chave: (chave || "").trim(),
  });
}

async function addContaReceber({ numero, nome, desc, valor, vencISO, vencBR, categoria }) {
  const sheet = await getOrCreateSheet("Contas_Receber", []);
  await sheet.addRow({
    DataCad: new Date().toISOString(),
    Numero: numero,
    Nome: nome || "",
    Descricao: firstUp(desc),
    Valor: Number(valor || 0),
    VencimentoISO: vencISO || "",
    VencimentoBR: vencBR || "",
    Categoria: firstUp(categoria || guessCategory(desc || "")),
    Status: "pendente",
  });
}

async function getLastRecord(numero, tipo) {
  if (tipo === "receber") {
    const s = await getOrCreateSheet("Contas_Receber", []);
    const rows = await s.getRows();
    const list = rows.filter((r) => normalizePhone(r.Numero) === normalizePhone(numero)).reverse();
    return list[0] || null;
  }
  if (tipo === "ganho" || tipo === "gasto") {
    const s = await getOrCreateSheet("Movimentos", []);
    const rows = await s.getRows();
    const list = rows
      .filter((r) => normalizePhone(r.Numero) === normalizePhone(numero) && r.Tipo?.toLowerCase() === tipo)
      .reverse();
    return list[0] || null;
  }
  return null;
}

// ============================
// WhatsApp - envio (texto / botões)
// ============================
async function sendMessage(to, text, buttons = null) {
  const msg = firstUp(text);
  let payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: msg },
  };

  if (buttons && Array.isArray(buttons) && buttons.length) {
    payload = {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: msg },
        action: {
          buttons: buttons.map((b, i) => ({
            type: "reply",
            reply: { id: b.id || `btn_${i + 1}`, title: b.title },
          })),
        },
      },
    };
  }

  try {
    await axios.post(`https://graph.facebook.com/v17.0/${WA_PHONE_NUMBER_ID}/messages`, payload, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_TOKEN}` },
    });
  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error.response?.data || error.message);
  }
}

// ============================
// Interpretação inteligente (OpenAI → JSON)
// ============================
async function interpretStructured(texto) {
  try {
    const system = `Você é a FinPlanner IA. Extraia intenção e campos de mensagens financeiras.
Responda APENAS com JSON válido.
Campos:
- type: "gasto" | "ganho" | "conta_pagar" | "conta_receber" | "relatorio" | "limite" | "saudacao" | "status" | "desconhecido"
- description: string
- amount: número
- date_br: dd/mm/aaaa (quando houver)
- pix_or_barcode: string (quando houver)
- category: string
- period: "1m"|"3m"|"1a"|"personalizado"
- period_start: dd/mm/aaaa
- period_end: dd/mm/aaaa
- limit_value: número
Se a mensagem perguntar "Registrou meu recebimento?" => type="status". Aceite erros de digitação.`;
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Mensagem: "${texto}"` },
      ],
      temperature: 0.2,
    });
    return JSON.parse(resp.choices[0].message.content.trim());
  } catch (e) {
    const t = (texto || "").toLowerCase();
    if (/(^|\s)(oi|ol[aá]|opa|bom dia|boa tarde|boa noite)(\s|$)/.test(t)) return { type: "saudacao" };
    if (/registrou.*receb/i.test(t)) return { type: "status" };
    if (/ganho/.test(t)) return { type: "ganho" };
    if (/gasto/.test(t)) return { type: "gasto" };
    if (/a\s*pagar/.test(t)) return { type: "conta_pagar" };
    if (/a\s*receber/.test(t)) return { type: "conta_receber" };
    if (/relat[óo]rio/.test(t)) return { type: "relatorio", period: "1m" };
    if (/limite/.test(t)) return { type: "limite" };
    return { type: "desconhecido" };
  }
}

// ============================
// Webhook Meta (verificação)
// ============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso!");
    res.status(200).send(challenge);
  } else res.status(403).send("Erro na verificação do webhook");
});

// ============================
// Webhook principal (mensagens e botões)
// ============================
app.post("/webhook", async (req, res) => {
  try {
    await ensureAllSheets();

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    const from = message?.from;

    // 1) Clique em botões (interactive)
    if (message?.type === "interactive" && message?.interactive?.button_reply) {
      const btn = message.interactive.button_reply;
      const id = btn.id || "";
      // padrões: rcv_confirm:{row}, rcv_pending:{row}, pay_confirm:{row}
      if (id.startsWith("rcv_confirm:")) {
        const rowNum = Number(id.split(":")[1]);
        const s = await getOrCreateSheet("Contas_Receber", []);
        const rows = await s.getRows();
        const row = rows.find((r) => Number(r._rowNumber) === rowNum);
        if (row) {
          row.Status = "recebido";
          await row.save();
          await sendMessage(from, `✅ Recebimento confirmado: “${row.Descricao}” — ${BRL(row.Valor)}.`);
          await logAction(from, "RECEBIMENTO_CONFIRMADO", `${row.Descricao} ${row.Valor}`);
        } else {
          await sendMessage(from, "❌ Não encontrei o registro para confirmar.");
        }
      } else if (id.startsWith("rcv_pending:")) {
        await sendMessage(from, "⏳ Ok! Vou te lembrar novamente no dia do recebimento.");
      } else if (id.startsWith("pay_confirm:")) {
        const rowNum = Number(id.split(":")[1]);
        const s = await getOrCreateSheet("Contas_Pagar", []);
        const rows = await s.getRows();
        const row = rows.find((r) => Number(r._rowNumber) === rowNum);
        if (row) {
          row.Status = "pago";
          await row.save();
          await sendMessage(from, `✅ Pagamento confirmado: “${row.Descricao}” — ${BRL(row.Valor)}.`);
          await logAction(from, "PAGAMENTO_CONFIRMADO", `${row.Descricao} ${row.Valor}`);
        } else {
          await sendMessage(from, "❌ Não encontrei a conta para confirmar.");
        }
      } else {
        await sendMessage(from, "ℹ️ Ação recebida.");
      }

      return res.sendStatus(200);
    }

    // 2) Mensagens de texto
    const userText = message?.text?.body?.trim();
    if (!from || !userText) return res.sendStatus(200);

    await saveUserIfNeeded(from, "");
    const nome = await getUserName(from);

    const cmd = await interpretStructured(userText);

    // Saudações
    if (cmd.type === "saudacao") {
      const boas = [
        "👋 Olá! Sou a FinPlanner IA, sua assistente financeira. Como posso te ajudar hoje?",
        "💰 Olá! Posso registrar gastos, ganhos e contas, ou gerar relatórios.",
        "📈 Olá! Pronta para organizar suas finanças. O que deseja fazer?",
      ];
      await sendMessage(from, boas[Math.floor(Math.random() * boas.length)]);
      await logAction(from, "SAUDACAO", userText);
      return res.sendStatus(200);
    }

    // Status: “Registrou meu recebimento?”
    if (cmd.type === "status") {
      const last = (await getLastRecord(from, "ganho")) || (await getLastRecord(from, "receber"));
      if (last) {
        const valor = last.Valor ? BRL(last.Valor) : "valor não informado";
        const desc = last.Descricao || "Recebimento";
        const quando = last.VencimentoBR || "";
        await sendMessage(from, `✅ Sim! ${firstUp(desc)} ${quando ? `para ${quando} ` : ""}está registrado: ${valor}.`);
      } else {
        await sendMessage(from, "ℹ️ Ainda não encontrei um recebimento recente registrado.");
      }
      await logAction(from, "STATUS", userText);
      return res.sendStatus(200);
    }

    // Gasto
    if (cmd.type === "gasto") {
      const valor = cmd.amount || (userText.match(/[\d\.\,]+/) ? parseMoney(userText.match(/[\d\.\,]+/)[0]) : 0);
      const desc = cmd.description || userText;
      const categoria = cmd.category || guessCategory(desc);
      await addMovimento({ numero: from, nome, tipo: "gasto", desc, valor, categoria, origem: "texto" });
      await sendMessage(from, `💸 Gasto registrado! Valor: ${BRL(valor)} — Categoria: ${categoria}.`);
      await logAction(from, "GASTO", `${desc} ${valor}`);
      return res.sendStatus(200);
    }

    // Ganho
    if (cmd.type === "ganho") {
      const valor = cmd.amount || (userText.match(/[\d\.\,]+/) ? parseMoney(userText.match(/[\d\.\,]+/)[0]) : 0);
      const desc = cmd.description || userText;
      const categoria = cmd.category || "Renda";
      await addMovimento({ numero: from, nome, tipo: "ganho", desc, valor, categoria, origem: "texto" });
      await sendMessage(from, `💰 Ganho registrado! Valor: ${BRL(valor)} — Categoria: ${categoria}.`);
      await logAction(from, "GANHO", `${desc} ${valor}`);
      return res.sendStatus(200);
    }

    // Conta a pagar
    if (cmd.type === "conta_pagar") {
      const valor = cmd.amount || (userText.match(/[\d\.\,]+/) ? parseMoney(userText.match(/[\d\.\,]+/)[0]) : 0);
      const desc = cmd.description || userText;
      let dt = cmd.date_br ? parseBRDate(cmd.date_br) : null;

      if (!dt) {
        const m = userText.match(/(\d{1,2})\s+de?\s*(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/i);
        const meses = { janeiro:0, fevereiro:1, "março":2, "marco":2, abril:3, maio:4, junho:5, julho:6, agosto:7, setembro:8, outubro:9, novembro:10, dezembro:11 };
        if (m) dt = new Date(Date.UTC(nowTZ().getFullYear(), meses[m[2].toLowerCase()], Number(m[1])));
      }
      const vencISO = toISODate(dt);
      const vencBR = toBRDate(dt);
      const categoria = cmd.category || guessCategory(desc);
      const chave = cmd.pix_or_barcode || "";

      await addContaPagar({ numero: from, nome, desc, valor, vencISO, vencBR, categoria, chave });
      await sendMessage(
        from,
        `🧾 Conta “${firstUp(desc)}” adicionada. Vence em ${vencBR || "data informada"} — ${BRL(valor)} — Categoria: ${categoria}. Deseja incluir o código de barras ou chave Pix?`
      );
      await logAction(from, "A_PAGAR", `${desc} ${valor} ${vencBR}`);
      return res.sendStatus(200);
    }

    // Conta a receber
    if (cmd.type === "conta_receber") {
      const valor = cmd.amount || (userText.match(/[\d\.\,]+/) ? parseMoney(userText.match(/[\d\.\,]+/)[0]) : 0);
      const desc = cmd.description || userText;
      let dt = cmd.date_br ? parseBRDate(cmd.date_br) : null;
      const vencISO = toISODate(dt);
      const vencBR = toBRDate(dt);
      const categoria = cmd.category || "Renda";

      await addContaReceber({ numero: from, nome, desc, valor, vencISO, vencBR, categoria });
      await sendMessage(
        from,
        `💵 Recebimento “${firstUp(desc)}” adicionado. Vence em ${vencBR || "data informada"} — ${BRL(valor)} — Categoria: ${categoria}. Te aviso no dia.`
      );
      await logAction(from, "A_RECEBER", `${desc} ${valor} ${vencBR}`);
      return res.sendStatus(200);
    }

    // Relatório
    if (cmd.type === "relatorio") {
      const sheet = await getOrCreateSheet("Movimentos", []);
      const rows = await sheet.getRows();
      const meus = rows.filter((r) => normalizePhone(r.Numero) === normalizePhone(from));

      let dtIni, dtFim;
      const now = nowTZ();
      dtFim = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59));

      const p = cmd.period;
      if (p === "1m") {
        dtIni = new Date(dtFim);
        dtIni.setMonth(dtIni.getMonth() - 1);
      } else if (p === "3m") {
        dtIni = new Date(dtFim);
        dtIni.setMonth(dtIni.getMonth() - 3);
      } else if (p === "1a") {
        dtIni = new Date(dtFim);
        dtIni.setFullYear(dtIni.getFullYear() - 1);
      } else if (p === "personalizado" && cmd.period_start && cmd.period_end) {
        const i = parseBRDate(cmd.period_start);
        const f = parseBRDate(cmd.period_end);
        if (!i || !f) {
          await sendMessage(from, "❌ Período inválido. Informe como: 01/01/2025 a 31/01/2025.");
          return res.sendStatus(200);
        }
        dtIni = new Date(Date.UTC(i.getUTCFullYear(), i.getUTCMonth(), i.getUTCDate(), 0, 0, 0));
        dtFim = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), 23, 59, 59));
      } else {
        dtIni = new Date(dtFim);
        dtIni.setMonth(dtIni.getMonth() - 1);
      }

      const iniISO = dtIni.toISOString();
      const fimISO = dtFim.toISOString();

      const ganhos = meus.filter((r) => r.Tipo === "Ganho" && r.Data >= iniISO && r.Data <= fimISO).reduce((s, r) => s + Number(r.Valor || 0), 0);
      const gastos = meus.filter((r) => r.Tipo === "Gasto" && r.Data >= iniISO && r.Data <= fimISO).reduce((s, r) => s + Number(r.Valor || 0), 0);
      const saldo = ganhos - gastos;

      await sendMessage(
        from,
        `📈 Relatório ${iniISO.slice(0, 10)} a ${fimISO.slice(0, 10)}\n💰 Ganhos: ${BRL(ganhos)}\n💸 Gastos: ${BRL(gastos)}\n📈 Saldo: ${BRL(saldo)}`
      );
      await logAction(from, "RELATORIO", `${iniISO} ${fimISO}`);
      return res.sendStatus(200);
    }

    // Fora do escopo / não entendi
    const foraContexto = [
      "💼 Posso te ajudar apenas com finanças: ganhos, gastos, contas, relatórios e limites.",
      "📊 Sou sua assistente financeira. Ajudo com gastos, ganhos e relatórios.",
      "⚙️ Posso atuar apenas em assuntos financeiros como lançamentos e contas.",
    ];
    const naoEntendi = [
      "❔ Não entendi bem o que você quis dizer. Pode repetir ou ser mais específico?",
      "🤔 Não consegui entender o comando. Tente reformular sua mensagem.",
      "💭 Acho que não entendi. Pode explicar de outro jeito?",
    ];

    if (cmd.type === "desconhecido")) {
      await sendMessage(from, naoEntendi[Math.floor(Math.random() * naoEntendi.length)]);
      await logAction(from, "NAO_ENTENDI", userText);
    } else {
      await sendMessage(from, foraContexto[Math.floor(Math.random() * foraContexto.length)]);
      await logAction(from, "FORA_CONTEXTO", userText);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Erro ao processar mensagem:", error.message);
    res.sendStatus(500);
  }
});

// ============================
// CRON (08:00 America/Maceio) — lembretes 1 dia antes (pagar e receber)
// ============================
cron.schedule(
  "0 8 * * *",
  async () => {
    try {
      await ensureAllSheets();

      const usuarios = await (await getOrCreateSheet("Usuarios", [])).getRows();
      const pagarSheet = await getOrCreateSheet("Contas_Pagar", []);
      const receberSheet = await getOrCreateSheet("Contas_Receber", []);

      const hoje = nowTZ();
      const amanhaUTC = addDaysUTC(new Date(Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())), 1);
      const amanhaISO = toISODate(amanhaUTC);

      // A PAGAR — 1 dia antes
      const contasPagar = await pagarSheet.getRows();
      for (const u of usuarios) {
        const numero = u.Numero;
        const nome = u.Nome || "";
        const minhas = contasPagar.filter(
          (c) => normalizePhone(c.Numero) === normalizePhone(numero) && c.Status === "pendente" && c.VencimentoISO === amanhaISO
        );
        for (const c of minhas) {
          const base = `🔔 Lembrete, ${nome || "tudo bem"}! Sua conta “${c.Descricao}” vence amanhã (${c.VencimentoBR}). Valor: ${BRL(c.Valor)}.`;
          const extra = c.Chave ? `\n💳 Pix/Código: \`${c.Chave}\` (Copie e pague)` : "";
          await sendMessage(numero, base + extra, [
            { id: `pay_confirm:${c._rowNumber}`, title: "Confirmar ✅" },
            { id: `rcv_pending:${c._rowNumber}`, title: "Ainda não ⏳" }, // reaproveitando id genérico
          ]);
          await logAction(numero, "LEMBRETE_PAGAR", `${c.Descricao} ${c.VencimentoBR}`);
        }
      }

      // A RECEBER — 1 dia antes
      const receber = await receberSheet.getRows();
      for (const u of usuarios) {
        const numero = u.Numero;
        const nome = u.Nome || "";
        const meus = receber.filter(
          (r) => normalizePhone(r.Numero) === normalizePhone(numero) && r.Status === "pendente" && r.VencimentoISO === amanhaISO
        );
        for (const r of meus) {
          await sendMessage(
            numero,
            `💵 Olá ${nome || ""}! Você tem um recebimento de “${r.Descricao}” no valor de ${BRL(r.Valor)}, com vencimento amanhã (${r.VencimentoBR}). Deseja confirmar o recebimento?`,
            [
              { id: `rcv_confirm:${r._rowNumber}`, title: "Confirmar ✅" },
              { id: `rcv_pending:${r._rowNumber}`, title: "Ainda não ⏳" },
            ]
          );
          await logAction(numero, "LEMBRETE_RECEBER", `${r.Descricao} ${r.VencimentoBR}`);
        }
      }
    } catch (e) {
      console.error("❌ Erro no CRON:", e.message);
    }
  },
  { timezone: TZ }
);

// ============================
// Start
// ============================
app.listen(PORT, () => {
  console.log("✅ FinPlanner IA pronta: lembretes de pagar/receber + confirmação por botões.");
  console.log(`🚀 Porta: ${PORT}`);
});
