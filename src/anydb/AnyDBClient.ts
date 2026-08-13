export interface RecordReference {
  $ref: string;
}

export type MigrationValue = unknown | RecordReference;

export interface MigrationRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface AnyDBTypeField {
  name: string;
  position: string;
  valueType?: string;
  format?: string;
}

export interface AnyDBTypeSchema {
  name: string;
  id: string;
  fields: AnyDBTypeField[];
}

export interface MigrationAnyDBClient {
  listTypes(): Promise<string[]>;
  getType(objectType: string): Promise<AnyDBTypeSchema>;
  findRecord(objectType: string, match: Record<string, MigrationValue>): Promise<MigrationRecord | null>;
  createRecord(objectType: string, fields: Record<string, MigrationValue>, template?: string): Promise<MigrationRecord>;
  updateRecord(objectType: string, recordId: string, fields: Record<string, MigrationValue>): Promise<MigrationRecord>;
}

export function reference(recordId: string): RecordReference {
  return { $ref: recordId };
}

export function isReference(value: MigrationValue): value is RecordReference {
  return typeof value === "object" && value !== null && "$ref" in value && typeof value.$ref === "string";
}
