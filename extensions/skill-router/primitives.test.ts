import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSyntheticSourceInfo,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { RouterConfigStore } from "./config";
import { classifyRoute, prepareRoute } from "./core";
import {
  type ClassifierModel,
  type ClassifierRegistry,
  JevClient,
  selectJevModel,
} from "./jev";

const FORBIDDEN_CLASSIFIER_FIELDS = /tool|attachment|filePath/;
const JEV = { provider: "typesafe", id: "jev-latest" } as ClassifierModel;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function makeRoot() {
  const value = await mkdtemp(join(tmpdir(), "router-p-"));
  roots.push(value);
  return value;
}
function skill(name: string, hidden = false): Skill {
  return {
    name,
    description: "description",
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: createSyntheticSourceInfo(`/skills/${name}`, {
      source: "test",
    }),
    disableModelInvocation: hidden,
  };
}
function fakeRegistry(
  classify: (...args: Parameters<ClassifierRegistry["classify"]>) => unknown,
  available: { provider: string; id: string }[] = [JEV],
): ClassifierRegistry {
  return {
    getAvailableOfType: async () => available,
    classify,
  } as unknown as ClassifierRegistry;
}
function stop(answers: Record<string, unknown>, usage?: unknown) {
  return { stopReason: "stop", answers, ...(usage ? { usage } : {}) };
}
test("config absent disabled, strict invalid fails closed and save is owner-only", async () => {
  const r = await makeRoot();
  const store = new RouterConfigStore({ agentDir: r, env: {} });
  expect(await store.load()).toBe(false);
  await store.save(true);
  expect(await store.load()).toBe(true);
  await writeFile(store.path, "{}");
  expect(store.load()).rejects.toThrow("unusable");
  expect(store.save(false)).rejects.toThrow("unusable");
});

test("Jev model selection prefers direct TypeSafe, then any credentialed Jev", async () => {
  const openrouter = { provider: "openrouter", id: "typesafe/jev-1.13" };
  const llama = { provider: "llama-cpp", id: "qwen3" };
  const select = (available: { provider: string; id: string }[]) =>
    selectJevModel(fakeRegistry(() => undefined, available));
  expect(await select([llama, openrouter, JEV])).toBe(JEV);
  expect(await select([llama, openrouter])).toBe(openrouter);
  expect(await select([llama])).toBeUndefined();
  expect(await select([])).toBeUndefined();
});

test("Jev schema has only bounded text/metadata, uses bool questions, and does not retry", async () => {
  let request: Parameters<ClassifierRegistry["classify"]> | undefined;
  let calls = 0;
  const client = new JevClient({
    model: JEV,
    registry: fakeRegistry((...args) => {
      calls++;
      request = args;
      return Promise.resolve(
        stop(
          { applicable_s0: { type: "bool", probability: 1 } },
          { input: 7, output: 1, totalTokens: 8, cost: { total: 0 } },
        ),
      );
    }),
  });
  const result = await client.judgeBatch(
    [{ id: "s0", name: "unknown", description: "data" }],
    { currentRequest: "request", recentText: "recent" },
  );
  expect(result).toEqual({
    scores: new Map([["s0", 1]]),
    inputTokens: 7,
    outputTokens: 1,
  });
  expect(calls).toBe(1);
  const [model, context, options] = request ?? [];
  expect(model).toBe(JEV);
  expect(JSON.stringify(context)).not.toMatch(FORBIDDEN_CLASSIFIER_FIELDS);
  expect(context?.questions.applicable_s0).toMatchObject({ type: "bool" });
  expect(options).toMatchObject({ maxRetries: 0 });
  expect(options?.signal).toBeInstanceOf(AbortSignal);
});
test("deadline covers a classifier that ignores abort and cancellation is sanitized", async () => {
  const client = new JevClient({
    model: JEV,
    timeoutMs: 10,
    registry: fakeRegistry(() => new Promise(() => undefined)),
  });
  expect(
    client.judgeBatch([{ id: "s0", name: "x", description: "x" }], {
      currentRequest: "x",
      recentText: "",
    }),
  ).rejects.toMatchObject({ category: "timeout" });
  const controller = new AbortController();
  controller.abort();
  let preAbortedCalls = 0;
  const preAborted = new JevClient({
    model: JEV,
    registry: fakeRegistry(() => {
      preAbortedCalls++;
      return Promise.resolve(stop({}));
    }),
  });
  expect(
    preAborted.judgeBatch(
      [{ id: "s0", name: "x", description: "x" }],
      { currentRequest: "x", recentText: "" },
      controller.signal,
    ),
  ).rejects.toMatchObject({ category: "cancelled" });
  expect(preAbortedCalls).toBe(0);
});
test("Jev failures are categorized and malformed answers are rejected without retries", async () => {
  const candidate = [{ id: "s0", name: "x", description: "x" }];
  const context = { currentRequest: "x", recentText: "" };
  const outcomes: [unknown, string][] = [
    [
      {
        stopReason: "error",
        answers: {},
        errorMessage: "secret provider detail",
      },
      "provider",
    ],
    [{ stopReason: "aborted", answers: {} }, "cancelled"],
    [stop({}), "malformed"],
    [
      stop({
        applicable_s0: { type: "bool", probability: 1 },
        extra: { type: "bool", probability: 0 },
      }),
      "malformed",
    ],
    [stop({ applicable_s0: { type: "choice", probability: 1 } }), "malformed"],
    [
      stop({ applicable_s0: { type: "bool", probability: Number.NaN } }),
      "malformed",
    ],
    [stop({ applicable_s0: { type: "bool", probability: 2 } }), "malformed"],
  ];
  for (const [result, category] of outcomes) {
    let calls = 0;
    const client = new JevClient({
      model: JEV,
      registry: fakeRegistry(() => {
        calls++;
        return Promise.resolve(result);
      }),
    });
    const failure = client.judgeBatch(candidate, context);
    expect(failure).rejects.toMatchObject({ category });
    expect(failure).rejects.not.toMatchObject({
      message: expect.stringContaining("secret"),
    });
    expect(calls).toBe(1);
  }
  const thrown = new JevClient({
    model: JEV,
    registry: fakeRegistry(() =>
      Promise.reject(new Error("secret transport detail")),
    ),
  });
  expect(thrown.judgeBatch(candidate, context)).rejects.toMatchObject({
    category: "provider",
    message: "Jev request failed",
  });
});

test("Jev request and payload bounds fail before classification", async () => {
  let calls = 0;
  const client = new JevClient({
    model: JEV,
    registry: fakeRegistry(() => {
      calls++;
      return Promise.resolve(stop({}));
    }),
  });
  const context = { currentRequest: "x", recentText: "" };
  expect(client.judgeBatch([], context)).rejects.toThrow("1 to 16");
  expect(
    client.judgeBatch(
      Array.from({ length: 17 }, (_, index) => ({
        id: `s${index}`,
        name: "x",
        description: "x",
      })),
      context,
    ),
  ).rejects.toThrow("1 to 16");
  expect(
    client.judgeBatch(
      [{ id: "s0", name: "x", description: "x".repeat(70_000) }],
      context,
    ),
  ).rejects.toMatchObject({ category: "malformed" });
  expect(calls).toBe(0);
});

test("classification thresholds, hidden exclusion, uncertainty and malformed/partial fallback", async () => {
  const prepared = prepareRoute({
    skills: [skill("execute"), skill("hidden", true), skill("unknown")],
    currentRequest: "x",
    recentText: "",
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    return;
  }
  expect(prepared.candidates.map((candidate) => candidate.name)).toEqual([
    "unknown",
  ]);
  const selected = await classifyRoute(prepared, async (batch) => ({
    scores: new Map([[batch[0].id, 1]]),
  }));
  expect(selected.kind).toBe("selected");
  const rejected = await classifyRoute(prepared, async (batch) => ({
    scores: new Map([[batch[0].id, 0]]),
  }));
  expect(rejected).toMatchObject({ kind: "selected", skills: [] });
  expect(
    (
      await classifyRoute(prepared, async (batch) => ({
        scores: new Map([[batch[0].id, 0.5]]),
      }))
    ).kind,
  ).toBe("fallback");
  expect(
    (await classifyRoute(prepared, async () => ({ scores: new Map() }))).kind,
  ).toBe("fallback");

  const tooMany = prepareRoute({
    skills: Array.from({ length: 9 }, (_, index) => skill(`auto-${index}`)),
    currentRequest: "x",
    recentText: "",
  });
  expect(tooMany.ok).toBe(true);
  if (tooMany.ok) {
    const result = await classifyRoute(tooMany, async (batch) => ({
      scores: new Map(batch.map((candidate) => [candidate.id, 1])),
    }));
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "selection limit exceeded",
    });
  }
});
