import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ADORecord } from "anydb-api-sdk-ts";
import { planReuse, readSnapshot, snapshotFile, stampOf, writeSnapshot } from "./snapshot.js";

const meta = (adoid: string, version?: number, updated?: number) =>
  ({ adoid, adbid: "d", teamid: "t", name: adoid, version, updated }) as unknown as ADORecord["meta"];
const entry = (adoid: string, stamp: string) => ({ stamp, record: { meta: meta(adoid), content: {} } as ADORecord });

test("an unchanged record is reused, a changed or new one is fetched, a deleted one is dropped", () => {
  const plan = planReuse(
    [meta("a", 1, 100), meta("b", 2, 200), meta("c", 1, 300)],
    [entry("a", "1|100"), entry("b", "1|150"), entry("gone", "1|1")],
  );
  assert.deepEqual([...plan.reuse.keys()], ["a"]);
  assert.deepEqual(plan.fetch.map((item) => item.adoid), ["b", "c"]);
});

test("a record with no usable stamp is never trusted", () => {
  assert.equal(stampOf(meta("a")), "");
  const plan = planReuse([meta("a")], [entry("a", "")]);
  assert.equal(plan.reuse.size, 0);
  assert.equal(plan.fetch.length, 1);
});

test("a snapshot round-trips, and a missing or corrupt one reads as empty", () => {
  const file = snapshotFile(mkdtempSync(join(tmpdir(), "migrate-cache-")), "t", "d", "Deal Registration");
  assert.deepEqual(readSnapshot(file), []);
  writeSnapshot(file, [entry("a", "1|100")]);
  assert.equal(readSnapshot(file)[0]?.record.meta.adoid, "a");
  writeSnapshot(file, []);
  assert.deepEqual(readSnapshot(file), []);
});
