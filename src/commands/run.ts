import { writeFile } from "node:fs/promises";
import { loadConfig } from "../config/loadConfig.js";
import { createSourceReader } from "../source/createSourceReader.js";
import type { SourceRow } from "../source/SourceReader.js";
import { MigrationEngine, type MigrationFailure, type MigrationResult } from "../migration/MigrationEngine.js";
import { createSdkClient } from "../anydb/createSdkClient.js";
import { validateAgainstAnyDB } from "../config/validateRemote.js";

export interface CliRunOptions {
  dryRun?: boolean;
  limit?: string;
  failFast?: boolean;
  verbose?: boolean;
  requestsPerMinute?: string;
  /** "Column=value1,value2" filters; a step is only filtered if it has that column. */
  where?: string[];
  /** Run only the named steps. */
  step?: string[];
  /** Write failed rows to this CSV file. */
  failures?: string;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--limit must be a positive integer");
  return parsed;
}

export interface WhereFilter {
  column: string;
  values: Set<string>;
}

export function parseWhere(expressions: string[] | undefined): WhereFilter[] {
  return (expressions ?? []).map((expression) => {
    const at = expression.indexOf("=");
    if (at < 1) throw new Error(`--where must look like Column=value1,value2 (got "${expression}")`);
    const values = expression.slice(at + 1).split(",").map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) throw new Error(`--where "${expression}" lists no values`);
    return { column: expression.slice(0, at).trim(), values: new Set(values) };
  });
}

export function applyWhere(rows: SourceRow[], filters: WhereFilter[]): SourceRow[] {
  let result = rows;
  for (const filter of filters) {
    if (!result.some((row) => filter.column in row.values)) continue;
    result = result.filter((row) => filter.values.has(String(row.values[filter.column] ?? "").trim()));
  }
  return result;
}

export function formatSummary(result: MigrationResult): string {
  const lines = [`Migration: ${result.migrationName}`, `Rows processed: ${result.rowsProcessed}`, ""];
  for (const [name, counts] of Object.entries(result.summaries)) {
    lines.push(name);
    if (counts.created) lines.push(`  Create: ${counts.created}`);
    if (counts.updated) lines.push(`  Update: ${counts.updated}`);
    if (counts.unchanged) lines.push(`  Unchanged: ${counts.unchanged}`);
    if (counts.found) lines.push(`  Found: ${counts.found}`);
    if (counts.missing) lines.push(`  Missing: ${counts.missing}`);
    if (counts.skipped) lines.push(`  Skipped: ${counts.skipped}`);
    if (!Object.values(counts).some(Boolean)) lines.push("  No actions");
    lines.push("");
  }
  lines.push(`Failed rows: ${result.failures.length}`);
  return lines.join("\n");
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function failuresCsv(failures: Array<MigrationFailure & { step: string }>): string {
  const rows = [["step", "row", "object", "type", "reason"]];
  for (const failure of failures) {
    rows.push([failure.step, String(failure.rowNumber), failure.objectName, failure.objectType, failure.reason]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export async function runCommand(configFile: string, options: CliRunOptions): Promise<void> {
  const loaded = await loadConfig(configFile);
  const filters = parseWhere(options.where);
  const limit = parseLimit(options.limit);
  const selected = loaded.steps.filter((step) => !options.step?.length || options.step.includes(step.name));
  if (selected.length === 0) {
    throw new Error(`No step matches ${options.step?.join(", ")}. Steps: ${loaded.steps.map((step) => step.name).join(", ")}`);
  }

  const client = createSdkClient(loaded.plan, {
    verbose: options.verbose,
    requestsPerMinute: options.requestsPerMinute,
  });
  const engine = new MigrationEngine(client);
  const allFailures: Array<MigrationFailure & { step: string }> = [];

  for (const step of selected) {
    console.log(`\n=== Step: ${step.name}`);
    const all = await createSourceReader(step.sourcePath, step.config.source.sheet).read();
    const rows = applyWhere(all, filters);
    console.log(`Checking AnyDB types and fields for ${step.name}...`);
    await validateAgainstAnyDB(client, step.config, rows.length > 0 ? rows : all);
    const totalRows = limit === undefined ? rows.length : Math.min(rows.length, limit);
    console.log(`Starting ${options.dryRun ? "dry run" : "migration"}: ${totalRows} of ${all.length} row${all.length === 1 ? "" : "s"}`);
    const result = await engine.run(step.config, rows, {
      dryRun: options.dryRun,
      limit,
      failFast: options.failFast,
      verbose: options.verbose,
      onEvent: options.verbose ? console.log : undefined,
      onProgress: (completed, total, failed) => {
        const percentage = total === 0 ? 100 : Math.round((completed / total) * 100);
        console.log(`Progress: ${completed}/${total} rows (${percentage}%)${failed ? `, ${failed} failed` : ""}`);
      },
    });
    for (const failure of result.failures) {
      console.error(`Row ${failure.rowNumber} / ${failure.objectName} / ${failure.objectType}:\n${failure.reason}`);
      if (options.verbose && failure.cause instanceof Error && failure.cause.stack) console.error(failure.cause.stack);
      allFailures.push({ ...failure, step: step.name });
    }
    console.log(formatSummary(result));
    if (options.failFast && result.failures.length > 0) break;
  }

  if (options.failures && allFailures.length > 0) {
    await writeFile(options.failures, failuresCsv(allFailures), "utf8");
    console.log(`Wrote ${allFailures.length} failed row${allFailures.length === 1 ? "" : "s"} to ${options.failures}`);
  }
  console.log(`Total failed rows: ${allFailures.length}`);
  if (allFailures.length > 0) process.exitCode = 1;
}
