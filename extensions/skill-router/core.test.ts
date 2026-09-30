import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createSyntheticSourceInfo,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { writeRecoveryCatalog } from "./catalog";
import { classifyRoute, loadSelectedSkills, prepareRoute } from "./core";

function skill(root: string, name: string, description = "Useful"): Skill {
  return {
    name,
    description,
    filePath: join(root, name, "SKILL.md"),
    baseDir: join(root, name),
    sourceInfo: createSyntheticSourceInfo(join(root, name), {
      source: "test",
    }),
    disableModelInvocation: false,
  };
}

test("policy excludes hard gates but allows unknown names", () => {
  const root = "/tmp/x";
  const skills = [skill(root, "execute"), skill(root, "new-import")];
  const result = prepareRoute({
    skills,
    currentRequest: "do it",
    recentText: "",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.candidates.map((x) => x.skill.name)).toEqual(["new-import"]);
  }
});

test("input bounds and visible recent truncation", () => {
  const root = "/tmp/x";
  const s = skill(root, "a");
  expect(
    prepareRoute({
      skills: [s],
      currentRequest: "x".repeat(8193),
      recentText: "",
    }).ok,
  ).toBe(false);
  const result = prepareRoute({
    skills: [s],
    currentRequest: "x",
    recentText: "é".repeat(5000),
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.recentText).toContain("[truncated");
  }
});

test("recent truncation retains newest Unicode context with a marker", () => {
  const result = prepareRoute({
    skills: [skill("/tmp/x", "a")],
    currentRequest: "continue",
    recentText: `${"old😀".repeat(3000)}LATEST fix it ✅`,
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.context.recentText.startsWith("[truncated:")).toBe(true);
    expect(result.context.recentText.endsWith("LATEST fix it ✅")).toBe(true);
    expect(Buffer.byteLength(result.context.recentText)).toBeLessThanOrEqual(
      8192,
    );
    expect(result.context.recentText).not.toContain("�");
  }
});

test("pre-aborted classification never invokes the judge", async () => {
  const prepared = prepareRoute({
    skills: [skill("/tmp/x", "a")],
    currentRequest: "route",
    recentText: "",
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    return;
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await classifyRoute(
    prepared,
    () => {
      calls++;
      return Promise.resolve({ scores: new Map([["s0", 1]]) });
    },
    controller.signal,
  );
  expect(calls).toBe(0);
  expect(result.kind).toBe("fallback");
  if (result.kind === "fallback") {
    expect(result.reason).toBe("cancelled");
  }
});

test("synchronous cancellation settles even when judges ignore abort", async () => {
  const prepared = prepareRoute({
    skills: Array.from({ length: 33 }, (_, index) =>
      skill("/tmp/x", `s${index}`),
    ),
    currentRequest: "route",
    recentText: "",
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    return;
  }
  const controller = new AbortController();
  let calls = 0;
  const result = await Promise.race([
    classifyRoute(
      prepared,
      () => {
        calls++;
        controller.abort();
        return new Promise(() => {
          // Deliberately ignores cancellation and never settles.
        });
      },
      controller.signal,
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("classification did not settle")), 100),
    ),
  ]);
  expect(result).toMatchObject({ kind: "fallback", reason: "cancelled" });
  expect(calls).toBe(1);
});

test("one global deadline bounds all batches and late judges cannot mutate returned usage", async () => {
  const prepared = prepareRoute({
    skills: Array.from({ length: 65 }, (_, index) =>
      skill("/tmp/x", `s${index}`),
    ),
    currentRequest: "route",
    recentText: "",
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    return;
  }
  let active = 0;
  let maximum = 0;
  const resolvers: Array<
    (value: { scores: Map<string, number>; inputTokens: number }) => void
  > = [];
  const started = Date.now();
  const result = await classifyRoute(prepared, (batch) => {
    expect(batch.length).toBeLessThanOrEqual(16);
    active++;
    maximum = Math.max(maximum, active);
    return new Promise((resolve) => resolvers.push(resolve));
  });
  const elapsed = Date.now() - started;
  expect(result).toMatchObject({
    kind: "fallback",
    reason: "classification timed out",
  });
  expect(elapsed).toBeGreaterThanOrEqual(1900);
  expect(elapsed).toBeLessThan(2600);
  expect(maximum).toBeLessThanOrEqual(4);
  const returnedUsage = result.usage;
  for (const resolve of resolvers) {
    resolve({ scores: new Map(), inputTokens: 999 });
  }
  await Promise.resolve();
  expect(result.usage).toEqual(returnedUsage);
});

test("loads only matched local paths preserving full metadata and bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-core-"));
  try {
    const s = skill(root, "safe");
    await mkdir(s.baseDir, { recursive: true });
    await writeFile(s.filePath, "BODY");
    const loaded = await loadSelectedSkills([s], ["safe"]);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.skills[0].body).toBe("BODY");
      expect(loaded.skills[0].skill.filePath).toBe(s.filePath);
    }
    expect((await loadSelectedSkills([s], ["missing"])).ok).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected bodies enforce cumulative bytes, UTF-8 validity, and reject FIFOs", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-body-"));
  try {
    const first = skill(root, "first");
    const second = skill(root, "second");
    await Promise.all([
      mkdir(first.baseDir, { recursive: true }),
      mkdir(second.baseDir, { recursive: true }),
    ]);
    await writeFile(first.filePath, Buffer.alloc(32_768, 97));
    await writeFile(second.filePath, `${"é".repeat(16_383)}ab`);
    const exact = await loadSelectedSkills(
      [first, second],
      ["first", "second"],
    );
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(Buffer.byteLength(exact.skills[1].body)).toBe(32_768);
    }
    await writeFile(second.filePath, Buffer.alloc(32_769, 98));
    expect(
      (await loadSelectedSkills([first, second], ["first", "second"])).ok,
    ).toBe(false);
    await writeFile(second.filePath, Uint8Array.from([0xc3, 0x28]));
    expect((await loadSelectedSkills([second], ["second"])).ok).toBe(false);
    await rm(second.filePath);
    await promisify(execFile)("mkfifo", [second.filePath]);
    const fifo = await Promise.race([
      loadSelectedSkills([second], ["second"]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("FIFO blocked")), 100),
      ),
    ]);
    expect(fifo.ok).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes deterministic owner-only metadata catalog without bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-cat-"));
  try {
    const s = skill(root, "safe", "desc");
    const a = await writeRecoveryCatalog(root, [s]);
    const b = await writeRecoveryCatalog(root, [s]);
    expect(a).toBe(b);
    const text = await readFile(a, "utf8");
    expect(text).toContain("desc");
    expect(text).not.toContain("BODY");
    if (process.platform !== "win32") {
      expect((await stat(a)).mode % 0o100).toBe(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
