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

function stubbedLimiter(extra: Partial<ConstructorParameters<typeof RequestLimiter>[0]> = {}) {
  let now = 0;
  const waits: number[] = [];
  const limiter = new RequestLimiter({
    requestsPerMinute: 6_000,
    serverErrorBackoffMs: [10, 20],
    now: () => now,
    sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
    ...extra,
  });
  return { limiter, waits };
}

test("retries gateway errors with backoff when the call is safe to repeat", async () => {
  const { limiter, waits } = stubbedLimiter();
  let calls = 0;
  const result = await limiter.schedule(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("bad gateway"), { status: 502 });
    return "ok";
  }, true);
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits.filter((wait) => wait >= 10), [10, 20]);
});

test("never retries gateway errors for calls that are not safe to repeat", async () => {
  const { limiter } = stubbedLimiter();
  let calls = 0;
  await assert.rejects(limiter.schedule(async () => {
    calls += 1;
    throw Object.assign(new Error("bad gateway"), { status: 502 });
  }), /bad gateway/);
  assert.equal(calls, 1);
});

test("gives up after the backoff list is used up, and ignores other errors", async () => {
  const { limiter } = stubbedLimiter();
  let calls = 0;
  await assert.rejects(limiter.schedule(async () => {
    calls += 1;
    throw Object.assign(new Error("down"), { status: 503 });
  }, true), /down/);
  assert.equal(calls, 3);
  let other = 0;
  await assert.rejects(limiter.schedule(async () => {
    other += 1;
    throw Object.assign(new Error("bad request"), { status: 400 });
  }, true), /bad request/);
  assert.equal(other, 1);
});
