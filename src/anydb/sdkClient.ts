import {
  ADOCellFormat,
  ADOCellValueType,
  AnyDBClient as SdkClient,
  type ADOCell,
  type ADOCellUpdate,
  type ADORecord,
} from "anydb-api-sdk-ts";
import {
  isReference,
  type AnyDBTypeSchema,
  type MigrationAnyDBClient,
  type MigrationRecord,
  type MigrationValue,
} from "./AnyDBClient.js";
import { RequestLimiter } from "./RequestLimiter.js";

interface CachedType {
  records: ADORecord[];
  definition: ADORecord;
}

function referenceId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const expression = /^O@([^!]+)!/.exec(value);
    return expression?.[1] ?? value;
  }
  if (!value || typeof value !== "object") return undefined;
  const ref = value as { adoid?: string; id?: string; value?: unknown; meta?: { adoid?: string } };
  return ref.adoid ?? ref.id ?? ref.meta?.adoid ?? referenceId(ref.value);
}

function valuesEqual(actual: unknown, expected: MigrationValue): boolean {
  if (isReference(expected)) return referenceId(actual) === expected.$ref;
  if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime();
  return actual === expected;
}

function fieldMap(record: ADORecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.values(record.content ?? {}).filter((cell) => cell.key).map((cell) => [
      cell.key!,
      cell.type === ADOCellValueType.REF
        ? referenceId(cell.value) ?? referenceId(cell.expr) ?? cell.value
        : cell.value,
    ]),
  );
}

function asMigrationRecord(record: ADORecord): MigrationRecord {
  return { id: record.meta.adoid, fields: fieldMap(record) };
}

function valueType(value: unknown): ADOCellValueType {
  if (typeof value === "number") return ADOCellValueType.NUMBER;
  if (typeof value === "boolean") return ADOCellValueType.BOOLEAN;
  if (Array.isArray(value)) return ADOCellValueType.ARRAY;
  if (value !== null && typeof value === "object") return ADOCellValueType.OBJECT;
  return ADOCellValueType.STRING;
}

export interface SdkMigrationClientOptions {
  apiKey: string;
  userEmail: string;
  teamId: string;
  databaseId: string;
  baseUrl?: string;
  debug?: boolean;
  requestsPerMinute?: number;
  onRateLimit?: (waitMs: number, attempt: number) => void;
  onCacheProgress?: (event: CacheProgressEvent) => void;
}

export interface CacheProgressEvent {
  objectType: string;
  phase: "listing" | "hydrating" | "ready";
  loaded: number;
  total?: number;
}

export class SdkMigrationClient implements MigrationAnyDBClient {
  private readonly sdk: SdkClient;
  private readonly limiter: RequestLimiter;
  private readonly cache = new Map<string, Promise<CachedType>>();
  private readonly definitions = new Map<string, Promise<ADORecord>>();
  private typeNames?: Promise<string[]>;

  constructor(private readonly options: SdkMigrationClientOptions) {
    this.sdk = new SdkClient({
      apiKey: options.apiKey,
      userEmail: options.userEmail,
      baseURL: options.baseUrl,
      debug: options.debug,
    });
    this.limiter = new RequestLimiter({
      requestsPerMinute: options.requestsPerMinute ?? 100,
      onRateLimit: options.onRateLimit,
    });
  }

  private request<T>(operation: () => Promise<T>): Promise<T> {
    return this.limiter.schedule(operation);
  }

  async listTypes(): Promise<string[]> {
    this.typeNames ??= this.request(() => this.sdk.listTypes({
      teamid: this.options.teamId,
      adbid: this.options.databaseId,
    })).then((types) => types.map((type) => type.name));
    return this.typeNames;
  }

  async getType(objectType: string): Promise<AnyDBTypeSchema> {
    const definition = await this.loadDefinition(objectType);
    return {
      name: definition.meta.name,
      id: definition.meta.adoid,
      fields: Object.values(definition.content ?? {})
        .filter((cell): cell is ADOCell & { key: string } => Boolean(cell.key))
        .map((cell) => ({
          name: cell.key,
          position: cell.pos,
          valueType: cell.type,
          format: cell.format,
        })),
    };
  }

  private loadDefinition(objectType: string): Promise<ADORecord> {
    const current = this.definitions.get(objectType);
    if (current) return current;
    const loading = this.request(() => this.sdk.getType({
      teamid: this.options.teamId,
      adbid: this.options.databaseId,
      typeName: objectType,
    }));
    this.definitions.set(objectType, loading);
    return loading;
  }

  private loadType(objectType: string): Promise<CachedType> {
    const current = this.cache.get(objectType);
    if (current) return current;
    const loading = (async () => {
      const definition = await this.loadDefinition(objectType);
      const metas: ADORecord["meta"][] = [];
      this.options.onCacheProgress?.({ objectType, phase: "listing", loaded: 0 });
      let marker: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await this.request(() => this.sdk.listRecords(
          this.options.teamId,
          this.options.databaseId,
          undefined,
          undefined,
          objectType,
          "100",
          marker,
        ));
        metas.push(...page.items);
        this.options.onCacheProgress?.({ objectType, phase: "listing", loaded: metas.length });
        marker = page.lastmarker;
        if (marker && seen.has(marker)) throw new Error(`Pagination marker repeated while loading ${objectType}`);
        if (marker) seen.add(marker);
      } while (marker);
      const records: ADORecord[] = [];
      if (metas.length === 0) {
        this.options.onCacheProgress?.({ objectType, phase: "ready", loaded: 0, total: 0 });
      }
      for (const [index, meta] of metas.entries()) {
        records.push(await this.request(() => this.sdk.getRecord(
          this.options.teamId,
          this.options.databaseId,
          meta.adoid,
        )));
        const loaded = index + 1;
        if (loaded % 10 === 0 || loaded === metas.length) {
          this.options.onCacheProgress?.({
            objectType,
            phase: loaded === metas.length ? "ready" : "hydrating",
            loaded,
            total: metas.length,
          });
        }
      }
      return { records, definition };
    })();
    this.cache.set(objectType, loading);
    return loading;
  }

  async findRecord(objectType: string, match: Record<string, MigrationValue>): Promise<MigrationRecord | null> {
    const type = await this.loadType(objectType);
    const found = type.records.find((record) => {
      const fields = fieldMap(record);
      return Object.entries(match).every(([field, value]) => valuesEqual(fields[field], value));
    });
    return found ? asMigrationRecord(found) : null;
  }

  private findCell(type: CachedType, record: ADORecord, field: string): ADOCell | undefined {
    return Object.values(record.content ?? {}).find((cell) => cell.key === field)
      ?? Object.values(type.definition.content ?? {}).find((cell) => cell.key === field)
      ?? type.records.flatMap((candidate) => Object.values(candidate.content ?? {})).find((cell) => cell.key === field);
  }

  private buildContent(type: CachedType, record: ADORecord, fields: Record<string, MigrationValue>): Record<string, ADOCellUpdate> {
    const content: Record<string, ADOCellUpdate> = {};
    for (const [field, value] of Object.entries(fields)) {
      const existing = this.findCell(type, record, field);
      if (!existing) throw new Error(`AnyDB template does not contain field "${field}"`);
      content[existing.pos] = isReference(value)
        ? {
            ...existing,
            pos: existing.pos,
            key: field,
            type: ADOCellValueType.REF,
            format: ADOCellFormat.REF,
            value: "",
            expr: `O@${value.$ref}!F@GO!M@MINI`,
          }
        : { ...existing, pos: existing.pos, key: field, type: existing.type ?? valueType(value), value };
    }
    return content;
  }

  async createRecord(objectType: string, fields: Record<string, MigrationValue>, template?: string): Promise<MigrationRecord> {
    const type = await this.loadType(objectType);
    const firstValue = Object.values(fields).find((value) => !isReference(value) && value !== null && value !== undefined);
    const created = await this.request(() => this.sdk.createRecord({
      teamid: this.options.teamId,
      adbid: this.options.databaseId,
      name: firstValue === undefined ? objectType : String(firstValue),
      ...(template ? { template } : { templatename: objectType }),
    }));
    const hydrated = created.content
      ? created
      : await this.request(() => this.sdk.getRecord(this.options.teamId, this.options.databaseId, created.meta.adoid));
    const updated = await this.request(() => this.sdk.updateRecord({
      meta: { adoid: hydrated.meta.adoid, adbid: this.options.databaseId, teamid: this.options.teamId },
      content: this.buildContent(type, hydrated, fields),
    }));
    type.records.push(updated);
    return asMigrationRecord(updated);
  }

  async updateRecord(objectType: string, recordId: string, fields: Record<string, MigrationValue>): Promise<MigrationRecord> {
    const type = await this.loadType(objectType);
    const record = type.records.find((candidate) => candidate.meta.adoid === recordId)
      ?? await this.request(() => this.sdk.getRecord(this.options.teamId, this.options.databaseId, recordId));
    const updated = await this.request(() => this.sdk.updateRecord({
      meta: { adoid: recordId, adbid: this.options.databaseId, teamid: this.options.teamId },
      content: this.buildContent(type, record, fields),
    }));
    const index = type.records.findIndex((candidate) => candidate.meta.adoid === recordId);
    if (index >= 0) type.records[index] = updated;
    else type.records.push(updated);
    return asMigrationRecord(updated);
  }
}
