import assert from "node:assert/strict";
import test from "node:test";
import { applyWhere, failuresCsv, parseWhere } from "./run.js";

const rows = [
  { rowNumber: 2, values: { partner_id: "1", name: "A" } },
  { rowNumber: 3, values: { partner_id: "2", name: "B" } },
  { rowNumber: 4, values: { partner_id: 3, name: "C" } },
];

test("--where keeps only the listed values and handles numbers", () => {
  const filtered = applyWhere(rows, parseWhere(["partner_id=1, 3"]));
  assert.deepEqual(filtered.map((row) => row.values.name), ["A", "C"]);
});

test("a filter on a column the step does not have leaves the step alone", () => {
  assert.equal(applyWhere(rows, parseWhere(["other=9"])).length, 3);
});

test("bad --where expressions are rejected", () => {
  assert.throws(() => parseWhere(["nope"]), /Column=value/);
  assert.throws(() => parseWhere(["col="]), /lists no values/);
});

test("failures are written as CSV with quoting", () => {
  const csv = failuresCsv([{ step: "deals", rowNumber: 9, objectName: "deal", objectType: "Deal", reason: 'Bad "stage", row' }]);
  assert.equal(csv, 'step,row,object,type,reason\ndeals,9,deal,Deal,"Bad ""stage"", row"\n');
});
