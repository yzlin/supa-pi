// SupaPi additions: offline tests for the Apache-2.0 subagent adaptation; see extensions/subagent/NOTICE and LICENSE.upstream.
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { cancelSessionSubagents, withSessionSlot } from "./scheduler";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
test("four slots shared across callers, fifth waits; shutdown cancels active and queued only for owner", async () => {
  const id = randomUUID();
  let active = 0;
  let started = 0;
  let peak = 0;
  let queued = 0;
  const work = async (signal: AbortSignal) => {
    active++;
    started++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    active--;
    throw new Error("cancelled");
  };
  const jobs = Array.from({ length: 7 }, () =>
    withSessionSlot(id, undefined, () => queued++, work).catch(
      (error: unknown) =>
        error instanceof Error ? error.message : "unknown error",
    ),
  );
  await tick();
  expect(peak).toBe(4);
  expect(started).toBe(4);
  expect(queued).toBe(3);
  expect(
    await withSessionSlot(
      randomUUID(),
      undefined,
      () => {},
      async () => "other",
    ),
  ).toBe("other");
  await cancelSessionSubagents(id);
  await Promise.all(jobs);
  expect(started).toBe(4);
  expect(active).toBe(0);
});
test("queued tool abort rejects immediately and never starts; slot release serves remaining work", async () => {
  const id = randomUUID();
  const releases: (() => void)[] = [];
  const running = Array.from({ length: 4 }, () =>
    withSessionSlot(
      id,
      undefined,
      () => {},
      () => new Promise<void>((resolve) => releases.push(resolve)),
    ),
  );
  await tick();
  const controller = new AbortController();
  let started = false;
  const cancelled = withSessionSlot(
    id,
    controller.signal,
    () => {},
    async () => {
      started = true;
    },
  );
  controller.abort();
  await rejects(cancelled, /abort/);
  expect(started).toBe(false);
  const remaining = withSessionSlot(
    id,
    undefined,
    () => {},
    async () => "ok",
  );
  for (const release of releases) {
    release();
  }
  await Promise.all(running);
  expect(await remaining).toBe("ok");
});

test("completed cancellation releases parent ownership for fresh calls after reload", async () => {
  const id = randomUUID();
  await cancelSessionSubagents(id);
  expect(
    await withSessionSlot(
      id,
      undefined,
      () => {},
      async () => "fresh",
    ),
  ).toBe("fresh");
});
