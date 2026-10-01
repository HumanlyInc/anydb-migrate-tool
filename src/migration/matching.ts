import type { MatchConfig } from "../types/config.js";
import type { ResolvedObject } from "./mapping.js";
import { buildValues } from "./mapping.js";
import type { MigrationValue } from "../anydb/AnyDBClient.js";

export interface MatchSpec {
  /** Field values the record must have. */
  values: Record<string, MigrationValue>;
  /** The record must be attached under this parent id. */
  parent?: string;
}

export function buildMatchSpec(
  match: MatchConfig,
  row: Record<string, unknown>,
  resolved: Map<string, ResolvedObject>,
): MatchSpec {
  let values: Record<string, MigrationValue> = {};
  if ("field" in match) values = { [match.field]: row[match.column] };
  else if ("fields" in match) values = buildValues(match.fields, row, resolved);

  let parent: string | undefined;
  if ("parent" in match && match.parent) {
    const target = resolved.get(match.parent.object);
    if (!target) throw new Error(`Match parent "${match.parent.object}" has not been resolved for this row`);
    if (target.status === "missing" || target.status === "skipped") {
      throw new Error(`Match parent "${match.parent.object}" was not found or skipped for this row`);
    }
    parent = target.id;
  }

  for (const [field, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") {
      throw new Error(`Match field "${field}" resolved to an empty value`);
    }
  }
  return { values, parent };
}

export function buildMatch(
  match: MatchConfig,
  row: Record<string, unknown>,
  resolved: Map<string, ResolvedObject>,
): Record<string, MigrationValue> {
  return buildMatchSpec(match, row, resolved).values;
}
