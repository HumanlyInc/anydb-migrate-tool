import { loadConfig } from "../config/loadConfig.js";
import { createSourceReader } from "../source/createSourceReader.js";
import { MigrationEngine, type MigrationResult } from "../migration/MigrationEngine.js";
import { createSdkClient } from "../anydb/createSdkClient.js";
import { validateAgainstAnyDB } from "../config/validateRemote.js";

export interface CliRunOptions {
  dryRun?: boolean;
  limit?: string;
  failFast?: boolean;
  verbose?: boolean;
  requestsPerMinute?: string;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--limit must be a positive integer");
  return parsed;
}

export function formatSummary(result: MigrationResult): string {
  const lines = [`Migration: ${result.migrationName}`, `Rows processed: ${result.rowsProcessed}`, ""];
  for (const [name, counts] of Object.entries(result.summaries)) {
    lines.push(name);
    if (counts.created) lines.push(`  Create: ${counts.created}`);
    if (counts.updated) lines.push(`  Update: ${counts.updated}`);
    if (counts.found) lines.push(`  Found: ${counts.found}`);
    if (counts.missing) lines.push(`  Missing: ${counts.missing}`);
    if (!Object.values(counts).some(Boolean)) lines.push("  No actions");
    lines.push("");
  }
  lines.push(`Failed rows: ${result.failures.length}`);
  return lines.join("\n");
}

export async function runCommand(configFile: string, options: CliRunOptions): Promise<void> {
  const loaded = await loadConfig(configFile);
  const rows = await createSourceReader(loaded.sourcePath, loaded.config.source.sheet).read();
  const client = createSdkClient(loaded.config, {
    verbose: options.verbose,
    requestsPerMinute: options.requestsPerMinute,
  });
  console.log(`Checking AnyDB types and fields for ${loaded.config.name}...`);
  await validateAgainstAnyDB(client, loaded.config, rows);
  const limit = parseLimit(options.limit);
  const totalRows = limit === undefined ? rows.length : Math.min(rows.length, limit);
  console.log(`Starting ${options.dryRun ? "dry run" : "migration"}: ${totalRows} row${totalRows === 1 ? "" : "s"}`);
  const engine = new MigrationEngine(client);
  const result = await engine.run(loaded.config, rows, {
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
  }
  console.log(formatSummary(result));
  if (result.failures.length > 0) process.exitCode = 1;
}
