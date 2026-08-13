import assert from "node:assert/strict";
import test from "node:test";
import { RequestLimiter } from "./RequestLimiter.js";

test("spaces requests according to the configured rate", async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = new RequestLimiter({
    requestsPerMinute: 60,
    now: () => now,
    sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
  });
  await limiter.schedule(async () => "first");
  await limiter.schedule(async () => "second");
  assert.deepEqual(waits, [1_000]);
});

test("waits and retries explicit rate-limit responses", async () => {
  let now = 0;
  let calls = 0;
  const waits: number[] = [];
  const notices: Array<[number, number]> = [];
  const limiter = new RequestLimiter({
    requestsPerMinute: 120,
    now: () => now,
    sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
    onRateLimit: (milliseconds, attempt) => notices.push([milliseconds, attempt]),
  });
  const result = await limiter.schedule(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("limited"), { status: 429, retryAfter: "2" });
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(notices, [[2_000, 1]]);
  assert.deepEqual(waits, [2_000]);
});
