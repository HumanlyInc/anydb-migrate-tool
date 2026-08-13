import ExcelJS from "exceljs";
import type { SourceReader, SourceRow } from "./SourceReader.js";

function cellValue(value: ExcelJS.CellValue): unknown {
  if (value && typeof value === "object") {
    if ("result" in value) return value.result;
    if ("text" in value) return value.text;
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
  }
  return value;
}

export class ExcelReader implements SourceReader {
  constructor(private readonly filename: string, private readonly sheet?: string) {}

  async read(): Promise<SourceRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(this.filename);
    const worksheet = this.sheet ? workbook.getWorksheet(this.sheet) : workbook.worksheets[0];
    if (!worksheet) {
      const suffix = this.sheet ? ` named "${this.sheet}"` : "";
      throw new Error(`Workbook has no worksheet${suffix}`);
    }
    const headerRow = worksheet.getRow(1);
    const headers: string[] = [];
    for (let column = 1; column <= headerRow.cellCount; column += 1) {
      const header = String(cellValue(headerRow.getCell(column).value) ?? "").trim();
      if (!header) throw new Error(`Worksheet "${worksheet.name}" has a blank header in column ${column}`);
      if (headers.includes(header)) throw new Error(`Worksheet "${worksheet.name}" has duplicate header "${header}"`);
      headers.push(header);
    }
    const rows: SourceRow[] = [];
    for (let rowNumber = 2; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const values: Record<string, unknown> = {};
      let nonempty = false;
      headers.forEach((header, index) => {
        const value = cellValue(row.getCell(index + 1).value);
        values[header] = value;
        if (value !== null && value !== undefined && value !== "") nonempty = true;
      });
      if (nonempty) rows.push({ rowNumber, values });
    }
    return rows;
  }
}
