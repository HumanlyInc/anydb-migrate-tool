import type { ColumnSource, ValueSource } from "../types/config.js";
import { reference, type MigrationValue } from "../anydb/AnyDBClient.js";

export interface ResolvedObject {
  id: string;
  status: "created" | "updated" | "unchanged" | "found" | "missing" | "skipped";
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

export function decodeHtml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** Excel serial day number to epoch seconds (UTC). */
export function excelSerialToEpoch(serial: number): number {
  return Math.round((serial - 25569) * 86400);
}

function toEpoch(raw: unknown, kind: "excel" | "iso"): number | undefined {
  if (raw instanceof Date) return Math.round(raw.getTime() / 1000);
  if (typeof raw === "number") return kind === "excel" ? excelSerialToEpoch(raw) : Math.round(raw);
  if (typeof raw === "string" && raw.trim() !== "") {
    const text = raw.trim();
    if (kind === "excel" && /^-?\d+(\.\d+)?$/.test(text)) return excelSerialToEpoch(Number(text));
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return Math.round(parsed / 1000);
    throw new Error(`Cannot read "${text}" as a date`);
  }
  return undefined;
}

function toBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (isEmptyValue(raw)) return undefined;
  const text = String(raw).trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(text)) return true;
  if (["false", "no", "n", "0"].includes(text)) return false;
  throw new Error(`Cannot read "${String(raw)}" as true or false`);
}

function prepareText(raw: unknown, source: ColumnSource): unknown {
  if (typeof raw !== "string") return raw;
  let text = raw;
  if (source.trim !== false) text = text.trim();
  if (source.decode) text = decodeHtml(text);
  if (source.lower) text = text.toLowerCase();
  return text;
}

function mapOne(value: unknown, source: ColumnSource): unknown {
  if (!source.map) return value;
  const key = String(value);
  if (Object.prototype.hasOwnProperty.call(source.map, key)) return source.map[key];
  if (source.strict) throw new Error(`Unmapped value "${key}" in column "${source.column}"`);
  return source.default !== undefined ? source.default : value;
}

export function applyColumn(source: ColumnSource, row: Record<string, unknown>): MigrationValue {
  const value: unknown = prepareText(row[source.column], source);
  if (isEmptyValue(value)) return source.default;
  if (source.split !== undefined && typeof value === "string") {
    const parts = value.split(source.split).map((part) => String(prepareText(part, source))).filter((part) => part !== "");
    return parts.map((part) => mapOne(part, source));
  }
  if (source.date) return toEpoch(value, source.date);
  if (source.number) {
    const parsed = Number(String(value).replace(/[, $]/g, ""));
    if (!Number.isFinite(parsed)) throw new Error(`Cannot read "${String(value)}" as a number`);
    return parsed;
  }
  if (source.boolean) return toBoolean(value);
  return mapOne(value, source);
}

export function resolveValue(
  source: ValueSource,
  row: Record<string, unknown>,
  resolved: Map<string, ResolvedObject>,
): MigrationValue {
  if (typeof source === "string") return row[source];
  if ("column" in source) return applyColumn(source, row);
  if ("value" in source) return source.value;
  if ("template" in source) {
    return source.template.replace(/\{([^}]+)\}/g, (_match, column: string) => String(row[column.trim()] ?? "").trim());
  }
  if ("coalesce" in source) {
    for (const column of source.coalesce) if (!isEmptyValue(row[column])) return row[column];
    return undefined;
  }
  const object = resolved.get(source.object);
  if (!object) throw new Error(`Referenced object "${source.object}" has not been resolved for this row`);
  if (object.status === "missing" || object.status === "skipped") return undefined;
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
