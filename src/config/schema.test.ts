import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, validateConfig } from "./schema.js";

test("invalid forward reference is rejected", () => {
  assert.throws(() => validateConfig({
    name: "bad",
    source: { file: "input.csv" },
    objects: [
      { name: "inventory", type: "Inventory", mode: "create", references: { Item: { object: "item" } } },
      { name: "item", type: "Item", mode: "create" },
    ],
  }), (error: unknown) => error instanceof ConfigError && /must appear earlier/.test(error.message));
});
