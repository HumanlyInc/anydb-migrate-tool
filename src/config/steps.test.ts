import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, normalizeConfig, validateConfig } from "./schema.js";

const object = { name: "partner", type: "Partner", mode: "upsert", match: { field: "HubSpot ID", column: "id" } };

test("a multi-step plan validates and normalizes", () => {
  const config = {
    name: "plan",
    steps: [
      { name: "partners", source: { file: "p.csv" }, objects: [object] },
      { name: "contacts", source: { file: "c.csv" }, objects: [{ ...object, name: "contact", type: "Contact" }] },
    ],
  };
  validateConfig(config);
  assert.equal(normalizeConfig(config).steps.length, 2);
});

test("a single-source config becomes one step", () => {
  const config = { name: "one", source: { file: "x.csv" }, objects: [object] };
  validateConfig(config);
  const plan = normalizeConfig(config);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.name, "one");
});

test("steps cannot be mixed with source and objects, and need unique names", () => {
  assert.throws(() => validateConfig({ name: "x", steps: [], source: { file: "a" }, objects: [object] }), ConfigError);
  assert.throws(() => validateConfig({
    name: "x",
    steps: [
      { name: "a", source: { file: "a.csv" }, objects: [object] },
      { name: "a", source: { file: "b.csv" }, objects: [object] },
    ],
  }), /duplicated/);
});

test("transforms validate: strict needs map, date must be excel or iso", () => {
  const withField = (source: unknown) => ({
    name: "x", source: { file: "a.csv" },
    objects: [{ ...object, fields: { Stage: source } }],
  });
  validateConfig(withField({ column: "Stage", map: { a: "b" }, strict: true, trim: true }));
  validateConfig(withField({ template: "{A} {B}" }));
  validateConfig(withField({ coalesce: ["A", "B"] }));
  assert.throws(() => validateConfig(withField({ column: "Stage", strict: true })), /requires map/);
  assert.throws(() => validateConfig(withField({ column: "D", date: "unix" })), /excel or iso/);
  assert.throws(() => validateConfig(withField({ template: "x", map: {} })), /not allowed with template/);
  assert.throws(() => validateConfig(withField({ column: "A", value: 1 })), /exactly one of/);
});

test("parents must reference earlier objects", () => {
  const bad = {
    name: "x", source: { file: "a.csv" },
    objects: [
      { name: "contact", type: "Contact", mode: "create", parents: [{ object: "partner" }] },
      object,
    ],
  };
  assert.throws(() => validateConfig(bad), /must appear earlier/);
  validateConfig({ name: "x", source: { file: "a.csv" }, objects: [object, { name: "contact", type: "Contact", mode: "create", parents: [{ object: "partner" }] }] });
});

test("optional only applies to lookup or upsert", () => {
  assert.throws(() => validateConfig({
    name: "x", source: { file: "a.csv" },
    objects: [{ name: "a", type: "A", mode: "create", optional: true }],
  }), /optional only applies/);
});
