import type { MigrationAnyDBClient } from "../anydb/AnyDBClient.js";
import type { MigrationConfig } from "../types/config.js";
import type { SourceRow } from "../source/SourceReader.js";
import { buildValues, type ResolvedObject } from "./mapping.js";
import { buildMatch } from "./matching.js";

export interface ObjectSummary {
  created: number;
  updated: number;
  found: number;
  missing: number;
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
  return { created: 0, updated: 0, found: 0, missing: 0 };
}

export class MigrationEngine {
  constructor(private readonly client: MigrationAnyDBClient) {}

  async run(config: MigrationConfig, rows: SourceRow[], options: RunOptions = {}): Promise<MigrationResult> {
    const selectedRows = options.limit === undefined ? rows : rows.slice(0, options.limit);
    const summaries = Object.fromEntries(config.objects.map((object) => [object.name, emptySummary()]));
    const failures: MigrationFailure[] = [];
    const progressEvery = options.progressEvery ?? 10;

    for (const [rowIndex, sourceRow] of selectedRows.entries()) {
      const resolved = new Map<string, ResolvedObject>();
      for (const object of config.objects) {
        try {
          const fields = buildValues(object.fields, sourceRow.values, resolved);
          for (const [field, ref] of Object.entries(object.references ?? {})) {
            fields[field] = buildValues({ [field]: ref }, sourceRow.values, resolved)[field];
          }

          let existing = null;
          if (object.mode !== "create") {
            existing = await this.client.findRecord(object.type, buildMatch(object.match!, sourceRow.values, resolved));
          }

          let result: ResolvedObject;
          if (object.mode === "lookup") {
            if (!existing) {
              summaries[object.name]!.missing += 1;
              throw new Error("No matching record found");
            }
            summaries[object.name]!.found += 1;
            result = { id: existing.id, status: "found" };
          } else if (existing) {
            const record = options.dryRun
              ? existing
              : await this.client.updateRecord(object.type, existing.id, fields);
            summaries[object.name]!.updated += 1;
            result = { id: record.id, status: "updated" };
          } else {
            const record = options.dryRun
              ? { id: `dry-run:${sourceRow.rowNumber}:${object.name}`, fields }
              : await this.client.createRecord(object.type, fields, object.template);
            summaries[object.name]!.created += 1;
            result = { id: record.id, status: "created" };
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
