import type { MigrationAnyDBClient, MigrationRecord, MigrationValue } from "../anydb/AnyDBClient.js";
import type { MigrationConfig, ObjectConfig } from "../types/config.js";
import type { SourceRow } from "../source/SourceReader.js";
import { buildValues, isEmptyValue, type ResolvedObject } from "./mapping.js";
import { buildMatchSpec } from "./matching.js";
import { changedFields } from "./compare.js";

export interface ObjectSummary {
  created: number;
  updated: number;
  unchanged: number;
  found: number;
  missing: number;
  skipped: number;
}

export interface MigrationFailure {
  rowNumber: number;
  objectName: string;
  objectType: string;
  reason: string;
  cause?: unknown;
}

export interface MigrationResult {
  migrationName: string;
  rowsProcessed: number;
  summaries: Record<string, ObjectSummary>;
  failures: MigrationFailure[];
}

export interface RunOptions {
  dryRun?: boolean;
  limit?: number;
  failFast?: boolean;
  verbose?: boolean;
  onEvent?: (message: string) => void;
  onProgress?: (completedRows: number, totalRows: number, failedRows: number) => void;
  progressEvery?: number;
}

function emptySummary(): ObjectSummary {
  return { created: 0, updated: 0, unchanged: 0, found: 0, missing: 0, skipped: 0 };
}

/** Fields with no value are left alone, so a blank source cell never erases data. */
function withoutEmpty(values: Record<string, MigrationValue>): Record<string, MigrationValue> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => !isEmptyValue(value)));
}

function parentIdsFor(object: ObjectConfig, resolved: Map<string, ResolvedObject>): string[] {
  const ids: string[] = [];
  for (const parent of object.parents ?? []) {
    const target = resolved.get(parent.object);
    if (!target) throw new Error(`Parent object "${parent.object}" has not been resolved for this row`);
    if (target.status === "missing" || target.status === "skipped") continue;
    if (!ids.includes(target.id)) ids.push(target.id);
  }
  return ids;
}

export class MigrationEngine {
  private dryRunCounter = 0;

  constructor(private readonly client: MigrationAnyDBClient) {}

  async run(
    config: Pick<MigrationConfig, "name" | "objects">,
    rows: SourceRow[],
    options: RunOptions = {},
  ): Promise<MigrationResult> {
    const selectedRows = options.limit === undefined ? rows : rows.slice(0, options.limit);
    const summaries = Object.fromEntries(config.objects.map((object) => [object.name, emptySummary()]));
    const failures: MigrationFailure[] = [];
    const progressEvery = options.progressEvery ?? 10;

    for (const [rowIndex, sourceRow] of selectedRows.entries()) {
      const resolved = new Map<string, ResolvedObject>();
      for (const object of config.objects) {
        const summary = summaries[object.name]!;
        try {
          if (object.skipWhenEmpty?.some((column) => isEmptyValue(sourceRow.values[column]))) {
            summary.skipped += 1;
            resolved.set(object.name, { id: "", status: "skipped" });
            options.onEvent?.(`Row ${sourceRow.rowNumber} / ${object.name}: skipped (empty source column)`);
            continue;
          }

          const fields = withoutEmpty(buildValues(object.fields, sourceRow.values, resolved));
          for (const [field, ref] of Object.entries(object.references ?? {})) {
            const value = buildValues({ [field]: ref }, sourceRow.values, resolved)[field];
            if (!isEmptyValue(value)) fields[field] = value;
          }
          const parentIds = parentIdsFor(object, resolved);

          let existing: MigrationRecord | null = null;
          let matchValues: Record<string, MigrationValue> = {};
          if (object.mode !== "create") {
            let matchParent: string | undefined;
            try {
              const spec = buildMatchSpec(object.match!, sourceRow.values, resolved);
              matchValues = spec.values;
              matchParent = spec.parent;
            } catch (cause) {
              if (!object.optional) throw cause;
              summary.skipped += 1;
              resolved.set(object.name, { id: "", status: "skipped" });
              options.onEvent?.(`Row ${sourceRow.rowNumber} / ${object.name}: skipped (empty match value)`);
              continue;
            }
            existing = await this.client.findRecord(object.type, matchValues, { parent: matchParent });
          }

          let result: ResolvedObject;
          if (object.mode === "lookup") {
            if (!existing) {
              summary.missing += 1;
              if (object.optional) {
                resolved.set(object.name, { id: "", status: "missing" });
                options.onEvent?.(`Row ${sourceRow.rowNumber} / ${object.name}: not found (optional)`);
                continue;
              }
              throw new Error("No matching record found");
            }
            summary.found += 1;
            result = { id: existing.id, status: "found" };
          } else if (existing) {
            const changed = changedFields(existing.fields, fields);
            const missingParents = parentIds.filter((id) => !(existing!.parents ?? []).includes(id));
            if (Object.keys(changed).length === 0 && missingParents.length === 0) {
              summary.unchanged += 1;
              result = { id: existing.id, status: "unchanged" };
            } else {
              if (!options.dryRun) await this.client.updateRecord(object.type, existing.id, changed, missingParents);
              summary.updated += 1;
              result = { id: existing.id, status: "updated" };
              const details = [...Object.keys(changed), ...(missingParents.length > 0 ? ["parents"] : [])].join(", ");
              options.onEvent?.(`Row ${sourceRow.rowNumber} / ${object.name}: changes ${details}`);
            }
          } else {
            // A new record always carries the values it was matched on.
            const createFields = { ...matchValues, ...fields };
            let id: string;
            if (options.dryRun) {
              this.dryRunCounter += 1;
              id = `dry-run:${this.dryRunCounter}:${object.name}`;
              await this.client.remember?.(object.type, createFields, id, parentIds);
            } else {
              id = (await this.client.createRecord(object.type, createFields, object.template, parentIds)).id;
            }
            summary.created += 1;
            result = { id, status: "created" };
          }

          resolved.set(object.name, result);
          options.onEvent?.(`Row ${sourceRow.rowNumber} / ${object.name}: ${options.dryRun ? "would be " : ""}${result.status}`);
        } catch (cause) {
          const failure: MigrationFailure = {
            rowNumber: sourceRow.rowNumber,
            objectName: object.name,
            objectType: object.type,
            reason: cause instanceof Error ? cause.message : String(cause),
            cause,
          };
          failures.push(failure);
          options.onEvent?.(`Row ${failure.rowNumber} / ${failure.objectName} / ${failure.objectType}: ${failure.reason}`);
          if (options.failFast) {
            const completedRows = rowIndex + 1;
            options.onProgress?.(completedRows, selectedRows.length, failures.length);
            return { migrationName: config.name, rowsProcessed: completedRows, summaries, failures };
          }
          break;
        }
      }
      const completedRows = rowIndex + 1;
      if (completedRows % progressEvery === 0 || completedRows === selectedRows.length) {
        options.onProgress?.(completedRows, selectedRows.length, failures.length);
      }
    }

    return { migrationName: config.name, rowsProcessed: selectedRows.length, summaries, failures };
  }
}
