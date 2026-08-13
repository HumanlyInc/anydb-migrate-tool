#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { validateCommand } from "./commands/validate.js";
import { runCommand, type CliRunOptions } from "./commands/run.js";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const program = new Command()
  .name("anydb-migrate")
  .description("Import CSV or XLSX rows into interlinked AnyDB objects")
  .version(version);

program
  .command("validate")
  .description("Validate a migration configuration and its source")
  .argument("<config>", "YAML migration configuration")
  .action(validateCommand);

program
  .command("run")
  .description("Run a migration")
  .argument("<config>", "YAML migration configuration")
  .option("--dry-run", "perform lookups but make no writes")
  .option("--limit <rows>", "process only the first number of rows")
  .option("--fail-fast", "stop after the first failed row")
  .option(
    "--requests-per-minute <rate>",
    "AnyDB API request limit (default: 100)",
  )
  .option("--verbose", "show per-object activity and stack traces")
  .action((config: string, options: CliRunOptions) =>
    runCommand(config, options),
  );

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (
    process.argv.includes("--verbose") &&
    error instanceof Error &&
    error.stack
  )
    console.error(error.stack);
  process.exitCode = 1;
}
