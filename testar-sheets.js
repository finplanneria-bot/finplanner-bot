import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

dotenv.config();

// Corrige as quebras de linha da chave
let GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "";
if (GOOGLE_SERVICE_ACCOUNT_KEY.includes("\\n")) {
  GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
}

const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SHEETS_ID = process.env.SHEETS_ID;

(async () => {
  try {
    // Cria o JWT
    const jwt = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_SERVICE_ACCOUNT_KEY,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    // Cria e autentica o documento
    const doc = new GoogleSpreadsheet(SHEETS_ID, jwt);
    await doc.loadInfo();

    console.log("✅ Autenticado com sucesso no Google Sheets!");
    console.log("📄 Nome da planilha:", doc.title);
  } catch (e) {
    console.error("❌ Falhou:", e.message);
  }
})();
