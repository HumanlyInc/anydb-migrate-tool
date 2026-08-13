import type {
  LoadedConfig,
  MatchConfig,
  MigrationConfig,
  ObjectConfig,
  ValueSource,
} from "../types/config.js";

export class ConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
}

function validateValueSource(value: unknown, path: string): asserts value is ValueSource {
  if (typeof value === "string") return;
  if (!isRecord(value)) throw new ConfigError(`${path} must map from a column, object, or literal value`);
  const keys = ["column", "object", "value"].filter((key) => key in value);
  if (keys.length !== 1) throw new ConfigError(`${path} must contain exactly one of column, object, or value`);
  if (keys[0] !== "value") requiredString(value[keys[0]!], `${path}.${keys[0]}`);
}

function validateMatch(value: unknown, path: string): asserts value is MatchConfig {
  if (!isRecord(value)) throw new ConfigError(`${path} must be an object`);
  if ("field" in value || "column" in value) {
    requiredString(value.field, `${path}.field`);
    requiredString(value.column, `${path}.column`);
    return;
  }
  if (!isRecord(value.fields) || Object.keys(value.fields).length === 0) {
    throw new ConfigError(`${path}.fields must contain at least one field`);
  }
  for (const [field, source] of Object.entries(value.fields)) {
    requiredString(field, `${path}.fields field name`);
    validateValueSource(source, `${path}.fields.${field}`);
  }
}

function referencedNames(object: ObjectConfig): string[] {
  const names = Object.values(object.references ?? {}).map((ref) => ref.object);
  for (const source of Object.values(object.fields ?? {})) {
    if (typeof source === "object" && source !== null && "object" in source) names.push(source.object);
  }
  if (object.match && "fields" in object.match) {
    for (const source of Object.values(object.match.fields)) {
      if (typeof source === "object" && source !== null && "object" in source) names.push(source.object);
    }
  }
  return names;
}

export function validateConfig(value: unknown): asserts value is MigrationConfig {
  if (!isRecord(value)) throw new ConfigError("Configuration must be a YAML object");
  requiredString(value.name, "name");
  if (!isRecord(value.source)) throw new ConfigError("source is required");
  requiredString(value.source.file, "source.file");
  if (value.source.sheet !== undefined) requiredString(value.source.sheet, "source.sheet");
  if (!Array.isArray(value.objects) || value.objects.length === 0) {
    throw new ConfigError("objects must contain at least one object");
  }
  if (value.anydb !== undefined) {
    if (!isRecord(value.anydb)) throw new ConfigError("anydb must be an object");
    for (const key of ["teamId", "databaseId", "baseUrl"] as const) {
      if (value.anydb[key] !== undefined) requiredString(value.anydb[key], `anydb.${key}`);
    }
  }

  const seen = new Set<string>();
  value.objects.forEach((raw, index) => {
    const path = `objects[${index}]`;
    if (!isRecord(raw)) throw new ConfigError(`${path} must be an object`);
    requiredString(raw.name, `${path}.name`);
    requiredString(raw.type, `${path}.type`);
    if (!(["create", "lookup", "upsert"] as unknown[]).includes(raw.mode)) {
      throw new ConfigError(`${path}.mode must be create, lookup, or upsert`);
    }
    if (seen.has(raw.name)) throw new ConfigError(`Object name "${raw.name}" is duplicated`);
    if (raw.template !== undefined) requiredString(raw.template, `${path}.template`);
    if ((raw.mode === "lookup" || raw.mode === "upsert") && raw.match === undefined) {
      throw new ConfigError(`${path}.match is required for ${raw.mode} mode`);
    }
    if (raw.match !== undefined) validateMatch(raw.match, `${path}.match`);
    if (raw.fields !== undefined) {
      if (!isRecord(raw.fields)) throw new ConfigError(`${path}.fields must be an object`);
      for (const [field, source] of Object.entries(raw.fields)) validateValueSource(source, `${path}.fields.${field}`);
    }
    if (raw.references !== undefined) {
      if (!isRecord(raw.references)) throw new ConfigError(`${path}.references must be an object`);
      for (const [field, ref] of Object.entries(raw.references)) {
        if (!isRecord(ref)) throw new ConfigError(`${path}.references.${field} must be an object`);
        requiredString(ref.object, `${path}.references.${field}.object`);
      }
    }
    const object = raw as unknown as ObjectConfig;
    for (const reference of referencedNames(object)) {
      if (!seen.has(reference)) {
        throw new ConfigError(`${path} references "${reference}", which must appear earlier in objects`);
      }
    }
    seen.add(raw.name);
  });
}

export function validateLoadedConfig(loaded: LoadedConfig): void {
  validateConfig(loaded.config);
}
