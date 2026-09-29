import "server-only";
import ExcelJS from "exceljs";
import { type Cell, type ExistingGame, type ParseResult, parseSheet } from "./import-parse";

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || v instanceof Date) return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    if ("result" in v) return cellValue(v.result as ExcelJS.CellValue); // formula
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text); // hyperlink
  }
  return null;
}

export function parseCsv(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let cur = "";
  let quoted = false;
  const delimiter = (text.split("\n")[0] ?? "").split(";").length > (text.split("\n")[0] ?? "").split(",").length ? ";" : ",";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => (typeof c === "string" ? c.replace(/^﻿/, "").replace(/^'(?=[=+\-@])/, "") : c)));
}

/** Read an uploaded .xlsx or .csv and parse the first sheet that looks like game history. */
export async function readUpload(file: File, divisor: number, existing: ExistingGame[]): Promise<ParseResult & { sheet?: string }> {
  const buf = Buffer.from(await file.arrayBuffer());
  const isXlsx = buf.subarray(0, 2).toString("latin1") === "PK";
  if (!isXlsx) return parseSheet(parseCsv(buf.toString("utf8")), divisor, existing);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  let best: (ParseResult & { sheet?: string }) | null = null;
  for (const ws of wb.worksheets) {
    const table: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (n > 20000) return;
      const values = row.values as ExcelJS.CellValue[];
      table.push(values.slice(1).map(cellValue));
    });
    const r = parseSheet(table, divisor, existing);
    if (!r.error && (!best || r.games.length > best.games.length)) best = { ...r, sheet: ws.name };
  }
  return best ?? { columns: {}, games: [], error: "noColumns" };
}
