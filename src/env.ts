import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Loads credentials from a local env file without ever logging values.
 * Accepts dotenv lines (KEY=value, export KEY=value) and PowerShell lines
 * ($env:KEY="value"), including a pasted shell prompt before the statement.
 * Variables already present in the process environment are never overridden;
 * for a repeated key in the file, the last one wins.
 */
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const unquote = (raw: string): string => {
    const value = raw.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) return value.slice(1, -1);
    return value;
  };
  for (const line of text.split(/\r?\n/)) {
    const powershell = /\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (powershell) {
      values[powershell[1]!] = unquote(powershell[2]!);
      continue;
    }
    const dotenv = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (dotenv && !line.trim().startsWith("#")) values[dotenv[1]!] = unquote(dotenv[2]!);
  }
  return values;
}

/** Returns the names (never the values) of the variables it set. */
export function loadEnvFile(filename = process.env.ANYDB_ENV_FILE ?? ".env"): string[] {
  const file = path.resolve(filename);
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseEnvText(readFileSync(file, "utf8")))) {
    if (process.env[key] === undefined && value !== "") {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
