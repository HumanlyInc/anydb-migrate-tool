import type { MigrationAnyDBClient } from "../anydb/AnyDBClient.js";
import type { MigrationConfig, ObjectConfig, ValueSource } from "../types/config.js";
import type { SourceRow } from "../source/SourceReader.js";

function configuredFields(object: ObjectConfig): Array<{ name: string; purpose: "field" | "match" | "reference" }> {
  const fields: Array<{ name: string; purpose: "field" | "match" | "reference" }> = [];
  for (const name of Object.keys(object.fields ?? {})) fields.push({ name, purpose: "field" });
  for (const name of Object.keys(object.references ?? {})) fields.push({ name, purpose: "reference" });
  if (object.match) {
    if ("field" in object.match) fields.push({ name: object.match.field, purpose: "match" });
    else for (const [name, source] of Object.entries(object.match.fields)) {
      fields.push({
        name,
        purpose: typeof source === "object" && source !== null && "object" in source ? "reference" : "match",
      });
    }
  }
  return fields;
}

function configuredColumns(object: ObjectConfig): string[] {
  const columns: string[] = [];
  const add = (source: ValueSource): void => {
    if (typeof source === "string") columns.push(source);
    else if ("column" in source) columns.push(source.column);
  };
  for (const source of Object.values(object.fields ?? {})) add(source);
  if (object.match) {
    if ("column" in object.match) columns.push(object.match.column);
    else for (const source of Object.values(object.match.fields)) add(source);
  }
  return columns;
}

/** Checks source columns and configured fields against live AnyDB type definitions. */
export async function validateAgainstAnyDB(
  client: MigrationAnyDBClient,
  config: MigrationConfig,
  rows: SourceRow[],
): Promise<void> {
  const errors: string[] = [];
  const availableTypes = await client.listTypes();
  const availableSet = new Set(availableTypes);
  const sourceColumns = new Set(rows.flatMap((row) => Object.keys(row.values)));

  for (const object of config.objects) {
    for (const column of configuredColumns(object)) {
      if (!sourceColumns.has(column)) errors.push(`${object.name}: source column "${column}" does not exist`);
    }
    if (!availableSet.has(object.type)) {
      errors.push(`${object.name}: AnyDB type "${object.type}" does not exist (available: ${availableTypes.join(", ") || "none"})`);
      continue;
    }
    const schema = await client.getType(object.type);
    const fields = new Map(schema.fields.map((field) => [field.name, field]));
    for (const configured of configuredFields(object)) {
      const actual = fields.get(configured.name);
      if (!actual) {
        errors.push(`${object.name}: type "${object.type}" has no field "${configured.name}"`);
      } else if (configured.purpose === "reference" && actual.valueType !== "ref" && actual.format !== "ref") {
        errors.push(`${object.name}: field "${configured.name}" on type "${object.type}" is not a reference field`);
      }
    }
  }

  if (errors.length > 0) throw new Error(`Migration configuration does not match AnyDB:\n- ${errors.join("\n- ")}`);
}
