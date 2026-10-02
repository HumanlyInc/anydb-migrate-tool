import { readFileSync } from "node:fs";
import { loadConfig } from "../config/loadConfig.js";
import { createSdkClient } from "../anydb/createSdkClient.js";
import type { MigrationRecord } from "../anydb/AnyDBClient.js";

export interface DedupePlan {
  /** Distinct key values that have more than one record. */
  duplicateKeys: number;
  keep: MigrationRecord[];
  remove: MigrationRecord[];
  /** Records with an empty key are never touched. */
  skippedBlank: number;
}

/** The first 8 hex characters of an AnyDB id are its creation time in seconds. */
function createdSeconds(id: string): number {
  const seconds = parseInt(id.slice(0, 8), 16);
  return Number.isNaN(seconds) ? Number.MAX_SAFE_INTEGER : seconds;
}

/**
 * Groups records by key and picks one to keep per group: a record that something else points at
 * (so no reference is left dangling), otherwise the earliest created. Pure, so it is easy to test.
 */
export function planDedupe(records: MigrationRecord[], key: string, referenced: Set<string> = new Set()): DedupePlan {
  const groups = new Map<string, MigrationRecord[]>();
  let skippedBlank = 0;
  for (const record of records) {
    const value = record.fields[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      skippedBlank += 1;
      continue;
    }
    const group = groups.get(String(value).trim()) ?? [];
    group.push(record);
    groups.set(String(value).trim(), group);
  }

  const keep: MigrationRecord[] = [];
  const remove: MigrationRecord[] = [];
  let duplicateKeys = 0;
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) =>
      Number(referenced.has(b.id)) - Number(referenced.has(a.id))
      || createdSeconds(a.id) - createdSeconds(b.id)
      || a.id.localeCompare(b.id));
    keep.push(ordered[0]!);
    if (ordered.length > 1) {
      duplicateKeys += 1;
      remove.push(...ordered.slice(1));
    }
  }
  return { duplicateKeys, keep, remove, skippedBlank };
}

export interface DedupeOptions {
  type: string;
  key: string;
  referencedBy?: string[];
  delete?: boolean;
  /** Delete exactly the ids in this file instead of listing and comparing records. */
  idsFile?: string;
}

/**
 * Finds records of one type that share the same key (such as a HubSpot ID) and, only with
 * --delete, removes every copy but one. Without --delete it changes nothing.
 */
export function parseIdList(text: string): string[] {
  const ids = [...new Set(text.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
  const bad = ids.filter((id) => !/^[0-9a-f]{24}$/.test(id));
  if (bad.length > 0) throw new Error(`Not a record id: ${bad.slice(0, 3).join(", ")}`);
  return ids;
}

/** Deletes the records listed in a file, with no listing or caching: fast, and the list can be reviewed first. */
async function deleteFromFile(configFile: string, options: DedupeOptions): Promise<void> {
  const ids = parseIdList(readFileSync(options.idsFile!, "utf8"));
  console.log(`${ids.length} ${options.type} record${ids.length === 1 ? "" : "s"} listed in ${options.idsFile}.`);
  if (!options.delete) {
    console.log("Dry run: nothing was deleted. Add --delete to remove them.");
    return;
  }
  const loaded = await loadConfig(configFile);
  const client = createSdkClient(loaded.plan);
  if (!client.deleteRecord) throw new Error("This client cannot delete records");
  let removed = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await client.deleteRecord(options.type, id);
      removed += 1;
    } catch (error) {
      failed += 1;
      console.error(`  failed to remove ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((removed + failed) % 25 === 0) console.log(`  ${removed + failed}/${ids.length}`);
  }
  console.log(`\nRemoved ${removed}, failed ${failed}.`);
}

export async function dedupeCommand(configFile: string, options: DedupeOptions): Promise<void> {
  if (options.idsFile) return deleteFromFile(configFile, options);
  const loaded = await loadConfig(configFile);
  const client = createSdkClient(loaded.plan);
  if (!client.listRecords) throw new Error("This client cannot list records");
  if (options.delete && !client.deleteRecord) throw new Error("This client cannot delete records");

  const referenced = new Set<string>();
  for (const other of options.referencedBy ?? []) {
    for (const record of await client.listRecords(other)) {
      for (const value of Object.values(record.fields)) {
        if (typeof value === "string" && /^[0-9a-f]{24}$/.test(value)) referenced.add(value);
      }
    }
  }

  const records = await client.listRecords(options.type);
  const plan = planDedupe(records, options.key, referenced);
  const host = (process.env.ANYDB_BASE_URL ?? "https://app.anydb.com/api").replace(/\/api\/?$/, "");
  const link = (id: string) => `${host}/${process.env.ANYDB_TEAM_ID}/${process.env.ANYDB_ADB_ID}/${id}`;

  console.log(`${options.type}: ${records.length} records, ${plan.keep.length} distinct "${options.key}" values, ${plan.skippedBlank} with an empty key (never touched).`);
  console.log(`${plan.duplicateKeys} values have more than one copy: ${plan.remove.length} extra record${plan.remove.length === 1 ? "" : "s"} to remove.`);
  if (referenced.size > 0) console.log(`Copies referenced by ${options.referencedBy!.join(", ")} are kept first; otherwise the earliest is kept.`);

  if (plan.remove.length === 0) return;
  if (!options.delete) {
    for (const record of plan.remove.slice(0, 10)) console.log(`  would remove ${record.name ?? record.id}  ${link(record.id)}`);
    if (plan.remove.length > 10) console.log(`  ...and ${plan.remove.length - 10} more`);
    console.log("\nDry run: nothing was deleted. Add --delete to remove these records.");
    return;
  }

  let removed = 0;
  let failed = 0;
  for (const record of plan.remove) {
    try {
      await client.deleteRecord!(options.type, record.id);
      removed += 1;
    } catch (error) {
      failed += 1;
      console.error(`  failed to remove ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((removed + failed) % 25 === 0) console.log(`  ${removed + failed}/${plan.remove.length}`);
  }
  console.log(`\nRemoved ${removed}, failed ${failed}. Run the command again without --delete to confirm nothing is left.`);
}
