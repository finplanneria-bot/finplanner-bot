// ============================
// FinPlanner IA - WhatsApp Bot (Completo)
// ============================

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import OpenAI from "openai";
import cron from "node-cron";

// Carrega variáveis (.env ou Render)
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
// OpenAI
// ============================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ============================
// Utils
// ============================
const TZ = "America/Maceio";
const BRL = (n) =>
  "R$ " +
  (Number(n || 0))
    .toFixed(2)
    .replace(".", ",")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const firstUp = (s) => {
  if (!s) return "";
  const t = s.toString().trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const todayISO = () => {
  const d = new Date();
  const tzDate = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  tzDate.setHours(0, 0, 0, 0);
  return tzDate.toISOString().slice(0, 10);
};

const parseBRDate = (s) => {
  // aceita dd/mm/aaaa ou dd/mm
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?$/);
  if (!m) return null;
  let [_, dd, mm, yyyy] = m;
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const year = yyyy ? (yyyy.length === 2 ? Number("20" + yyyy) : Number(yyyy)) : now.getFullYear();
  const dt = new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
  return isNaN(dt) ? null : dt;
};

const parseMoney = (s) => {
  // aceita 1.234,56 ou 1234.56 ou 1234
  if (typeof s !== "string") return NaN;
  const t = s.replace(/\s/g, "").replace(/[R$\u00A0]/g, "");
  // se tem vírgula, assume vírgula como decimal
  if (/,/.test(t) && /\./.test(t)) {
    return Number(t.replace(/\./g, "").replace(",", "."));
  }
  if (/,/.test(t)) {
    return Number(t.replace(",", "."));
  }
  return Number(t);
};

const guessCategory = (desc = "") => {
  const d = desc.toLowerCase();
  if (/(luz|energia|eletric|power)/.test(d)) return "Contas domésticas";
  if (/(água|agua|gás|gas)/.test(d)) return "Contas domésticas";
  if (/(mercado|supermerc|carrefour|extra|assai|atacad|compras)/.test(d)) return "Alimentação";
  if (/(restaurante|lanche|pizza|ifood|bar)/.test(d)) return "Alimentação";
  if (/(gasolina|combust|uber|99|transporte|passagem)/.test(d)) return "Transporte";
  if (/(internet|plano|claro|vivo|tim|oi|netflix|spotify|prime)/.test(d)) return "Serviços";
  if (/(emprést|emprest|juros|taxa|banco)/.test(d)) return "Financeiro";
  if (/(salári|salario|venda|serviço|servico|pix recebido|receb)/.test(d)) return "Trabalho/Renda";
  return "Outros";
};

const normalizePhone = (n) => (n || "").replace(/\D/g, "");

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
  let sheet = doc.sheetsByTitle[title];
  if (!sheet) {
    sheet = await doc.addSheet({ title, headerValues });
  } else if (sheet.headerValues?.length === 0 && headerValues?.length) {
    await sheet.setHeaderRow(headerValues);
  }
  return sheet;
}

async function ensureAllSheets() {
  await getOrCreateSheet("Usuarios", ["Numero", "Nome", "CriadoEm"]);
  await getOrCreateSheet("Movimentos", [
    "Data",
    "Numero",
    "Nome",
    "Tipo", // Gasto | Ganho
    "Descricao",
    "Valor",
    "Categoria",
    "Origem", // texto|audio|imagem
    "IdMsg",
  ]);
  await getOrCreateSheet("Contas_Pagar", [
    "DataCad",
    "Numero",
    "Nome",
    "Descricao",
    "Valor",
    "VencimentoISO",
    "VencimentoBR",
    "Categoria",
    "Status", // pendente|pago|cancelado
    "Chave", // pix ou código de barras
  ]);
  await getOrCreateSheet("Contas_Receber", [
    "DataCad",
    "Numero",
    "Nome",
    "Descricao",
    "Valor",
    "VencimentoISO",
    "VencimentoBR",
    "Categoria",
    "Status", // pendente|recebido|cancelado
  ]);
  await getOrCreateSheet("Limites", [
    "Numero",
    "Categoria",
    "Limite",
    "MesRef", // YYYY-MM
    "Usado",
    "UltimoAviso", // "", "80", "100"
    "AtualizadoEm",
  ]);
  await getOrCreateSheet("Logs", ["Data", "Numero", "Acao", "Detalhes"]);
}

// ============================
// WhatsApp send (texto ou buttons)
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
          buttons: buttons.map((b, idx) => ({
            type: "reply",
            reply: { id: b.id || `btn_${idx + 1}`, title: b.title },
          })),
        },
      },
    };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v17.0/${WA_PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_TOKEN}` } }
    );
    console.log("✅ Mensagem enviada:", response.data);
  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error.response?.data || error.message);
  }
}

// ============================
// Persistência
// ============================
async function saveUserIfNeeded(numero, nomePossivel) {
  const sheet = await getOrCreateSheet("Usuarios", ["Numero", "Nome", "CriadoEm"]);
  const rows = await sheet.getRows({ offset: 0 });
  const found = rows.find((r) => normalizePhone(r.Numero) === normalizePhone(numero));
  if (!found) {
    await sheet.addRow({ Numero: numero, Nome: nomePossivel || "", CriadoEm: new Date().toISOString() });
  } else if (nomePossivel && !found.Nome) {
    found.Nome = nomePossivel;
    await found.save();
  }
}

async function getUserName(numero) {
  const sheet = await getOrCreateSheet("Usuarios", ["Numero", "Nome", "CriadoEm"]);
  const rows = await sheet.getRows();
  const r = rows.find((x) => normalizePhone(x.Numero) === normalizePhone(numero));
  return r?.Nome || "";
}

async function logAction(numero, acao, detalhes) {
  const sheet = await getOrCreateSheet("Logs", ["Data", "Numero", "Acao", "Detalhes"]);
  await sheet.addRow({ Data: new Date().toISOString(), Numero: numero, Acao: acao, Detalhes: detalhes || "" });
}

// ============================
// Comandos (parsers)
// ============================
function parseCommand(txt) {
  const t = txt.trim();

  // alterar categoria {nova}
  const mAlter = t.match(/^alterar\s+categoria\s+(.{2,})$/i);
  if (mAlter) return { cmd: "alterar_categoria", nova: mAlter[1].trim() };

  // limite 1000 supermercado
  const mLim = t.match(/^limite\s+([\d\.,]+)\s+(.{2,})$/i);
  if (mLim) return { cmd: "definir_limite", valor: parseMoney(mLim[1]), categoria: firstUp(mLim[2]) };

  // relatório X
  if (/^relat[óo]rio\s+1\s*m[eê]s/i.test(t)) return { cmd: "relatorio", periodo: "1m" };
  if (/^relat[óo]rio\s+3\s*m[eê]ses?/i.test(t)) return { cmd: "relatorio", periodo: "3m" };
  if (/^relat[óo]rio\s+1\s*ano/i.test(t)) return { cmd: "relatorio", periodo: "1a" };

  // relatório personalizado: "relatório 01/01/2025 a 31/01/2025"
  const mRelPers = t.match(/^relat[óo]rio\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+a\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i);
  if (mRelPers) return { cmd: "relatorio", periodo: "pers", ini: mRelPers[1], fim: mRelPers[2] };

  // ganho 250 vendas
  const mGanho = t.match(/^ganho\s+([\d\.,]+)\s*(.*)$/i);
  if (mGanho) return { cmd: "ganho", valor: parseMoney(mGanho[1]), desc: mGanho[2].trim() };

  // gasto 45 mercado
  const mGasto = t.match(/^gasto\s+([\d\.,]+)\s*(.*)$/i);
  if (mGasto) return { cmd: "gasto", valor: parseMoney(mGasto[1]), desc: mGasto[2].trim() };

  // a pagar luz 120 25/10 chave:xxxx
  const mApagar = t.match(/^a\s*pagar\s+(.+?)\s+([\d\.,]+)\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)(?:\s+chave\s*:\s*(.+))?$/i);
  if (mApagar)
    return {
      cmd: "conta_pagar",
      desc: mApagar[1].trim(),
      valor: parseMoney(mApagar[2]),
      venc: mApagar[3],
      chave: mApagar[4]?.trim() || "",
    };

  // a receber clienteX 600 25/10
  const mArec = t.match(/^a\s*receber\s+(.+?)\s+([\d\.,]+)\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i);
  if (mArec)
    return {
      cmd: "conta_receber",
      desc: mArec[1].trim(),
      valor: parseMoney(mArec[2]),
      venc: mArec[3],
    };

  // nome: João
  const mNome = t.match(/^meu\s*nome\s*[eé]\s*[:\-]?\s*(.+)$/i) || t.match(/^nome\s*[:\-]?\s*(.+)$/i);
  if (mNome) return { cmd: "definir_nome", nome: firstUp(mNome[1].trim()) };

  // menu
  if (/^(menu|ajuda|op[cç][oõ]es)$/i.test(t)) return { cmd: "menu" };

  return { cmd: "desconhecido" };
}

// ============================
// Ações de negócio
// ============================
async function addMovimento({ numero, nome, tipo, desc, valor, categoria, origem, idMsg }) {
  const sheet = await getOrCreateSheet("Movimentos", [
    "Data",
    "Numero",
    "Nome",
    "Tipo",
    "Descricao",
    "Valor",
    "Categoria",
    "Origem",
    "IdMsg",
  ]);
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

async function alterarUltimaCategoria(numero, novaCat) {
  const sheet = await getOrCreateSheet("Movimentos", []);
  const rows = await sheet.getRows();
  const userRows = rows.filter((r) => normalizePhone(r.Numero) === normalizePhone(numero));
  const last = userRows.reverse().find((r) => r.Categoria && r.Tipo); // último registro válido
  if (!last) return false;
  last.Categoria = firstUp(novaCat);
  await last.save();
  return true;
}

async function addContaPagar({ numero, nome, desc, valor, venc, chave }) {
  const sheet = await getOrCreateSheet("Contas_Pagar", []);
  const dt = parseBRDate(venc);
  const cat = guessCategory(desc || "");
  await sheet.addRow({
    DataCad: new Date().toISOString(),
    Numero: numero,
    Nome: nome || "",
    Descricao: firstUp(desc),
    Valor: Number(valor || 0),
    VencimentoISO: dt ? dt.toISOString().slice(0, 10) : "",
    VencimentoBR: dt ? `${String(dt.getUTCDate()).padStart(2, "0")}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${dt.getUTCFullYear()}` : venc,
    Categoria: firstUp(cat),
    Status: "pendente",
    Chave: (chave || "").trim(),
  });
}

async function addContaReceber({ numero, nome, desc, valor, venc }) {
  const sheet = await getOrCreateSheet("Contas_Receber", []);
  const dt = parseBRDate(venc);
  const cat = guessCategory(desc || "");
  await sheet.addRow({
    DataCad: new Date().toISOString(),
    Numero: numero,
    Nome: nome || "",
    Descricao: firstUp(desc),
    Valor: Number(valor || 0),
    VencimentoISO: dt ? dt.toISOString().slice(0, 10) : "",
    VencimentoBR: dt ? `${String(dt.getUTCDate()).padStart(2, "0")}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${dt.getUTCFullYear()}` : venc,
    Categoria: firstUp(cat),
    Status: "pendente",
  });
}

async function setLimite({ numero, categoria, limite }) {
  const sheet = await getOrCreateSheet("Limites", []);
  const rows = await sheet.getRows();
  const mesRef = new Date(new Date().toLocaleString("en-US", { timeZone: TZ })).toISOString().slice(0, 7); // YYYY-MM
  const row = rows.find(
    (r) => normalizePhone(r.Numero) === normalizePhone(numero) && r.Categoria?.toLowerCase() === categoria.toLowerCase() && r.MesRef === mesRef
  );
  if (row) {
    row.Limite = Number(limite);
    row.AtualizadoEm = new Date().toISOString();
    await row.save();
  } else {
    await sheet.addRow({
      Numero: numero,
      Categoria: firstUp(categoria),
      Limite: Number(limite),
      MesRef: mesRef,
      Usado: 0,
      UltimoAviso: "",
      AtualizadoEm: new Date().toISOString(),
    });
  }
}

async function recomputeUsoLimites(numero) {
  // Soma gastos do mês por categoria e atualiza "Usado"
  const movSheet = await getOrCreateSheet("Movimentos", []);
  const limSheet = await getOrCreateSheet("Limites", []);
  const mesRef = new Date(new Date().toLocaleString("en-US", { timeZone: TZ })).toISOString().slice(0, 7); // YYYY-MM

  const movs = (await movSheet.getRows()).filter(
    (r) =>
      normalizePhone(r.Numero) === normalizePhone(numero) &&
      r.Tipo?.toLowerCase() === "gasto" &&
      (r.Data || "").slice(0, 7) === mesRef
  );

  const somaPorCat = {};
  movs.forEach((m) => {
    const cat = firstUp(m.Categoria || "Outros");
    somaPorCat[cat] = (somaPorCat[cat] || 0) + Number(m.Valor || 0);
  });

  const limites = (await limSheet.getRows()).filter(
    (r) => normalizePhone(r.Numero) === normalizePhone(numero) && r.MesRef === mesRef
  );

  // Atualiza cada limite com o "Usado"
  for (const l of limites) {
    const cat = firstUp(l.Categoria || "Outros");
    l.Usado = Number(somaPorCat[cat] || 0);
    l.AtualizadoEm = new Date().toISOString();
    await l.save();
  }

  return { mesRef, limites: (await limSheet.getRows()).filter((r) => normalizePhone(r.Numero) === normalizePhone(numero) && r.MesRef === mesRef) };
}

async function relatorioPeriodo(numero, dtIni, dtFim) {
  const movSheet = await getOrCreateSheet("Movimentos", []);
  const pagarSheet = await getOrCreateSheet("Contas_Pagar", []);
  const receberSheet = await getOrCreateSheet("Contas_Receber", []);

  const movs = await movSheet.getRows();
  const gastos = movs.filter((r) => normalizePhone(r.Numero) === normalizePhone(numero) && r.Tipo === "Gasto" && r.Data >= dtIni && r.Data <= dtFim);
  const ganhos = movs.filter((r) => normalizePhone(r.Numero) === normalizePhone(numero) && r.Tipo === "Ganho" && r.Data >= dtIni && r.Data <= dtFim);

  const totalGastos = gastos.reduce((s, r) => s + Number(r.Valor || 0), 0);
  const totalGanhos = ganhos.reduce((s, r) => s + Number(r.Valor || 0), 0);
  const saldo = totalGanhos - totalGastos;

  const pagarPend = (await pagarSheet.getRows()).filter(
    (r) =>
      normalizePhone(r.Numero) === normalizePhone(numero) &&
      r.Status === "pendente" &&
      r.VencimentoISO >= dtIni.slice(0, 10) &&
      r.VencimentoISO <= dtFim.slice(0, 10)
  );
  const receberPend = (await receberSheet.getRows()).filter(
    (r) =>
      normalizePhone(r.Numero) === normalizePhone(numero) &&
      r.Status === "pendente" &&
      r.VencimentoISO >= dtIni.slice(0, 10) &&
      r.VencimentoISO <= dtFim.slice(0, 10)
  );

  const sumPagar = pagarPend.reduce((s, r) => s + Number(r.Valor || 0), 0);
  const sumReceber = receberPend.reduce((s, r) => s + Number(r.Valor || 0), 0);

  return { totalGastos, totalGanhos, saldo, sumPagar, sumReceber };
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
  } else {
    res.status(403).send("Erro na verificação do webhook");
  }
});

// ============================
// Webhook de mensagens
// ============================
app.post("/webhook", async (req, res) => {
  try {
    await ensureAllSheets();

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    const from = message?.from;
    let userText = message?.text?.body?.trim();

    if (!from || !userText) {
      return res.sendStatus(200);
    }

    await saveUserIfNeeded(from, "");
    const nome = await getUserName(from);

    // Salva log de entrada
    await logAction(from, "MSG_IN", userText);

    // Se usuário mandar nome
    const cmdObj = parseCommand(userText);

    // MENU
    if (cmdObj.cmd === "menu") {
      await sendMessage(from, `⚙️ O que deseja fazer, ${nome || "tudo bem"}?`, [
        { title: "💸 Gasto" },
        { title: "💰 Ganho" },
        { title: "📅 A pagar" },
        { title: "💵 A receber" },
        { title: "📊 Resumo" },
        { title: "📈 Relatórios" },
        { title: "🎯 Limites" },
      ]);
      return res.sendStatus(200);
    }

    // DEFINIR NOME
    if (cmdObj.cmd === "definir_nome") {
      await saveUserIfNeeded(from, cmdObj.nome);
      await sendMessage(from, `✅ Prazer, ${cmdObj.nome}! Usarei seu nome nos lembretes.`);
      return res.sendStatus(200);
    }

    // ALTERAR CATEGORIA (último lançamento)
    if (cmdObj.cmd === "alterar_categoria") {
      const ok = await alterarUltimaCategoria(from, cmdObj.nova);
      await sendMessage(from, ok ? `✅ Categoria alterada para ${cmdObj.nova}.` : "❌ Não encontrei registro para alterar.");
      return res.sendStatus(200);
    }

    // GANHO
    if (cmdObj.cmd === "ganho") {
      const categoria = guessCategory(cmdObj.desc || "Ganho");
      await addMovimento({
        numero: from,
        nome,
        tipo: "Ganho",
        desc: cmdObj.desc || "Ganho",
        valor: cmdObj.valor,
        categoria,
        origem: "texto",
      });
      await sendMessage(from, `💰 Ganho registrado! Valor: ${BRL(cmdObj.valor)} — Categoria: ${categoria}.`);
      await logAction(from, "GANHO", `${cmdObj.desc} ${cmdObj.valor}`);
      return res.sendStatus(200);
    }

    // GASTO
    if (cmdObj.cmd === "gasto") {
      const categoria = guessCategory(cmdObj.desc || "Gasto");
      await addMovimento({
        numero: from,
        nome,
        tipo: "Gasto",
        desc: cmdObj.desc || "Gasto",
        valor: cmdObj.valor,
        categoria,
        origem: "texto",
      });
      await sendMessage(from, `💸 Gasto registrado! Valor: ${BRL(cmdObj.valor)} — Categoria: ${categoria}.`);
      await recomputeUsoLimites(from);
      await logAction(from, "GASTO", `${cmdObj.desc} ${cmdObj.valor}`);
      return res.sendStatus(200);
    }

    // CONTA A PAGAR
    if (cmdObj.cmd === "conta_pagar") {
      await addContaPagar({
        numero: from,
        nome,
        desc: cmdObj.desc,
        valor: cmdObj.valor,
        venc: cmdObj.venc,
        chave: cmdObj.chave || "",
      });
      await sendMessage(
        from,
        `🧾 Conta “${firstUp(cmdObj.desc)}” adicionada. Vence em ${cmdObj.venc} — ${BRL(cmdObj.valor)} — Categoria: ${guessCategory(cmdObj.desc)}. Deseja incluir o código de barras ou chave Pix?`
      );
      await logAction(from, "A_PAGAR", `${cmdObj.desc} ${cmdObj.valor} ${cmdObj.venc}`);
      return res.sendStatus(200);
    }

    // CONTA A RECEBER
    if (cmdObj.cmd === "conta_receber") {
      await addContaReceber({
        numero: from,
        nome,
        desc: cmdObj.desc,
        valor: cmdObj.valor,
        venc: cmdObj.venc,
      });
      await sendMessage(
        from,
        `💵 Conta a receber “${firstUp(cmdObj.desc)}” adicionada. Vence em ${cmdObj.venc} — ${BRL(cmdObj.valor)} — Categoria: ${guessCategory(cmdObj.desc)}. Te aviso no dia.`
      );
      await logAction(from, "A_RECEBER", `${cmdObj.desc} ${cmdObj.valor} ${cmdObj.venc}`);
      return res.sendStatus(200);
    }

    // DEFINIR LIMITE
    if (cmdObj.cmd === "definir_limite") {
      await setLimite({ numero: from, categoria: cmdObj.categoria, limite: cmdObj.valor });
      await recomputeUsoLimites(from);
      await sendMessage(from, `🎯 Limite definido: ${BRL(cmdObj.valor)} em ${cmdObj.categoria}. Avisarei em 80% e 100%.`);
      await logAction(from, "LIMITE", `${cmdObj.categoria} ${cmdObj.valor}`);
      return res.sendStatus(200);
    }

    // RELATÓRIO
    if (cmdObj.cmd === "relatorio") {
      let dtIni, dtFim;
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
      now.setHours(23, 59, 59, 999);

      if (cmdObj.periodo === "1m") {
        dtFim = now;
        dtIni = new Date(dtFim);
        dtIni.setMonth(dtIni.getMonth() - 1);
      } else if (cmdObj.periodo === "3m") {
        dtFim = now;
        dtIni = new Date(dtFim);
        dtIni.setMonth(dtIni.getMonth() - 3);
      } else if (cmdObj.periodo === "1a") {
        dtFim = now;
        dtIni = new Date(dtFim);
        dtIni.setFullYear(dtIni.getFullYear() - 1);
      } else if (cmdObj.periodo === "pers") {
        const i = parseBRDate(cmdObj.ini);
        const f = parseBRDate(cmdObj.fim);
        if (!i || !f) {
          await sendMessage(from, "❌ Período inválido. Informe como: 01/01/2025 a 31/01/2025.");
          return res.sendStatus(200);
        }
        dtIni = new Date(Date.UTC(i.getUTCFullYear(), i.getUTCMonth(), i.getUTCDate(), 0, 0, 0));
        dtFim = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), 23, 59, 59));
      }

      const dtIniISO = new Date(dtIni).toISOString();
      const dtFimISO = new Date(dtFim).toISOString();

      const r = await relatorioPeriodo(from, dtIniISO, dtFimISO);
      const txt = `📈 Relatório ${dtIniISO.slice(0, 10)} a ${dtFimISO.slice(0, 10)}\n💰 Ganhos: ${BRL(r.totalGanhos)}\n💸 Gastos: ${BRL(r.totalGastos)}\n💵 A receber (pend.): ${BRL(
        r.sumReceber
      )}\n🧾 A pagar (pend.): ${BRL(r.sumPagar)}\n📈 Saldo: ${BRL(r.saldo)}`;
      await sendMessage(from, txt);
      await logAction(from, "RELATORIO", `${dtIniISO} ${dtFimISO}`);
      return res.sendStatus(200);
    }

    // Se não bateu nenhum comando claro → IA restrita a finanças
    {
      const policy = `Responda apenas se a mensagem for sobre finanças pessoais, ganhos, gastos, contas, relatórios ou limites. Caso contrário, diga: "🤖 Desculpe, posso te ajudar apenas com assuntos financeiros (ganhos, gastos, contas, relatórios e limites)." Responda sempre curto (até 2 frases), use no máximo 2 emojis, e comece com letra maiúscula.`;
      let aiResponse = "";
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Você é a FinPlanner IA, assistente financeira objetiva e educada." },
            { role: "user", content: `${policy}\n\nMensagem: "${userText}"` },
          ],
        });
        aiResponse = firstUp(completion.choices[0].message.content.trim());
      } catch (e) {
        aiResponse = "❌ Desculpe, ocorreu um erro ao processar sua solicitação.";
      }
      await sendMessage(from, aiResponse);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Erro ao processar mensagem:", error.message);
    res.sendStatus(500);
  }
});

// ============================
// CRON: 08:00 (America/Maceio) — lembretes + alertas de limite
// ============================
cron.schedule(
  "0 8 * * *",
  async () => {
    try {
      await ensureAllSheets();
      const usuarios = await (await getOrCreateSheet("Usuarios", [])).getRows();
      const pagarSheet = await getOrCreateSheet("Contas_Pagar", []);
      const hoje = todayISO();

      // Lembretes de vencimento
      const contas = await pagarSheet.getRows();
      for (const u of usuarios) {
        const numero = u.Numero;
        const nome = u.Nome || "";
        const minhas = contas.filter(
          (c) => normalizePhone(c.Numero) === normalizePhone(numero) && c.Status === "pendente" && c.VencimentoISO === hoje
        );
        for (const c of minhas) {
          const base = `🔔 Lembrete, ${nome || "tudo bem"}! Sua conta “${c.Descricao}” vence hoje (${c.VencimentoBR}). Valor: ${BRL(c.Valor)}.`;
          const extra = c.Chave ? `\n💳 Pix/Código: \`${c.Chave}\` (Copie e pague)` : "";
          await sendMessage(numero, base + extra, [
            { title: "✅ Pagar" },
            { title: "🔁 Adiar" },
            { title: "❌ Cancelar" },
          ]);
          await logAction(numero, "LEMBRETE_VENC", `${c.Descricao} ${c.VencimentoBR}`);
        }
      }

      // Alertas de Limites (80% / 100%)
      for (const u of usuarios) {
        const numero = u.Numero;
        const { limites } = await recomputeUsoLimites(numero);
        for (const l of limites) {
          const limite = Number(l.Limite || 0);
          if (!limite) continue;
          const usado = Number(l.Usado || 0);
          const pct = Math.floor((usado / limite) * 100);
          if (pct >= 100 && l.UltimoAviso !== "100") {
            await sendMessage(
              numero,
              `⛔ Limite da categoria ${l.Categoria} atingido! (${BRL(usado)} / ${BRL(limite)}). Você pode continuar registrando se desejar.`,
              [
                { title: "🔍 Ver gastos" },
                { title: "⬆️ Aumentar limite" },
                { title: "✅ Manter" },
              ]
            );
            l.UltimoAviso = "100";
            l.AtualizadoEm = new Date().toISOString();
            await l.save();
            await logAction(numero, "ALERTA_100", `${l.Categoria} ${usado}/${limite}`);
          } else if (pct >= 80 && l.UltimoAviso !== "80" && l.UltimoAviso !== "100") {
            await sendMessage(
              numero,
              `⚠️ Atenção: Categoria ${l.Categoria} atingiu 80% do limite. (${BRL(usado)} / ${BRL(limite)}).`,
              [
                { title: "🔍 Ver gastos" },
                { title: "✏️ Ajustar limite" },
                { title: "✅ Ignorar" },
              ]
            );
            l.UltimoAviso = "80";
            l.AtualizadoEm = new Date().toISOString();
            await l.save();
            await logAction(numero, "ALERTA_80", `${l.Categoria} ${usado}/${limite}`);
          }
        }
      }
    } catch (e) {
      console.error("❌ Erro no CRON:", e.message);
    }
  },
  { timezone: TZ }
);

// ============================
// Rotas auxiliares
// ============================
app.get("/send", async (req, res) => {
  await sendMessage("557998149934", "🚀 FinPlanner conectada com sucesso!");
  res.send("Mensagem de teste enviada!");
});

// ============================
// Start
// ============================
app.listen(PORT, () => {
  console.log("✅ Token e Phone ID carregados com sucesso.");
  console.log(`🚀 FinPlanner rodando na porta ${PORT}`);
});
