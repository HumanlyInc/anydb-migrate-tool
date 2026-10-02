import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ADORecord } from "anydb-api-sdk-ts";

export interface SnapshotEntry {
  /** The version stamp the record had in the listing when it was fetched. */
  stamp: string;
  record: ADORecord;
}

/**
 * A record's version stamp from the (cheap) listing. Empty means the listing gave no usable stamp,
 * and such a record is always fetched again rather than trusted.
 */
export function stampOf(meta: ADORecord["meta"]): string {
  const { version, updated } = meta as unknown as { version?: unknown; updated?: unknown };
  if (version === undefined && updated === undefined) return "";
  return `${version ?? ""}|${updated ?? ""}`;
}

export interface ReusePlan {
  /** Records whose stamp is unchanged, so the saved copy is still current. */
  reuse: Map<string, ADORecord>;
  /** Records that are new or changed and must be fetched. Anything saved but no longer listed is dropped. */
  fetch: ADORecord["meta"][];
}

export function planReuse(listed: ADORecord["meta"][], snapshot: SnapshotEntry[]): ReusePlan {
  const saved = new Map(snapshot.map((entry) => [entry.record.meta.adoid, entry]));
  const reuse = new Map<string, ADORecord>();
  const fetch: ADORecord["meta"][] = [];
  for (const meta of listed) {
    const stamp = stampOf(meta);
    const entry = saved.get(meta.adoid);
    if (entry && stamp !== "" && entry.stamp === stamp) reuse.set(meta.adoid, entry.record);
    else fetch.push(meta);
  }
  return { reuse, fetch };
}

export function snapshotFile(directory: string, teamId: string, databaseId: string, objectType: string): string {
  return join(directory, `${teamId}-${databaseId}`, `${objectType.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
}

/** A missing or unreadable snapshot is not an error: the cache is simply loaded from the server. */
export function readSnapshot(file: string): SnapshotEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: SnapshotEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries.filter((entry) => entry?.record?.meta?.adoid) : [];
  } catch {
    return [];
  }
}

export function writeSnapshot(file: string, entries: SnapshotEntry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ savedAt: new Date().toISOString(), entries }), "utf8");
  renameSync(temporary, file);
}
