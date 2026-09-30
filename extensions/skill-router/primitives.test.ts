import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createSyntheticSourceInfo,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { RouterConfigStore } from "./config";
import { classifyRoute, prepareRoute } from "./core";
import { CredentialStore } from "./credentials";
import { JevClient, JevError } from "./jev";

const FORBIDDEN_CLASSIFIER_FIELDS = /tool|attachment|filePath/;
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
test("config absent disabled, strict invalid fails closed and save is owner-only", async () => {
  const r = await makeRoot();
  const store = new RouterConfigStore({ agentDir: r, env: {} });
  expect(await store.load()).toBe(false);
  await store.save(true);
  expect(await store.load()).toBe(true);
  await writeFile(store.path, "{}");
  await expect(store.load()).rejects.toThrow("unusable");
  await expect(store.save(false)).rejects.toThrow("unusable");
});
test("credentials are isolated, env wins, status does not expose key, unsafe store rejected", async () => {
  const r = await makeRoot();
  const key = "ABCDEFGHIJKLMNOP";
  const stored = new CredentialStore({ agentDir: r, env: {} });
  await stored.save(key);
  expect(JSON.stringify(await stored.status())).not.toContain(key);
  const env = new CredentialStore({
    agentDir: r,
    env: { TYPESAFE_API_KEY: "QRSTUVWXYZabcdef" },
  });
  expect((await env.resolve()).source).toBe("environment");
  if (process.platform !== "win32") {
    await chmod(join(r, "skill-router", "auth.json"), 0o644);
    expect(await stored.status()).toEqual({
      source: "stored",
      usable: false,
      reason: "permissions",
    });
  }
});
test("credential FIFO and symlink destinations are rejected without outside mutation", async () => {
  const r = await makeRoot();
  const directory = join(r, "skill-router");
  await mkdir(directory, { mode: 0o700 });
  const auth = join(directory, "auth.json");
  await promisify(execFile)("mkfifo", [auth]);
  const store = new CredentialStore({ agentDir: r, env: {} });
  const status = await Promise.race([
    store.status(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("FIFO blocked")), 100),
    ),
  ]);
  expect(status).toMatchObject({ usable: false });
  await rm(auth);
  const outside = join(r, "outside.json");
  await writeFile(outside, "untouched");
  await symlink(outside, auth);
  await expect(store.clear()).rejects.toThrow("unsafe");
  expect(await readFile(outside, "utf8")).toBe("untouched");
});

test("Jev schema has only bounded text/metadata and validates exact answers", async () => {
  let body = "";
  let calls = 0;
  const client = new JevClient({
    apiKey: "ABCDEFGHIJKLMNOP",
    fetch: (_url, init) => {
      calls++;
      body = String(init?.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            answers: { applicable_s0: { type: "noul", noul: 1 } },
          }),
          { status: 200 },
        ),
      );
    },
  });
  const result = await client.judgeBatch(
    [{ id: "s0", name: "unknown", description: "data" }],
    { currentRequest: "request", recentText: "recent" },
  );
  expect(result.scores.get("s0")).toBe(1);
  expect(body).not.toMatch(FORBIDDEN_CLASSIFIER_FIELDS);
  expect(calls).toBe(1);
});
test("deadline covers response json that ignores abort and cancellation is sanitized", async () => {
  const client = new JevClient({
    apiKey: "ABCDEFGHIJKLMNOP",
    timeoutMs: 10,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(streamController) {
            streamController.enqueue(new TextEncoder().encode("{"));
          },
        }),
        { status: 200 },
      ),
  });
  await expect(
    client.judgeBatch([{ id: "s0", name: "x", description: "x" }], {
      currentRequest: "x",
      recentText: "",
    }),
  ).rejects.toMatchObject({ category: "timeout" });
  const controller = new AbortController();
  controller.abort();
  let preAbortedCalls = 0;
  const preAborted = new JevClient({
    apiKey: "ABCDEFGHIJKLMNOP",
    fetch: () => {
      preAbortedCalls++;
      return Promise.resolve(Response.json({ answers: {} }));
    },
  });
  await expect(preAborted.verify(controller.signal)).rejects.toBeInstanceOf(
    JevError,
  );
  expect(preAbortedCalls).toBe(0);
});
test("Jev failures are categorized and malformed answer/usage matrices are rejected without retries", async () => {
  const candidate = [{ id: "s0", name: "x", description: "x" }];
  const context = { currentRequest: "x", recentText: "" };
  for (const [status, category] of [
    [401, "authentication"],
    [403, "authentication"],
    [500, "http"],
  ] as const) {
    let calls = 0;
    const client = new JevClient({
      apiKey: "ABCDEFGHIJKLMNOP",
      fetch: () => {
        calls++;
        return Promise.resolve(new Response("failure", { status }));
      },
    });
    await expect(client.judgeBatch(candidate, context)).rejects.toMatchObject({
      category,
    });
    expect(calls).toBe(1);
  }
  const malformed: unknown[] = [
    "not json",
    { answers: {} },
    {
      answers: {
        applicable_s0: { type: "noul", noul: 1 },
        extra: { type: "noul", noul: 0 },
      },
    },
    { answers: { applicable_s0: { type: "other", noul: 1 } } },
    { answers: { applicable_s0: { type: "noul", noul: Number.NaN } } },
    { answers: { applicable_s0: { type: "noul", noul: 2 } } },
    {
      answers: { applicable_s0: { type: "noul", noul: 1 } },
      usage: { input_tokens: -1 },
    },
  ];
  for (const value of malformed) {
    let calls = 0;
    const client = new JevClient({
      apiKey: "ABCDEFGHIJKLMNOP",
      fetch: () => {
        calls++;
        return Promise.resolve(
          value === "not json"
            ? new Response("{", { status: 200 })
            : Response.json(value),
        );
      },
    });
    await expect(client.judgeBatch(candidate, context)).rejects.toMatchObject({
      category: "malformed",
    });
    expect(calls).toBe(1);
  }
  let connectionCalls = 0;
  const connection = new JevClient({
    apiKey: "ABCDEFGHIJKLMNOP",
    fetch: () => {
      connectionCalls++;
      return Promise.reject(new Error("secret transport detail"));
    },
  });
  await expect(connection.judgeBatch(candidate, context)).rejects.toMatchObject(
    {
      category: "connection",
      message: "Jev connection failed",
    },
  );
  expect(connectionCalls).toBe(1);
});

test("Jev request and payload bounds fail before fetch", async () => {
  let calls = 0;
  const client = new JevClient({
    apiKey: "ABCDEFGHIJKLMNOP",
    fetch: () => {
      calls++;
      return Promise.resolve(Response.json({ answers: {} }));
    },
  });
  const context = { currentRequest: "x", recentText: "" };
  await expect(client.judgeBatch([], context)).rejects.toThrow("1 to 16");
  await expect(
    client.judgeBatch(
      Array.from({ length: 17 }, (_, index) => ({
        id: `s${index}`,
        name: "x",
        description: "x",
      })),
      context,
    ),
  ).rejects.toThrow("1 to 16");
  await expect(
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
