import path from "node:path";
import type { SourceReader } from "./SourceReader.js";
import { CsvReader } from "./CsvReader.js";
import { ExcelReader } from "./ExcelReader.js";

export function createSourceReader(filename: string, sheet?: string): SourceReader {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".csv") {
    if (sheet) throw new Error("source.sheet is only valid for XLSX files");
    return new CsvReader(filename);
  }
  if (extension === ".xlsx") return new ExcelReader(filename, sheet);
  throw new Error(`Unsupported source format "${extension || "(none)"}"; use .csv or .xlsx`);
}
