import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import type { SourceReader, SourceRow } from "./SourceReader.js";

export class CsvReader implements SourceReader {
  constructor(private readonly filename: string) {}

  async read(): Promise<SourceRow[]> {
    const input = await readFile(this.filename, "utf8");
    const records = parse(input, {
      bom: true,
      columns: true,
      relax_column_count: false,
      skip_empty_lines: true,
    }) as Record<string, string>[];
    return records.map((values, index) => ({ rowNumber: index + 2, values }));
  }
}
