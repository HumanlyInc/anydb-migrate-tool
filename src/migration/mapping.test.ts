import assert from "node:assert/strict";
import test from "node:test";
import { applyColumn, decodeHtml, excelSerialToEpoch, resolveValue } from "./mapping.js";

const row = {
  Stage: "Closed-Won",
  Tier: " Ascend ",
  Types: "MSP; Reseller ;Referral",
  Date: 46333,
  Amount: "$4,200.50",
  Flag: "Yes",
  Blank: "",
  Name: "AT&amp;T",
  First: "Ada",
  Last: "Lovelace",
};

test("map translates values and strict rejects unknown ones", () => {
  const source = { column: "Stage", map: { "Closed-Won": "closed_won" }, strict: true };
  assert.equal(applyColumn(source, row), "closed_won");
  assert.throws(() => applyColumn({ ...source, map: { Other: "x" } }, row), /Unmapped value "Closed-Won"/);
});

test("non-strict map passes unknown values through or uses the default", () => {
  assert.equal(applyColumn({ column: "Stage", map: { x: "y" } }, row), "Closed-Won");
  assert.equal(applyColumn({ column: "Stage", map: { x: "y" }, default: "other" }, row), "other");
});

test("empty values return the default", () => {
  assert.equal(applyColumn({ column: "Blank", default: "n/a" }, row), "n/a");
  assert.equal(applyColumn({ column: "Missing" }, row), undefined);
});

test("text is trimmed and can be lowercased and decoded", () => {
  assert.equal(applyColumn({ column: "Tier" }, row), "Ascend");
  assert.equal(applyColumn({ column: "Tier", lower: true }, row), "ascend");
  assert.equal(applyColumn({ column: "Name", decode: true }, row), "AT&T");
});

test("split makes an array and maps each part", () => {
  assert.deepEqual(applyColumn({ column: "Types", split: ";" }, row), ["MSP", "Reseller", "Referral"]);
  assert.deepEqual(
    applyColumn({ column: "Types", split: ";", map: { MSP: "Managed" } }, row),
    ["Managed", "Reseller", "Referral"],
  );
});

test("excel serial dates become epoch seconds", () => {
  assert.equal(excelSerialToEpoch(25569), 0);
  assert.equal(applyColumn({ column: "Date", date: "excel" }, row), 1794009600);
  assert.equal(applyColumn({ column: "Date", date: "excel" }, { Date: "46333" }), 1794009600);
  assert.equal(applyColumn({ column: "Date", date: "iso" }, { Date: "2026-11-05T00:00:00Z" }), 1793836800);
  assert.throws(() => applyColumn({ column: "Date", date: "iso" }, { Date: "not a date" }), /Cannot read/);
});

test("numbers and booleans are parsed", () => {
  assert.equal(applyColumn({ column: "Amount", number: true }, row), 4200.5);
  assert.throws(() => applyColumn({ column: "Name", number: true }, row), /as a number/);
  assert.equal(applyColumn({ column: "Flag", boolean: true }, row), true);
});

test("template and coalesce build values from several columns", () => {
  const resolved = new Map();
  assert.equal(resolveValue({ template: "{First} {Last} ({Missing})" }, row, resolved), "Ada Lovelace ()");
  assert.equal(resolveValue({ coalesce: ["Blank", "Missing", "First"] }, row, resolved), "Ada");
  assert.equal(resolveValue({ coalesce: ["Blank"] }, row, resolved), undefined);
});

test("a reference to a missing or skipped object resolves to nothing", () => {
  const resolved = new Map([["company", { id: "", status: "missing" as const }]]);
  assert.equal(resolveValue({ object: "company" }, row, resolved), undefined);
  assert.throws(() => resolveValue({ object: "nope" }, row, resolved), /has not been resolved/);
});

test("html entities are decoded", () => {
  assert.equal(decodeHtml("Fish &amp; Chips &quot;x&quot; &#39;y&#39;"), "Fish & Chips \"x\" 'y'");
});
