import assert from "node:assert/strict";
import test from "node:test";
import type { AnyDBTypeSchema, MigrationAnyDBClient } from "../anydb/AnyDBClient.js";
import { validateAgainstAnyDB } from "./validateRemote.js";

const schemas: Record<string, AnyDBTypeSchema> = {
  Item: {
    name: "Item",
    id: "item-type",
    fields: [
      { name: "SKU", position: "A1", valueType: "string" },
      { name: "Item Name", position: "A2", valueType: "string" },
      { name: "Location Ref", position: "A3", valueType: "ref", format: "ref" },
    ],
  },
};

const client = {
  listTypes: async () => Object.keys(schemas),
  getType: async (name: string) => schemas[name]!,
} as MigrationAnyDBClient;

test("live validation accepts fields and references present in AnyDB types", async () => {
  await validateAgainstAnyDB(client, {
    name: "valid",
    source: { file: "input.csv" },
    objects: [{
      name: "item",
      type: "Item",
      mode: "upsert",
      match: { field: "SKU", column: "SKU" },
      fields: { "Item Name": "Name" },
      references: { "Location Ref": { object: "location" } },
    }],
  }, [{ rowNumber: 2, values: { SKU: "A100", Name: "Widget" } }]);
});

test("live validation reports missing types, fields, source columns, and invalid reference fields", async () => {
  await assert.rejects(validateAgainstAnyDB(client, {
    name: "invalid",
    source: { file: "input.csv" },
    objects: [
      {
        name: "item",
        type: "Item",
        mode: "upsert",
        match: { field: "Missing Match", column: "Missing Column" },
        references: { SKU: { object: "earlier" } },
      },
      { name: "unknown", type: "Unknown", mode: "create" },
    ],
  }, [{ rowNumber: 2, values: { SKU: "A100" } }]), (error: unknown) => {
    if (!(error instanceof Error)) return false;
    assert.match(error.message, /source column "Missing Column"/);
    assert.match(error.message, /has no field "Missing Match"/);
    assert.match(error.message, /field "SKU".*is not a reference field/);
    assert.match(error.message, /type "Unknown" does not exist/);
    return true;
  });
});
