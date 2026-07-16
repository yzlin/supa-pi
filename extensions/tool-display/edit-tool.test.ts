import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { resolveToCwd, withFileMutationQueue } from "./edit-tool";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = join(
    import.meta.dir,
    `.tmp-edit-tool-${Date.now()}-${Math.random()}`
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("edit helper compatibility", () => {
  test("normalizes Unicode spaces, @ aliases, and file URLs", () => {
    const dir = tempDir();
    expect(resolveToCwd(dir, "foo\u00A0bar.txt")).toBe(
      join(dir, "foo bar.txt")
    );
    const target = join(dir, "target.txt");
    expect(resolveToCwd(dir, `@${pathToFileURL(target).href}`)).toBe(target);
  });

  test("rejects aborted queued work without running it", async () => {
    const path = join(tempDir(), "queued.txt");
    let release!: () => void;
    const started = Promise.withResolvers<void>();
    const first = withFileMutationQueue([path], () => {
      started.resolve();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await started.promise;
    const controller = new AbortController();
    let ran = false;
    const second = withFileMutationQueue(
      [path],
      () => {
        ran = true;
        return Promise.resolve();
      },
      controller.signal
    );
    controller.abort();
    await expect(second).rejects.toThrow("Operation aborted");
    expect(ran).toBe(false);
    release();
    await first;
  });

  test("preserves the active lock after queued work aborts", async () => {
    const path = join(tempDir(), "lock.txt");
    let release!: () => void;
    const started = Promise.withResolvers<void>();
    const first = withFileMutationQueue([path], () => {
      started.resolve();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await started.promise;
    const controller = new AbortController();
    const second = withFileMutationQueue(
      [path],
      async () => undefined,
      controller.signal
    );
    controller.abort();
    await expect(second).rejects.toThrow("Operation aborted");
    let thirdStarted = false;
    const third = withFileMutationQueue([path], () => {
      thirdStarted = true;
      return Promise.resolve();
    });
    await sleep(0);
    expect(thirdStarted).toBe(false);
    release();
    await first;
    await third;
    expect(thirdStarted).toBe(true);
  });

  test("bounds canonicalization work", async () => {
    const path = join(
      tempDir(),
      ...Array.from({ length: 300 }, (_, index) => `x-${index}`)
    );
    await expect(
      withFileMutationQueue([path], async () => undefined)
    ).rejects.toThrow("Path exceeds maximum canonicalization size");
  });
});
