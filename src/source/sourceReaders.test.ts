import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { CsvReader } from "./CsvReader.js";
import { ExcelReader } from "./ExcelReader.js";

test("CSV row reading", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "anydb-migrate-csv-"));
  const filename = path.join(directory, "inventory.csv");
  await writeFile(filename, "SKU,Name,Quantity\nA100,Widget A,25\n", "utf8");
  const rows = await new CsvReader(filename).read();
  assert.deepEqual(rows, [{ rowNumber: 2, values: { SKU: "A100", Name: "Widget A", Quantity: "25" } }]);
});

test("XLSX row reading from a named worksheet", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "anydb-migrate-xlsx-"));
  const filename = path.join(directory, "inventory.xlsx");
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Ignored").addRow(["Other"]);
  const sheet = workbook.addWorksheet("Inventory");
  sheet.addRow(["SKU", "Name", "Quantity"]);
  sheet.addRow(["A100", "Widget A", 25]);
  await workbook.xlsx.writeFile(filename);
  const rows = await new ExcelReader(filename, "Inventory").read();
  assert.deepEqual(rows, [{ rowNumber: 2, values: { SKU: "A100", Name: "Widget A", Quantity: 25 } }]);
});
