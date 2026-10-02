import assert from "node:assert/strict";
import test from "node:test";
import { parseIdList, planDedupe } from "./dedupe.js";

const rec = (id: string, hs: string | undefined) => ({ id, fields: hs === undefined ? {} : { "HubSpot ID": hs } });
const early = "6abed00000000000000000a1";
const mid = "6abed10000000000000000a2";
const late = "6abed20000000000000000a3";

test("keeps the earliest copy of each key and removes the rest", () => {
  const plan = planDedupe([rec(late, "1"), rec(early, "1"), rec(mid, "1"), rec("6abed30000000000000000b1", "2")], "HubSpot ID");
  assert.deepEqual(plan.keep.map((r) => r.id).sort(), [early, "6abed30000000000000000b1"].sort());
  assert.deepEqual(plan.remove.map((r) => r.id).sort(), [mid, late].sort());
  assert.equal(plan.duplicateKeys, 1);
});

test("a copy that something else references is kept even if it is newer", () => {
  const plan = planDedupe([rec(early, "1"), rec(late, "1")], "HubSpot ID", new Set([late]));
  assert.deepEqual(plan.keep.map((r) => r.id), [late]);
  assert.deepEqual(plan.remove.map((r) => r.id), [early]);
});

test("records with an empty key are never removed", () => {
  const plan = planDedupe([rec(early, undefined), rec(late, ""), rec(mid, "  ")], "HubSpot ID");
  assert.equal(plan.skippedBlank, 3);
  assert.equal(plan.remove.length, 0);
  assert.equal(plan.keep.length, 0);
});

test("keys match after trimming and across number or text", () => {
  const plan = planDedupe([{ id: early, fields: { "HubSpot ID": 5 } }, { id: late, fields: { "HubSpot ID": " 5 " } }], "HubSpot ID");
  assert.equal(plan.remove.length, 1);
});

test("an id list accepts commas and new lines, drops repeats and rejects anything else", () => {
  const a = "6abed1fd76968e4f540e35b8";
  const b = "6abed20676968e4f540e35be";
  assert.deepEqual(parseIdList(`${a},${b}\n${a}\r\n`), [a, b]);
  assert.throws(() => parseIdList(`${a}, nonsense`), /Not a record id/);
});
