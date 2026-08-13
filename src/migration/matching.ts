import type { MatchConfig } from "../types/config.js";
import type { ResolvedObject } from "./mapping.js";
import { buildValues } from "./mapping.js";
import type { MigrationValue } from "../anydb/AnyDBClient.js";

export function buildMatch(
  match: MatchConfig,
  row: Record<string, unknown>,
  resolved: Map<string, ResolvedObject>,
): Record<string, MigrationValue> {
  const values = "field" in match
    ? { [match.field]: row[match.column] }
    : buildValues(match.fields, row, resolved);
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") {
      throw new Error(`Match field "${field}" resolved to an empty value`);
    }
  }
  return values;
}
