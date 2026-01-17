import { createRequire } from "module";

const require = createRequire(import.meta.url);
require("dotenv").config();

const { runAvisoCron } = await import("./cron/avisoCron.js");

(async () => {
  console.log(`[CRON] cron-aviso start at ${new Date().toISOString()}`);
  try {
    await runAvisoCron();
    console.log(`[CRON] cron-aviso done at ${new Date().toISOString()}`);
    process.exit(0);
  } catch (error) {
    console.error("[CRON] cron-aviso error:", error);
    process.exit(1);
  }
})();
