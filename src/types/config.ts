export type ObjectMode = "create" | "lookup" | "upsert";

export type ValueSource =
  | string
  | { column: string }
  | { value: unknown }
  | { object: string };

export interface SingleMatch {
  field: string;
  column: string;
}

export interface CompoundMatch {
  fields: Record<string, ValueSource>;
}

export type MatchConfig = SingleMatch | CompoundMatch;

export interface ObjectConfig {
  name: string;
  type: string;
  mode: ObjectMode;
  /** AnyDB template ADOID. If omitted, it is discovered from existing records. */
  template?: string;
  match?: MatchConfig;
  fields?: Record<string, ValueSource>;
  references?: Record<string, { object: string }>;
}

export interface MigrationConfig {
  name: string;
  anydb?: {
    teamId?: string;
    databaseId?: string;
    baseUrl?: string;
  };
  source: {
    file: string;
    sheet?: string;
  };
  objects: ObjectConfig[];
}

export interface LoadedConfig {
  config: MigrationConfig;
  configPath: string;
  sourcePath: string;
}
