import type {
  MatchConfig,
  MigrationConfig,
  MigrationPlan,
  ObjectConfig,
  SourceConfig,
  StepConfig,
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

const BASE_KEYS = ["column", "object", "value", "template", "coalesce"];
const COLUMN_MODIFIERS = ["map", "default", "strict", "split", "date", "lower", "trim", "decode", "number", "boolean"];

function validateValueSource(value: unknown, path: string): asserts value is ValueSource {
  if (typeof value === "string") return;
  if (!isRecord(value)) throw new ConfigError(`${path} must map from a column, object, or literal value`);
  const bases = BASE_KEYS.filter((key) => key in value);
  if (bases.length !== 1) {
    throw new ConfigError(`${path} must contain exactly one of ${BASE_KEYS.join(", ")}`);
  }
  const base = bases[0]!;
  const allowed = base === "column" ? [base, ...COLUMN_MODIFIERS] : [base];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ConfigError(`${path}.${key} is not allowed with ${base}`);
  }
  if (base === "coalesce") {
    if (!Array.isArray(value.coalesce) || value.coalesce.length === 0) {
      throw new ConfigError(`${path}.coalesce must list at least one column`);
    }
    value.coalesce.forEach((column, index) => requiredString(column, `${path}.coalesce[${index}]`));
    return;
  }
  if (base !== "value") requiredString(value[base], `${path}.${base}`);
  if (base !== "column") return;
  if (value.map !== undefined && !isRecord(value.map)) throw new ConfigError(`${path}.map must be an object`);
  if (value.split !== undefined) requiredString(value.split, `${path}.split`);
  if (value.date !== undefined && value.date !== "excel" && value.date !== "iso") {
    throw new ConfigError(`${path}.date must be excel or iso`);
  }
  for (const flag of ["strict", "lower", "trim", "decode", "number", "boolean"]) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") {
      throw new ConfigError(`${path}.${flag} must be true or false`);
    }
  }
  if (value.strict && value.map === undefined) throw new ConfigError(`${path}.strict requires map`);
}

function validateMatch(value: unknown, path: string): asserts value is MatchConfig {
  if (!isRecord(value)) throw new ConfigError(`${path} must be an object`);
  if ("field" in value || "column" in value) {
    requiredString(value.field, `${path}.field`);
    requiredString(value.column, `${path}.column`);
    return;
  }
  if (value.parent !== undefined) {
    if (!isRecord(value.parent)) throw new ConfigError(`${path}.parent must be an object`);
    requiredString(value.parent.object, `${path}.parent.object`);
    if (value.fields === undefined) return;
  }
  if (!isRecord(value.fields) || Object.keys(value.fields).length === 0) {
    throw new ConfigError(`${path} needs field and column, fields, or parent`);
  }
  for (const [field, source] of Object.entries(value.fields)) {
    requiredString(field, `${path}.fields field name`);
    validateValueSource(source, `${path}.fields.${field}`);
  }
}

function objectRefs(source: unknown): string[] {
  return typeof source === "object" && source !== null && "object" in source ? [(source as { object: string }).object] : [];
}

function referencedNames(object: ObjectConfig): string[] {
  const names = Object.values(object.references ?? {}).map((ref) => ref.object);
  for (const parent of object.parents ?? []) names.push(parent.object);
  for (const source of Object.values(object.fields ?? {})) names.push(...objectRefs(source));
  if (object.match && "fields" in object.match) {
    for (const source of Object.values(object.match.fields)) names.push(...objectRefs(source));
  }
  if (object.match && "parent" in object.match && object.match.parent) names.push(object.match.parent.object);
  return names;
}

function validateObjects(objects: unknown, path: string): void {
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new ConfigError(`${path} must contain at least one object`);
  }
  const seen = new Set<string>();
  objects.forEach((raw, index) => {
    const here = `${path}[${index}]`;
    if (!isRecord(raw)) throw new ConfigError(`${here} must be an object`);
    requiredString(raw.name, `${here}.name`);
    requiredString(raw.type, `${here}.type`);
    if (!(["create", "lookup", "upsert"] as unknown[]).includes(raw.mode)) {
      throw new ConfigError(`${here}.mode must be create, lookup, or upsert`);
    }
    if (seen.has(raw.name)) throw new ConfigError(`Object name "${raw.name}" is duplicated`);
    if (raw.template !== undefined) requiredString(raw.template, `${here}.template`);
    if ((raw.mode === "lookup" || raw.mode === "upsert") && raw.match === undefined) {
      throw new ConfigError(`${here}.match is required for ${raw.mode} mode`);
    }
    if (raw.match !== undefined) validateMatch(raw.match, `${here}.match`);
    if (raw.fields !== undefined) {
      if (!isRecord(raw.fields)) throw new ConfigError(`${here}.fields must be an object`);
      for (const [field, source] of Object.entries(raw.fields)) validateValueSource(source, `${here}.fields.${field}`);
    }
    if (raw.references !== undefined) {
      if (!isRecord(raw.references)) throw new ConfigError(`${here}.references must be an object`);
      for (const [field, ref] of Object.entries(raw.references)) {
        if (!isRecord(ref)) throw new ConfigError(`${here}.references.${field} must be an object`);
        requiredString(ref.object, `${here}.references.${field}.object`);
      }
    }
    if (raw.parents !== undefined) {
      if (!Array.isArray(raw.parents)) throw new ConfigError(`${here}.parents must be a list`);
      raw.parents.forEach((parent, parentIndex) => {
        if (!isRecord(parent)) throw new ConfigError(`${here}.parents[${parentIndex}] must be an object`);
        requiredString(parent.object, `${here}.parents[${parentIndex}].object`);
      });
    }
    if (raw.optional !== undefined && typeof raw.optional !== "boolean") {
      throw new ConfigError(`${here}.optional must be true or false`);
    }
    if (raw.optional && raw.mode === "create") throw new ConfigError(`${here}.optional only applies to lookup or upsert`);
    if (raw.skipWhenEmpty !== undefined) {
      if (!Array.isArray(raw.skipWhenEmpty)) throw new ConfigError(`${here}.skipWhenEmpty must be a list of columns`);
      raw.skipWhenEmpty.forEach((column, columnIndex) => requiredString(column, `${here}.skipWhenEmpty[${columnIndex}]`));
    }
    const object = raw as unknown as ObjectConfig;
    for (const reference of referencedNames(object)) {
      if (!seen.has(reference)) {
        throw new ConfigError(`${here} references "${reference}", which must appear earlier in objects`);
      }
    }
    seen.add(raw.name);
  });
}

function validateSource(source: unknown, path: string): asserts source is SourceConfig {
  if (!isRecord(source)) throw new ConfigError(`${path} is required`);
  requiredString(source.file, `${path}.file`);
  if (source.sheet !== undefined) requiredString(source.sheet, `${path}.sheet`);
}

/** Accepts either the single-source form (source + objects) or a multi-step form (steps). */
export function validateConfig(value: unknown): asserts value is MigrationConfig | MigrationPlan {
  if (!isRecord(value)) throw new ConfigError("Configuration must be a YAML object");
  requiredString(value.name, "name");
  if (value.anydb !== undefined) {
    if (!isRecord(value.anydb)) throw new ConfigError("anydb must be an object");
    for (const key of ["teamId", "databaseId", "baseUrl"] as const) {
      if (value.anydb[key] !== undefined) requiredString(value.anydb[key], `anydb.${key}`);
    }
  }
  if (value.steps !== undefined) {
    if (value.source !== undefined || value.objects !== undefined) {
      throw new ConfigError("Use either steps or source with objects, not both");
    }
    if (!Array.isArray(value.steps) || value.steps.length === 0) throw new ConfigError("steps must contain at least one step");
    const names = new Set<string>();
    value.steps.forEach((step, index) => {
      const path = `steps[${index}]`;
      if (!isRecord(step)) throw new ConfigError(`${path} must be an object`);
      requiredString(step.name, `${path}.name`);
      if (names.has(step.name)) throw new ConfigError(`Step name "${step.name}" is duplicated`);
      names.add(step.name);
      validateSource(step.source, `${path}.source`);
      validateObjects(step.objects, `${path}.objects`);
    });
    return;
  }
  validateSource(value.source, "source");
  validateObjects(value.objects, "objects");
}

export function normalizeConfig(config: MigrationConfig | MigrationPlan): MigrationPlan {
  if ("steps" in config && Array.isArray(config.steps)) return config;
  const single = config as MigrationConfig;
  const step: StepConfig = { name: single.name, source: single.source, objects: single.objects };
  return { name: single.name, anydb: single.anydb, steps: [step] };
}
