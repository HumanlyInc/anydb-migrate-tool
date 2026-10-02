import { loadConfig } from "../config/loadConfig.js";
import { createSdkClient } from "../anydb/createSdkClient.js";
import type { ObjectConfig } from "../types/config.js";

function singleMatchField(object: ObjectConfig): string | undefined {
  return object.match && "field" in object.match ? object.match.field : undefined;
}

/**
 * A create that fails part-way can leave a blank record behind. Every record the plan creates
 * carries its match field (such as the HubSpot ID), so a record of a planned type whose match
 * field is empty is a leftover. This lists them; it never changes or deletes anything.
 */
export async function orphansCommand(configFile: string): Promise<void> {
  const loaded = await loadConfig(configFile);
  const client = createSdkClient(loaded.plan);
  if (!client.listRecords) throw new Error("This client cannot list records");

  const targets = new Map<string, string>();
  for (const step of loaded.steps) {
    for (const object of step.config.objects) {
      const field = singleMatchField(object);
      if (field && object.mode !== "lookup" && !targets.has(object.type)) targets.set(object.type, field);
    }
  }

  const host = (process.env.ANYDB_BASE_URL ?? "https://app.anydb.com/api").replace(/\/api\/?$/, "");
  let total = 0;
  for (const [type, field] of targets) {
    const records = await client.listRecords(type);
    const blank = records.filter((record) => {
      const value = record.fields[field];
      return value === undefined || value === null || String(value).trim() === "";
    });
    console.log(`${type}: ${blank.length} blank of ${records.length} (match field "${field}")`);
    for (const record of blank) {
      const failedCreate = /^\d+$/.test(record.name ?? "") || (record.name ?? "").startsWith("nohs:");
      console.log(`  ${record.name ?? "(unnamed)"}${failedCreate ? "  <- named by its key: almost certainly a failed create" : ""}  ${host}/${process.env.ANYDB_TEAM_ID}/${process.env.ANYDB_ADB_ID}/${record.id}`);
    }
    total += blank.length;
  }
  console.log(total === 0 ? "\nNo leftover records found." : `\n${total} leftover record${total === 1 ? "" : "s"}. Review and delete them in AnyDB; this command changes nothing.`);
  console.log("Note: records created by hand (not by this plan) also appear here if their match field is empty.");
}
