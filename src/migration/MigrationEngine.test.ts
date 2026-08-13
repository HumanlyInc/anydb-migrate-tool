import assert from "node:assert/strict";
import test from "node:test";
import type {
  MigrationAnyDBClient,
  MigrationRecord,
  MigrationValue,
} from "../anydb/AnyDBClient.js";
import type { MigrationConfig } from "../types/config.js";
import { MigrationEngine } from "./MigrationEngine.js";

class FakeClient implements MigrationAnyDBClient {
  records = new Map<string, MigrationRecord[]>();
  creates: Array<{ type: string; fields: Record<string, MigrationValue> }> = [];
  updates: Array<{ type: string; id: string; fields: Record<string, MigrationValue> }> = [];

  async listTypes(): Promise<string[]> {
    return [...this.records.keys()];
  }

  async getType(type: string) {
    return { name: type, id: `${type}-type`, fields: [] };
  }

  async findRecord(type: string, match: Record<string, MigrationValue>): Promise<MigrationRecord | null> {
    return (this.records.get(type) ?? []).find((record) =>
      Object.entries(match).every(([field, value]) => JSON.stringify(record.fields[field]) === JSON.stringify(value)),
    ) ?? null;
  }

  async createRecord(type: string, fields: Record<string, MigrationValue>): Promise<MigrationRecord> {
    this.creates.push({ type, fields });
    const record = { id: `${type}-${this.creates.length}`, fields };
    this.records.set(type, [...(this.records.get(type) ?? []), record]);
    return record;
  }

  async updateRecord(type: string, id: string, fields: Record<string, MigrationValue>): Promise<MigrationRecord> {
    this.updates.push({ type, id, fields });
    return { id, fields };
  }
}

const row = [{ rowNumber: 2, values: { SKU: "A100", Name: "Widget", Location: "North", Quantity: 25 } }];

function config(objects: MigrationConfig["objects"]): MigrationConfig {
  return { name: "test", source: { file: "unused.csv" }, objects };
}

test("lookup mode finds an existing record", async () => {
  const client = new FakeClient();
  client.records.set("Location", [{ id: "loc-1", fields: { Name: "North" } }]);
  const result = await new MigrationEngine(client).run(config([
    { name: "location", type: "Location", mode: "lookup", match: { field: "Name", column: "Location" } },
  ]), row);
  assert.equal(result.summaries.location?.found, 1);
  assert.equal(result.failures.length, 0);
});

test("upsert takes the create path when no match exists", async () => {
  const client = new FakeClient();
  const result = await new MigrationEngine(client).run(config([
    { name: "item", type: "Item", mode: "upsert", match: { field: "SKU", column: "SKU" }, fields: { SKU: "SKU" } },
  ]), row);
  assert.equal(result.summaries.item?.created, 1);
  assert.equal(client.creates.length, 1);
});

test("upsert takes the update path when a match exists", async () => {
  const client = new FakeClient();
  client.records.set("Item", [{ id: "item-1", fields: { SKU: "A100" } }]);
  const result = await new MigrationEngine(client).run(config([
    { name: "item", type: "Item", mode: "upsert", match: { field: "SKU", column: "SKU" }, fields: { "Item Name": "Name" } },
  ]), row);
  assert.equal(result.summaries.item?.updated, 1);
  assert.deepEqual(client.updates[0], { type: "Item", id: "item-1", fields: { "Item Name": "Widget" } });
});

test("later objects receive references to earlier objects", async () => {
  const client = new FakeClient();
  await new MigrationEngine(client).run(config([
    { name: "item", type: "Item", mode: "create", fields: { SKU: "SKU" } },
    { name: "inventory", type: "Inventory", mode: "create", references: { "Item Ref": { object: "item" } } },
  ]), row);
  assert.deepEqual(client.creates[1]?.fields, { "Item Ref": { $ref: "Item-1" } });
});

test("dry run performs lookups and makes no writes", async () => {
  const client = new FakeClient();
  client.records.set("Item", [{ id: "item-1", fields: { SKU: "A100" } }]);
  const result = await new MigrationEngine(client).run(config([
    { name: "item", type: "Item", mode: "upsert", match: { field: "SKU", column: "SKU" }, fields: { SKU: "SKU" } },
    { name: "newObject", type: "Other", mode: "create", references: { Parent: { object: "item" } } },
  ]), row, { dryRun: true });
  assert.equal(result.summaries.item?.updated, 1);
  assert.equal(result.summaries.newObject?.created, 1);
  assert.equal(client.creates.length, 0);
  assert.equal(client.updates.length, 0);
});

test("reports progress periodically and at completion", async () => {
  const client = new FakeClient();
  const rows = Array.from({ length: 12 }, (_, index) => ({
    rowNumber: index + 2,
    values: { SKU: `SKU-${index}` },
  }));
  const progress: Array<[number, number, number]> = [];
  await new MigrationEngine(client).run(config([
    { name: "item", type: "Item", mode: "create", fields: { SKU: "SKU" } },
  ]), rows, {
    progressEvery: 5,
    onProgress: (completed, total, failed) => progress.push([completed, total, failed]),
  });
  assert.deepEqual(progress, [[5, 12, 0], [10, 12, 0], [12, 12, 0]]);
});
