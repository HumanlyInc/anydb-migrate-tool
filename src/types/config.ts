export type ObjectMode = "create" | "lookup" | "upsert";

/** Reads a source column and optionally transforms it. All transforms are declarative. */
export interface ColumnSource {
  column: string;
  /** Translate source values (after trim/lower/decode). */
  map?: Record<string, unknown>;
  /** Used when the value is empty, or when it is unmapped and `strict` is not set. */
  default?: unknown;
  /** An unmapped, non-empty value fails the row instead of passing through. */
  strict?: boolean;
  /** Split a delimited string into an array (for multi-select fields and ID lists). */
  split?: string;
  /** Convert to epoch seconds: Excel serial day numbers or ISO date text. */
  date?: "excel" | "iso";
  lower?: boolean;
  /** Text is trimmed by default; set false to keep surrounding whitespace. */
  trim?: boolean;
  /** Decode HTML entities such as &amp;. */
  decode?: boolean;
  number?: boolean;
  boolean?: boolean;
}

export type ValueSource =
  | string
  | ColumnSource
  | { value: unknown }
  | { object: string }
  | { template: string }
  | { coalesce: string[] };

export interface SingleMatch {
  field: string;
  column: string;
}

export interface CompoundMatch {
  fields: Record<string, ValueSource>;
  /** Also require the record to sit under this earlier object. */
  parent?: { object: string };
}

/** Matches the record of this type that sits under an earlier object (e.g. the one Partner Info of a Partner). */
export interface ParentMatch {
  parent: { object: string };
}

export type MatchConfig = SingleMatch | CompoundMatch | ParentMatch;

export interface ObjectConfig {
  name: string;
  type: string;
  mode: ObjectMode;
  /** AnyDB template ADOID. If omitted, it is discovered from existing records. */
  template?: string;
  match?: MatchConfig;
  fields?: Record<string, ValueSource>;
  references?: Record<string, { object: string }>;
  /** Earlier objects this record is attached under. The first is the primary parent. */
  parents?: Array<{ object: string }>;
  /** A lookup that finds nothing (or has an empty key) is skipped instead of failing the row. */
  optional?: boolean;
  /** Skip this object for rows where any of these source columns is empty. */
  skipWhenEmpty?: string[];
}

export interface SourceConfig {
  file: string;
  sheet?: string;
}

export interface StepConfig {
  name: string;
  source: SourceConfig;
  objects: ObjectConfig[];
}

export interface AnyDBSettings {
  teamId?: string;
  databaseId?: string;
  baseUrl?: string;
}

/** What the engine needs to process one source. */
export interface MigrationConfig {
  name: string;
  anydb?: AnyDBSettings;
  source: SourceConfig;
  objects: ObjectConfig[];
}

/** A whole migration: one or more steps, each with its own source, run in order. */
export interface MigrationPlan {
  name: string;
  anydb?: AnyDBSettings;
  steps: StepConfig[];
}

export interface LoadedStep {
  name: string;
  sourcePath: string;
  config: MigrationConfig;
}

export interface LoadedConfig {
  plan: MigrationPlan;
  configPath: string;
  steps: LoadedStep[];
}
