import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireRunLock } from "./lock.js";

const directory = () => mkdtempSync(join(tmpdir(), "migrate-lock-"));

test("a second run on the same workspace is refused while the first holds the lock", () => {
  const dir = directory();
  // The parent process is alive and is not this one, so it stands in for another running migration.
  writeFileSync(join(dir, "anydb-migrate-t-d.lock"), String(process.ppid));
  assert.throws(() => acquireRunLock("t", "d", dir), /already writing to this workspace/);
});

test("a lock left by a process that is gone is taken over and released cleanly", () => {
  const dir = directory();
  const file = join(dir, "anydb-migrate-t-d.lock");
  writeFileSync(file, "99999999");
  const release = acquireRunLock("t", "d", dir);
  assert.ok(existsSync(file));
  release();
  assert.equal(existsSync(file), false);
});

test("different workspaces do not block each other", () => {
  const dir = directory();
  const first = acquireRunLock("t", "one", dir);
  const second = acquireRunLock("t", "two", dir);
  first();
  second();
});
