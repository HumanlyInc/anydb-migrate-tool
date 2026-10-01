#!/usr/bin/env node
import { Command } from "commander";
import { loadEnvFile } from "./env.js";
import { checkCommand } from "./commands/check.js";
import { orphansCommand } from "./commands/orphans.js";
import { validateCommand } from "./commands/validate.js";
import { runCommand, type CliRunOptions } from "./commands/run.js";

// Credentials come from the environment or a local env file; values are never printed.
const envFileFlag = process.argv.indexOf("--env-file");
loadEnvFile(envFileFlag >= 0 ? process.argv[envFileFlag + 1] : undefined);

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

const program = new Command()
  .name("anydb-migrate")
  .description("Import CSV or XLSX rows into interlinked AnyDB objects")
  .version("0.2.0")
  .option("--env-file <file>", "read credentials from this file instead of .env");

program.command("check")
  .description("Show which settings are present and test the AnyDB connection")
  .action(checkCommand);

program.command("orphans")
  .description("List records the plan created but never filled in (left behind by a failed create). Read-only; delete them in AnyDB")
  .argument("<config>", "YAML migration configuration")
  .action(orphansCommand);

program.command("validate")
  .description("Validate a migration configuration and its sources")
  .argument("<config>", "YAML migration configuration")
  .action(validateCommand);

program.command("run")
  .description("Run a migration (one or more steps)")
  .argument("<config>", "YAML migration configuration")
  .option("--dry-run", "perform lookups but make no writes; a second dry run after a real run should show everything unchanged")
  .option("--limit <rows>", "process only the first number of rows of each step")
  .option("--where <filter>", "only rows where Column=value1,value2 (repeatable)", collect)
  .option("--step <name>", "run only this step (repeatable)", collect)
  .option("--failures <file>", "write failed rows to this CSV file")
  .option("--fail-fast", "stop after the first failed row")
  .option("--requests-per-minute <rate>", "AnyDB API request limit (default: 100)")
  .option("--verbose", "show per-object activity and stack traces")
  .action((config: string, options: CliRunOptions) => runCommand(config, options));

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (process.argv.includes("--verbose") && error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
}
