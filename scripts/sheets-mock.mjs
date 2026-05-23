const makeSheet = (name) => ({
  title: name,
  loadCells: async () => {},
  getCellByA1: () => ({ value: null, formattedValue: "", formula: "" }),
  getRows: async () => [],
  addRow: async (row) => {
    console.log("[SHEETS-WRITE]", JSON.stringify(row).slice(0, 400));
    return { rowNumber: 999, get: k => row[k], save: async () => {}, _rawData: Object.values(row) };
  },
  loadHeaderRow: async () => {},
  setHeaderRow: async (headers) => { console.log("[SHEETS] setHeaderRow", headers.slice(0,5)); },
  headerValues: ["data", "descricao", "valor", "tipo", "categoria", "status", "vencimento", "rowId"],
  saveUpdatedCells: async () => {},
  rowCount: 1000,
  columnCount: 26,
  getCell: () => ({ value: null, formattedValue: "" }),
  resize: async () => {},
});

export class GoogleSpreadsheet {
  constructor() {
    this.sheetsByTitle = new Proxy({}, { get: (_, key) => makeSheet(key) });
    this.sheetsById = new Proxy({}, { get: (_, key) => makeSheet(String(key)) });
    this.sheetCount = 1;
    this.title = "FinPlanner";
  }
  async loadInfo() { console.log("[SHEETS] loadInfo stub"); }
  addSheet(opts) { return Promise.resolve(makeSheet(opts?.title || "new")); }
}
export class JWT { constructor() {} async authorize() {} }
export default { GoogleSpreadsheet, JWT };
