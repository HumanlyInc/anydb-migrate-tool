import assert from "node:assert/strict";
import test from "node:test";
import { buildMatch } from "./matching.js";

test("single-field matching", () => {
  const match = buildMatch({ field: "SKU", column: "Source SKU" }, { "Source SKU": "A100" }, new Map());
  assert.deepEqual(match, { SKU: "A100" });
});

test("compound matching supports source values and prior objects", () => {
  const resolved = new Map([["item", { id: "item-1", status: "found" as const }]]);
  const match = buildMatch(
    { fields: { "Item Ref": { object: "item" }, Warehouse: { column: "Location" } } },
    { Location: "North" },
    resolved,
  );
  assert.deepEqual(match, { "Item Ref": { $ref: "item-1" }, Warehouse: "North" });
});
