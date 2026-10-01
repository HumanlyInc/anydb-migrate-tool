import { isReference, type MigrationValue } from "../anydb/AnyDBClient.js";

function normalize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (isReference(value)) return `ref:${value.$ref}`;
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => String(item)).sort());
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return String(Math.round(value.getTime() / 1000));
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Loose equality between a stored value and a value we intend to write, so a
 * re-run can tell that nothing changed: "6000" equals 6000, true equals "true",
 * array order is ignored, and a stored reference id equals {$ref: id}.
 */
export function sameValue(actual: unknown, desired: MigrationValue): boolean {
  if (isReference(desired)) return normalize(actual) === desired.$ref || normalize(actual) === `ref:${desired.$ref}`;
  if (Array.isArray(desired) && !Array.isArray(actual)) {
    return normalize(desired) === normalize(actual === undefined || actual === null || actual === "" ? [] : [actual]);
  }
  return normalize(actual) === normalize(desired);
}

export function changedFields(
  existing: Record<string, unknown>,
  desired: Record<string, MigrationValue>,
): Record<string, MigrationValue> {
  return Object.fromEntries(Object.entries(desired).filter(([field, value]) => !sameValue(existing[field], value)));
}
