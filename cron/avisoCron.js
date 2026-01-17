import {
  ensureSheet,
  withRetry,
  startOfDay,
  parseDateToken,
  getVal,
  normalizeUser,
  isUsuarioAtivo,
  formatBRDate,
  formatEntryBlock,
  hasRecentUserInteraction,
  sendText,
  sendTemplateReminder,
  getStoredFirstName,
  sendCopyButton,
} from "../app.js";

async function runAvisoCron({ requestedBy = "cron", dryRun = false } = {}) {
  console.log(`[CRON] runAvisoCron start requestedBy=${requestedBy} at ${new Date().toISOString()}`);
  const reasons = {
    invalid_date: 0,
    future_due: 0,
    invalid_user: 0,
    inactive_plan: 0,
    no_items: 0,
    sent_ok: 0,
    sent_text_ok: 0,
    sent_template_ok: 0,
    send_error: 0,
  };
  let totalItems = 0;
  let sentCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const dueByUser = new Map();

  try {
    const sheet = await ensureSheet();
    const rows = await withRetry(() => sheet.getRows(), "get-finplanner-cron");
    const today = startOfDay(new Date());
    const todayMs = today.getTime();

    const enqueueReminder = (row, kind) => {
      const dueIso = getVal(row, "vencimento_iso");
      const dueBr = getVal(row, "vencimento_br");
      const dueDate = dueIso ? new Date(dueIso) : parseDateToken(dueBr);
      if (!dueDate || Number.isNaN(dueDate.getTime())) {
        console.log("⚠️ Cron skip (data inválida):", {
          user: getVal(row, "user") || getVal(row, "user_raw"),
          tipo: getVal(row, "tipo"),
          vencimento_iso: dueIso,
          vencimento_br: dueBr,
        });
        reasons.invalid_date += 1;
        skippedCount += 1;
        return;
      }
      const dueMs = startOfDay(dueDate).getTime();
      if (dueMs > todayMs) {
        console.log("ℹ️ Cron skip (vencimento futuro):", {
          user: getVal(row, "user") || getVal(row, "user_raw"),
          tipo: getVal(row, "tipo"),
          vencimento_iso: dueIso,
          vencimento_br: dueBr,
        });
        reasons.future_due += 1;
        skippedCount += 1;
        return;
      }
      const toRaw = getVal(row, "user_raw") || getVal(row, "user");
      const userNorm = normalizeUser(getVal(row, "user") || getVal(row, "user_raw"));
      if (!toRaw || !userNorm) {
        console.log("⚠️ Cron skip (usuário inválido):", {
          user: getVal(row, "user") || getVal(row, "user_raw"),
          tipo: getVal(row, "tipo"),
        });
        reasons.invalid_user += 1;
        skippedCount += 1;
        return;
      }
      const bucket = dueByUser.get(userNorm) || { to: toRaw, items: [] };
      if (!bucket.to) bucket.to = toRaw;
      bucket.items.push({ row, kind, dueMs });
      dueByUser.set(userNorm, bucket);
    };

    for (const row of rows) {
      const tipo = (getVal(row, "tipo") || "").toString().toLowerCase();
      const status = (getVal(row, "status") || "").toString().toLowerCase();
      if (tipo === "conta_pagar" && status !== "pago") enqueueReminder(row, "pagar");
      if (tipo === "conta_receber" && !["pago", "recebido"].includes(status)) enqueueReminder(row, "receber");
    }

    for (const bucket of dueByUser.values()) {
      totalItems += bucket.items.length;
    }

    if (!dueByUser.size) {
      console.log("ℹ️ Cron: nenhum lançamento pendente para hoje ou vencido.");
    }

    for (const [userNorm, bucket] of dueByUser.entries()) {
      const { to, items } = bucket;
      if (!items.length || !to) {
        reasons.no_items += 1;
        skippedCount += 1;
        continue;
      }
      const ativo = await isUsuarioAtivo(userNorm);
      if (!ativo) {
        console.log("⛔ Cron skip (plano inativo):", { userNorm, to, itens: items.length });
        reasons.inactive_plan += 1;
        skippedCount += 1;
        continue;
      }

      const pagar = items
        .filter((item) => item.kind === "pagar")
        .sort((a, b) => a.dueMs - b.dueMs);
      const receber = items
        .filter((item) => item.kind === "receber")
        .sort((a, b) => a.dueMs - b.dueMs);

      const sections = [];
      let counter = 1;

      if (pagar.length) {
        const blocks = pagar.map((item) => {
          const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
          const dueLabel = dueRaw || "—";
          const label = item.dueMs < todayMs ? `${dueLabel} (atrasado)` : dueLabel;
          return formatEntryBlock(item.row, { index: counter++, dateText: label });
        });
        sections.push(`💸 *Pagamentos pendentes*\n\n${blocks.join("\n\n")}`);
      }

      if (receber.length) {
        const blocks = receber.map((item) => {
          const dueRaw = formatBRDate(getVal(item.row, "vencimento_iso"));
          const dueLabel = dueRaw || "—";
          const label = item.dueMs < todayMs ? `${dueLabel} (atrasado)` : dueLabel;
          return formatEntryBlock(item.row, { index: counter++, dateText: label });
        });
        sections.push(`💵 *Recebimentos pendentes*\n\n${blocks.join("\n\n")}`);
      }

      if (!sections.length) {
        skippedCount += 1;
        continue;
      }

      const message = `⚠️ *Lembrete FinPlanner IA*\n\n${sections.join("\n\n")}`;
      const withinWindow = hasRecentUserInteraction(userNorm);
      console.log("⏰ Cron send attempt:", {
        userNorm,
        to,
        total: items.length,
        pagar: pagar.length,
        receber: receber.length,
        withinWindow,
      });
      let delivered = false;
      let threw = false;
      let usedTemplate = false;
      try {
        if (withinWindow) {
          delivered = await sendText(to, message);
          if (delivered) {
            sentCount += 1;
            reasons.sent_ok += 1;
            reasons.sent_text_ok += 1;
          }
        } else {
          usedTemplate = true;
          delivered = await sendTemplateReminder(to, userNorm, getStoredFirstName(userNorm));
          if (delivered) {
            sentCount += 1;
            reasons.sent_ok += 1;
            reasons.sent_template_ok += 1;
          }
        }
      } catch (error) {
        threw = true;
        errorCount += 1;
        reasons.send_error += 1;
        console.error("Erro no envio do CRON:", error.message);
      }
      if (!delivered) {
        console.log("⚠️ Cron delivery failed:", { userNorm, to, delivered, withinWindow, usedTemplate });
        if (!threw) {
          errorCount += 1;
          reasons.send_error += 1;
        }
        skippedCount += 1;
        continue;
      }
      console.log("✅ Cron delivery ok:", { userNorm, to, via: usedTemplate ? "template" : "text" });

      for (const item of items) {
        const paymentType = (getVal(item.row, "tipo_pagamento") || "").toString().toLowerCase();
        const code = getVal(item.row, "codigo_pagamento");
        if (!code) continue;
        if (paymentType === "pix") await sendCopyButton(to, "💳 Chave Pix:", code, "Copiar Pix");
        if (paymentType === "boleto") await sendCopyButton(to, "🧾 Código de barras:", code, "Copiar boleto");
      }
    }
  } catch (error) {
    errorCount += 1;
    console.error("Erro no CRON:", error.message);
  }

  const resumo = {
    users: dueByUser.size,
    reminders: totalItems,
    sent: sentCount,
    skipped: skippedCount,
    errors: errorCount,
    reasons,
  };
  console.log("[CRON] runAvisoCron done", resumo);
  return resumo;
}

export { runAvisoCron };
export default { runAvisoCron };
if (typeof module !== "undefined") {
  module.exports = { runAvisoCron };
}
