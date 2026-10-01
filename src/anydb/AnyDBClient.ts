export interface RecordReference {
  $ref: string;
}

export type MigrationValue = unknown | RecordReference;

export interface MigrationRecord {
  id: string;
  name?: string;
  fields: Record<string, unknown>;
  /** Parent record ids this record is attached under, when known. */
  parents?: string[];
}

export interface AnyDBTypeField {
  name: string;
  position: string;
  valueType?: string;
  format?: string;
  /** The type locks this field, so the API refuses to write it. */
  locked?: boolean;
  /** The field is calculated by a formula and cannot be written. */
  computed?: boolean;
}

export interface AnyDBTypeSchema {
  name: string;
  id: string;
  fields: AnyDBTypeField[];
}

export interface MigrationAnyDBClient {
  listTypes(): Promise<string[]>;
  getType(objectType: string): Promise<AnyDBTypeSchema>;
  findRecord(
    objectType: string,
    match: Record<string, MigrationValue>,
    options?: { parent?: string },
  ): Promise<MigrationRecord | null>;
  createRecord(
    objectType: string,
    fields: Record<string, MigrationValue>,
    template?: string,
    parents?: string[],
  ): Promise<MigrationRecord>;
  updateRecord(
    objectType: string,
    recordId: string,
    fields: Record<string, MigrationValue>,
    addParents?: string[],
  ): Promise<MigrationRecord>;
  /** Every record of a type (used by the orphan report). */
  listRecords?(objectType: string): Promise<MigrationRecord[]>;
  /** Dry runs register would-be records so later steps can find them. */
  remember?(
    objectType: string,
    fields: Record<string, MigrationValue>,
    id: string,
    parents?: string[],
  ): Promise<void>;
}

export function reference(recordId: string): RecordReference {
  return { $ref: recordId };
}

export function isReference(value: MigrationValue): value is RecordReference {
  return typeof value === "object" && value !== null && "$ref" in value && typeof value.$ref === "string";
}
