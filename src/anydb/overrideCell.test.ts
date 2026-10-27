import assert from "node:assert/strict";
import test from "node:test";
import { ADOCellValueType, type ADOCell } from "anydb-api-sdk-ts";
import { isOverridable } from "./sdkClient.js";

function cell(overrides: Partial<ADOCell>, override?: boolean): ADOCell {
  return {
    pos: "A1",
    key: "Field",
    type: ADOCellValueType.NUMBER,
    value: 0,
    expr: "",
    props: override === undefined ? {} : { VALUE_OVERRIDE_ENABLED: { value: override } },
    ...overrides,
  } as unknown as ADOCell;
}

test("a formula cell with value override enabled is overridable", () => {
  assert.equal(isOverridable(cell({ expr: "TODAY()" }, true)), true);
});

test("a formula cell without value override is not overridable", () => {
  assert.equal(isOverridable(cell({ expr: "TODAY()" }, false)), false);
  assert.equal(isOverridable(cell({ expr: "TODAY()" })), false);
});

test("a plain cell and a reference cell are never treated as overridable", () => {
  assert.equal(isOverridable(cell({ expr: "" }, true)), false);
  assert.equal(isOverridable(cell({ expr: "O@abc!F@GO!M@MINI", type: ADOCellValueType.REF }, true)), false);
});
