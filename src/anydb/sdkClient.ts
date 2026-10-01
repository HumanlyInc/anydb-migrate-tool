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
  // Match keys often arrive as text (CSV) while the stored cell is numeric, so compare loosely.
  if (typeof actual === "number" && typeof expected === "string") return String(actual) === expected.trim();
  if (typeof expected === "number" && typeof actual === "string") return actual.trim() === String(expected);
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

/** Parent ids as the server reports them on a record's meta. */
function parentsOf(record: ADORecord): string[] {
  const meta = record.meta as unknown as { attachedTo?: unknown; parent?: unknown };
  const raw = meta.attachedTo ?? meta.parent ?? [];
  return (Array.isArray(raw) ? raw : [raw]).map((item) => String(item)).filter(Boolean);
}

function asMigrationRecord(record: ADORecord): MigrationRecord {
  return { id: record.meta.adoid, name: record.meta.name, fields: fieldMap(record), parents: parentsOf(record) };
}

function valueType(value: unknown): ADOCellValueType {
  if (typeof value === "number") return ADOCellValueType.NUMBER;
  if (typeof value === "boolean") return ADOCellValueType.BOOLEAN;
  if (Array.isArray(value)) return ADOCellValueType.ARRAY;
  if (value !== null && typeof value === "object") return ADOCellValueType.OBJECT;
  return ADOCellValueType.STRING;
}

/** Makes a source value fit the type of the field it is written to. */
function coerceForCell(cell: ADOCell, field: string, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  switch (cell.type) {
    case ADOCellValueType.NUMBER: {
      if (typeof value === "number") return value;
      const parsed = Number(String(value).replace(/[, $]/g, ""));
      if (!Number.isFinite(parsed)) throw new Error(`Field "${field}" expects a number, got "${String(value)}"`);
      return parsed;
    }
    case ADOCellValueType.BOOLEAN: {
      if (typeof value === "boolean") return value;
      const text = String(value).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(text)) return true;
      if (["false", "no", "n", "0"].includes(text)) return false;
      throw new Error(`Field "${field}" expects true or false, got "${String(value)}"`);
    }
    case ADOCellValueType.ARRAY:
      return Array.isArray(value) ? value : [value];
    case ADOCellValueType.STRING:
      return typeof value === "string" ? value : String(value);
    default:
      return value;
  }
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
  onServerError?: (status: number | string, waitMs: number, attempt: number) => void;
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
      onServerError: options.onServerError,
    });
  }

  /** Reads and updates are safe to repeat after a gateway error; creates are not (see RequestLimiter). */
  private request<T>(operation: () => Promise<T>, safeToRepeat = true): Promise<T> {
    return this.limiter.schedule(operation, safeToRepeat);
  }

  private get ids(): { teamid: string; adbid: string } {
    return { teamid: this.options.teamId, adbid: this.options.databaseId };
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
          locked: cell.props?.CELL_LOCKED?.value === true,
          computed: Boolean(cell.expr) && cell.type !== ADOCellValueType.REF,
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

  async findRecord(
    objectType: string,
    match: Record<string, MigrationValue>,
    options: { parent?: string } = {},
  ): Promise<MigrationRecord | null> {
    const type = await this.loadType(objectType);
    const found = type.records.find((record) => {
      if (options.parent && !parentsOf(record).includes(options.parent)) return false;
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
        : {
            ...existing,
            pos: existing.pos,
            key: field,
            type: existing.type ?? valueType(value),
            value: coerceForCell(existing, field, value),
          };
    }
    return content;
  }

  private replaceInCache(type: CachedType, updated: ADORecord): void {
    const index = type.records.findIndex((candidate) => candidate.meta.adoid === updated.meta.adoid);
    if (index >= 0) type.records[index] = updated;
    else type.records.push(updated);
  }

  /**
   * Sets the complete parent list. AnyDB's `attach` on update replaces the parents and takes
   * an array of ids (the SDK types it as a string, but the API rejects a comma-joined string),
   * so the full desired list is sent and the result is read back and checked.
   */
  private async setParents(type: CachedType, recordId: string, parents: string[]): Promise<ADORecord> {
    await this.request(() => this.sdk.updateRecord({
      meta: { adoid: recordId, ...this.ids, attach: parents as unknown as string },
    }));
    const reread = await this.request(() => this.sdk.getRecord(this.options.teamId, this.options.databaseId, recordId));
    const actual = parentsOf(reread);
    const missing = parents.filter((id) => !actual.includes(id));
    if (missing.length > 0) {
      throw new Error(
        `AnyDB did not attach record ${recordId} under ${missing.join(", ")} (parents are now: ${actual.join(", ") || "none"})`,
      );
    }
    this.replaceInCache(type, reread);
    return reread;
  }

  async createRecord(
    objectType: string,
    fields: Record<string, MigrationValue>,
    template?: string,
    parents: string[] = [],
  ): Promise<MigrationRecord> {
    const type = await this.loadType(objectType);
    const firstValue = Object.values(fields).find((value) => !isReference(value) && value !== null && value !== undefined);
    // One call creates the record with its values, so a failure cannot leave a blank record behind.
    const updated = await this.request(() => this.sdk.createRecord({
      ...this.ids,
      name: firstValue === undefined ? objectType : String(firstValue),
      ...(template ? { template } : { templatename: objectType }),
      ...(parents.length > 0 ? { attach: (parents.length === 1 ? parents[0] : parents) as string } : {}),
      ...(Object.keys(fields).length > 0 ? { content: this.buildContent(type, { meta: { adoid: "", name: "", ...this.ids } } as unknown as ADORecord, fields) } : {}),
    }), false);
    this.replaceInCache(type, updated);
    // The update response may omit parents, so confirm they were attached and report a clear error if not.
    if (parents.length > 1) {
      const reread = await this.request(() => this.sdk.getRecord(this.options.teamId, this.options.databaseId, updated.meta.adoid));
      const actual = parentsOf(reread);
      const missing = parents.filter((id) => !actual.includes(id));
      if (missing.length > 0) {
        throw new Error(`AnyDB created record ${updated.meta.adoid} but did not attach it under ${missing.join(", ")} (parents: ${actual.join(", ") || "none"})`);
      }
      this.replaceInCache(type, reread);
      return asMigrationRecord(reread);
    }
    return asMigrationRecord(updated);
  }

  async updateRecord(
    objectType: string,
    recordId: string,
    fields: Record<string, MigrationValue>,
    addParents: string[] = [],
  ): Promise<MigrationRecord> {
    const type = await this.loadType(objectType);
    const record = type.records.find((candidate) => candidate.meta.adoid === recordId)
      ?? await this.request(() => this.sdk.getRecord(this.options.teamId, this.options.databaseId, recordId));
    let latest: ADORecord = record;
    if (Object.keys(fields).length > 0) {
      latest = await this.request(() => this.sdk.updateRecord({
        meta: { adoid: recordId, ...this.ids },
        content: this.buildContent(type, record, fields),
      }));
      this.replaceInCache(type, latest);
    }
    if (addParents.length > 0) {
      latest = await this.setParents(type, recordId, [...new Set([...parentsOf(record), ...addParents])]);
    }
    return asMigrationRecord(latest);
  }

  async listRecords(objectType: string): Promise<MigrationRecord[]> {
    const type = await this.loadType(objectType);
    return type.records.map(asMigrationRecord);
  }

  async remember(
    objectType: string,
    fields: Record<string, MigrationValue>,
    id: string,
    parents: string[] = [],
  ): Promise<void> {
    const type = await this.loadType(objectType);
    const content = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {
      pos: key,
      key,
      type: isReference(value) ? ADOCellValueType.REF : valueType(value),
      format: isReference(value) ? ADOCellFormat.REF : ADOCellFormat.GENERAL,
      value: isReference(value) ? value.$ref : value,
    }]));
    type.records.push({
      meta: { adoid: id, name: id, attachedTo: parents, ...this.ids },
      content,
    } as unknown as ADORecord);
  }
}
