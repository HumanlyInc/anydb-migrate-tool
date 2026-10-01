import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationAnyDBClient, MigrationRecord, MigrationValue } from "../anydb/AnyDBClient.js";
import type { MigrationConfig, ObjectConfig } from "../types/config.js";
import { MigrationEngine } from "./MigrationEngine.js";
import { changedFields, sameValue } from "./compare.js";

class FakeClient implements MigrationAnyDBClient {
  records = new Map<string, MigrationRecord[]>();
  creates: Array<{ type: string; fields: Record<string, MigrationValue>; parents?: string[] }> = [];
  updates: Array<{ type: string; id: string; fields: Record<string, MigrationValue>; addParents?: string[] }> = [];
  remembered: string[] = [];

  async listTypes(): Promise<string[]> { return [...this.records.keys()]; }
  async getType(type: string) { return { name: type, id: `${type}-type`, fields: [] }; }

  async findRecord(type: string, match: Record<string, MigrationValue>, options: { parent?: string } = {}): Promise<MigrationRecord | null> {
    return (this.records.get(type) ?? []).find((record) =>
      (!options.parent || (record.parents ?? []).includes(options.parent)) &&
      Object.entries(match).every(([field, value]) => sameValue(record.fields[field], value)),
    ) ?? null;
  }

  async createRecord(type: string, fields: Record<string, MigrationValue>, _template?: string, parents?: string[]) {
    this.creates.push({ type, fields, parents });
    const record: MigrationRecord = { id: `${type}-${this.creates.length}`, fields, parents: parents ?? [] };
    this.records.set(type, [...(this.records.get(type) ?? []), record]);
    return record;
  }

  async updateRecord(type: string, id: string, fields: Record<string, MigrationValue>, addParents?: string[]) {
    this.updates.push({ type, id, fields, addParents });
    return { id, fields };
  }

  async remember(type: string, fields: Record<string, MigrationValue>, id: string, parents?: string[]) {
    this.remembered.push(id);
    this.records.set(type, [...(this.records.get(type) ?? []), { id, fields, parents: parents ?? [] }]);
  }
}

const config = (objects: ObjectConfig[]): Pick<MigrationConfig, "name" | "objects"> => ({ name: "test", objects });

const partner: ObjectConfig = {
  name: "partner", type: "Partner", mode: "upsert",
  match: { field: "HubSpot ID", column: "partner_id" },
  fields: { "Partner Name": "partner_name" },
};
const contact: ObjectConfig = {
  name: "contact", type: "Contact", mode: "upsert",
  match: { field: "HubSpot ID", column: "contact_id" },
  fields: { Email: "email" },
  parents: [{ object: "partner" }],
};

test("parents are passed on create and the match value is stored on the new record", async () => {
  const client = new FakeClient();
  await new MigrationEngine(client).run(config([partner, contact]), [
    { rowNumber: 2, values: { partner_id: "p1", partner_name: "Acme", contact_id: "c1", email: "a@acme.com" } },
  ]);
  assert.deepEqual(client.creates[0]?.fields, { "HubSpot ID": "p1", "Partner Name": "Acme" });
  assert.deepEqual(client.creates[1]?.parents, ["Partner-1"]);
  assert.equal(client.creates[1]?.fields["HubSpot ID"], "c1");
});

test("a second run changes nothing: records are reported unchanged", async () => {
  const client = new FakeClient();
  const rows = [{ rowNumber: 2, values: { partner_id: "p1", partner_name: "Acme", contact_id: "c1", email: "a@acme.com" } }];
  const engine = new MigrationEngine(client);
  await engine.run(config([partner, contact]), rows);
  const again = await engine.run(config([partner, contact]), rows);
  assert.equal(again.summaries.partner?.unchanged, 1);
  assert.equal(again.summaries.contact?.unchanged, 1);
  assert.equal(client.creates.length, 2);
  assert.equal(client.updates.length, 0);
});

test("only changed fields are written, and missing parents are added", async () => {
  const client = new FakeClient();
  client.records.set("Partner", [{ id: "p-1", fields: { "HubSpot ID": "p1", "Partner Name": "Acme" } }]);
  client.records.set("Contact", [{ id: "c-1", fields: { "HubSpot ID": "c1", Email: "old@acme.com" }, parents: [] }]);
  await new MigrationEngine(client).run(config([partner, contact]), [
    { rowNumber: 2, values: { partner_id: "p1", partner_name: "Acme", contact_id: "c1", email: "new@acme.com" } },
  ]);
  assert.deepEqual(client.updates, [
    { type: "Contact", id: "c-1", fields: { Email: "new@acme.com" }, addParents: ["p-1"] },
  ]);
});

test("empty source values never erase existing data", async () => {
  const client = new FakeClient();
  client.records.set("Partner", [{ id: "p-1", fields: { "HubSpot ID": "p1", "Partner Name": "Acme" } }]);
  const result = await new MigrationEngine(client).run(config([partner]), [
    { rowNumber: 2, values: { partner_id: "p1", partner_name: "" } },
  ]);
  assert.equal(result.summaries.partner?.unchanged, 1);
  assert.equal(client.updates.length, 0);
});

test("an optional lookup that finds nothing is skipped and its references are left out", async () => {
  const client = new FakeClient();
  const company: ObjectConfig = {
    name: "company", type: "Company", mode: "lookup", optional: true,
    match: { field: "HubSpot ID", column: "company_id" },
  };
  const deal: ObjectConfig = {
    name: "deal", type: "Deal", mode: "create", fields: { Name: "name" },
    references: { Company: { object: "company" } },
    parents: [{ object: "company" }],
  };
  const result = await new MigrationEngine(client).run(config([company, deal]), [
    { rowNumber: 2, values: { company_id: "nope", name: "Big deal" } },
  ]);
  assert.equal(result.failures.length, 0);
  assert.equal(result.summaries.company?.missing, 1);
  assert.deepEqual(client.creates[0]?.fields, { Name: "Big deal" });
  assert.deepEqual(client.creates[0]?.parents, []);
});

test("an optional lookup with an empty key is skipped, a required one fails", async () => {
  const optional: ObjectConfig = { name: "company", type: "Company", mode: "lookup", optional: true, match: { field: "HubSpot ID", column: "company_id" } };
  const required: ObjectConfig = { ...optional, optional: false };
  const rows = [{ rowNumber: 2, values: { company_id: "" } }];
  const ok = await new MigrationEngine(new FakeClient()).run(config([optional]), rows);
  assert.equal(ok.failures.length, 0);
  assert.equal(ok.summaries.company?.skipped, 1);
  const bad = await new MigrationEngine(new FakeClient()).run(config([required]), rows);
  assert.equal(bad.failures.length, 1);
});

test("skipWhenEmpty skips an object for rows without the column", async () => {
  const client = new FakeClient();
  const optionalContact: ObjectConfig = { ...contact, skipWhenEmpty: ["email"] };
  const result = await new MigrationEngine(client).run(config([partner, optionalContact]), [
    { rowNumber: 2, values: { partner_id: "p1", partner_name: "Acme", contact_id: "c1", email: "" } },
  ]);
  assert.equal(result.summaries.contact?.skipped, 1);
  assert.equal(client.creates.length, 1);
});

test("a dry run remembers would-be records so later steps can look them up", async () => {
  const client = new FakeClient();
  const engine = new MigrationEngine(client);
  await engine.run(config([partner]), [{ rowNumber: 2, values: { partner_id: "p1", partner_name: "Acme" } }], { dryRun: true });
  const lookup: ObjectConfig = { name: "partner", type: "Partner", mode: "lookup", match: { field: "HubSpot ID", column: "partner_id" } };
  const next = await engine.run(config([lookup]), [{ rowNumber: 2, values: { partner_id: "p1" } }], { dryRun: true });
  assert.equal(next.failures.length, 0);
  assert.equal(next.summaries.partner?.found, 1);
  assert.equal(client.creates.length, 0);
});

test("a parent match finds the single record of that type under a parent", async () => {
  const client = new FakeClient();
  const info: ObjectConfig = {
    name: "info", type: "Partner Info", mode: "upsert",
    match: { parent: { object: "partner" } },
    parents: [{ object: "partner" }],
  };
  const rows = [{ rowNumber: 2, values: { partner_id: "p1", partner_name: "Acme" } }];
  const engine = new MigrationEngine(client);
  const first = await engine.run(config([partner, info]), rows);
  assert.equal(first.summaries.info?.created, 1);
  const second = await engine.run(config([partner, info]), rows);
  assert.equal(second.summaries.info?.unchanged, 1);
  assert.equal(client.creates.filter((create) => create.type === "Partner Info").length, 1);
  // a different partner gets its own Partner Info
  const other = await engine.run(config([partner, info]), [{ rowNumber: 3, values: { partner_id: "p2", partner_name: "Beta" } }]);
  assert.equal(other.summaries.info?.created, 1);
});

test("loose comparison treats text and numbers, booleans and array order as equal", () => {
  assert.equal(sameValue(6000, "6000"), true);
  assert.equal(sameValue(true, "true"), true);
  assert.equal(sameValue(["B", "A"], ["A", "B"]), true);
  assert.equal(sameValue("ref-1", { $ref: "ref-1" }), true);
  assert.equal(sameValue("x", "y"), false);
  assert.deepEqual(changedFields({ A: 1, B: "x" }, { A: "1", B: "y" }), { B: "y" });
});
