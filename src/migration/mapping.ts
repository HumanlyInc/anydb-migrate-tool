import type { ValueSource } from "../types/config.js";
import { reference, type MigrationValue } from "../anydb/AnyDBClient.js";

export interface ResolvedObject {
  id: string;
  status: "created" | "updated" | "found";
}

export function resolveValue(
  source: ValueSource,
  row: Record<string, unknown>,
  resolved: Map<string, ResolvedObject>,
): MigrationValue {
  if (typeof source === "string") return row[source];
  if ("column" in source) return row[source.column];
  if ("value" in source) return source.value;
  const object = resolved.get(source.object);
  if (!object) throw new Error(`Referenced object "${source.object}" has not been resolved for this row`);
  return reference(object.id);
}

export function buildValues(
  mappings: Record<string, ValueSource> | undefined,
  row: Record<string, unknown>,
  resolved: Map<string, ResolvedObject>,
): Record<string, MigrationValue> {
  return Object.fromEntries(
    Object.entries(mappings ?? {}).map(([field, source]) => [field, resolveValue(source, row, resolved)]),
  );
}
