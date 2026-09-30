import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSyntheticSourceInfo,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { createSkillRouterExtension } from "./index";
import { identifyCanonicalMessages } from "./runtime-helpers";

type Handler = (event: any, ctx: any) => any;
const HASHED_IDENTITY = /^[a-f0-9]{64}:[01]$/u;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  options: {
    enabled?: boolean;
    judge?: (
      names: string[],
      context: any,
      signal?: AbortSignal,
    ) => Promise<Map<string, number>>;
    verify?: (signal?: AbortSignal) => Promise<void>;
    hasUI?: boolean;
    mode?: "tui" | "rpc" | "print";
    confirm?: boolean | boolean[];
    secret?: string | undefined;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "skill-router-runtime-"));
  roots.push(root);
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  const notifications: [string, string][] = [];
  const entries: any[] = [];
  const savedKeys: string[] = [];
  let enabled = options.enabled ?? false;
  let cleared = 0;
  let clientCreates = 0;
  let judgeCalls = 0;
  let loadCalls = 0;
  const configStore = {
    load: () => {
      loadCalls++;
      return Promise.resolve(enabled);
    },
    save: (value: boolean) => {
      enabled = value;
      return Promise.resolve();
    },
  };
  const credentialStore = {
    status: () =>
      Promise.resolve({ source: "stored" as const, usable: true as const }),
    resolve: () =>
      Promise.resolve({
        apiKey: "ABCDEFGHIJKLMNOP",
        source: "stored" as const,
      }),
    save: (key: string) => {
      savedKeys.push(key);
      return Promise.resolve();
    },
    clear: () => {
      cleared++;
      return Promise.resolve();
    },
  };
  const confirmations = Array.isArray(options.confirm)
    ? [...options.confirm]
    : undefined;
  const extension = createSkillRouterExtension({
    configStore,
    credentialStore,
    env: {},
    agentDir: root,
    deadlineMs: 100,
    readSecret: () => Promise.resolve(options.secret),
    createClient: () => {
      clientCreates++;
      return {
        judgeBatch: async (
          candidates: readonly any[],
          context: any,
          signal?: AbortSignal,
        ) => {
          judgeCalls++;
          const scores = options.judge
            ? await options.judge(
                candidates.map((candidate) => candidate.name),
                context,
                signal,
              )
            : new Map(candidates.map((candidate) => [candidate.name, 1]));
          return {
            scores: new Map(
              candidates.map((candidate) => [
                candidate.id,
                scores.get(candidate.name) ?? 0,
              ]),
            ),
          };
        },
        verify: options.verify ?? (() => Promise.resolve()),
      };
    },
  });
  extension({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => undefined;
    },
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    sendMessage: (message: any, sendOptions: any) =>
      sent.push({ message, sendOptions }),
  } as never);
  const ctx = {
    cwd: root,
    hasUI: options.hasUI ?? false,
    mode: options.mode ?? "rpc",
    sessionManager: {
      getSessionId: () => "session-1",
      buildContextEntries: () => entries,
    },
    ui: {
      notify: (message: string, level: string) =>
        notifications.push([message, level]),
      confirm: async () => confirmations?.shift() ?? options.confirm ?? false,
      custom: async () => options.secret,
    },
  };
  const skill = async (name: string, body = `BODY_${name}`, hidden = false) => {
    const baseDir = join(root, "skills", name);
    await mkdir(baseDir, { recursive: true });
    const filePath = join(baseDir, "SKILL.md");
    await writeFile(
      filePath,
      `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`,
    );
    return {
      name,
      description: `${name} description`,
      filePath,
      baseDir,
      sourceInfo: createSyntheticSourceInfo(baseDir, { source: "test" }),
      disableModelInvocation: hidden,
    } satisfies Skill;
  };
  const input = async (
    text: string,
    source: "interactive" | "rpc" | "extension" = "interactive",
    extra: Record<string, unknown> = {},
  ) => handlers.get("input")?.({ type: "input", text, source, ...extra }, ctx);
  const before = async (
    text: string,
    skills: Skill[],
    forceSystemPrompt?: string,
  ) => {
    const systemPromptOptions = {
      cwd: root,
      skills,
      selectedTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {},
      contextFiles: [],
      ...(forceSystemPrompt ? { forceSystemPrompt } : {}),
    };
    const result = await handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: `EXPANDED:${text}:SHOULD_NOT_LEAVE`,
        systemPrompt: forceSystemPrompt ?? "native prompt",
        systemPromptOptions,
      },
      ctx,
    );
    return { result, systemPromptOptions };
  };
  return {
    root,
    handlers,
    commands,
    sent,
    notifications,
    entries,
    savedKeys,
    configStore,
    credentialStore,
    ctx,
    skill,
    input,
    before,
    stats: () => ({ enabled, cleared, clientCreates, judgeCalls, loadCalls }),
  };
}

test("default-off and hard fallback paths preserve the effective catalog with zero routing network", async () => {
  const f = await fixture();
  const normal = await f.skill("normal");
  await f.input("please use normal");
  const disabled = await f.before("please use normal", [normal]);
  expect(disabled.systemPromptOptions.skills).toEqual([normal]);
  expect(disabled.result).toBeUndefined();
  expect(f.stats()).toMatchObject({ clientCreates: 0, judgeCalls: 0 });

  await f.configStore.save(true);
  await f.input("please execute this safely");
  const excludedMention = await f.before("please execute this safely", [
    normal,
  ]);
  expect(excludedMention.systemPromptOptions.skills).toEqual([normal]);
  await f.input("whatever");
  const forced = await f.before("whatever", [normal], "opaque inherited bytes");
  expect(forced.systemPromptOptions.forceSystemPrompt).toBe(
    "opaque inherited bytes",
  );
  expect(forced.systemPromptOptions.skills).toEqual([normal]);
  await f.input("anything");
  const empty = await f.before("anything", []);
  expect(empty.systemPromptOptions.skills).toEqual([]);
  expect(f.stats()).toMatchObject({ clientCreates: 0, judgeCalls: 0 });
});

test("routes from captured raw input and effective skills, replaces catalog, and injects canonical selected bodies", async () => {
  let observed: any;
  const f = await fixture({
    enabled: true,
    judge: (_names, context) => {
      observed = context;
      return Promise.resolve(
        new Map([
          ["added-by-extension", 1],
          ["disabled-native", 1],
        ]),
      );
    },
  });
  const added = await f.skill("added-by-extension", "SELECTED_BODY");
  const hidden = await f.skill("disabled-native", "HIDDEN_BODY", true);
  await f.input("raw private request");
  const routed = await f.before("raw private request", [added, hidden]);
  expect(observed.currentRequest).toBe("raw private request");
  expect(JSON.stringify(observed)).not.toContain("EXPANDED");
  expect(routed.systemPromptOptions.skills).toEqual([]);
  expect(routed.result.message.content).toContain("SELECTED_BODY");
  expect(routed.result.message.content).toContain(added.filePath);
  expect(routed.result.message.content).toContain(added.baseDir);
  expect(routed.result.message.content).not.toContain("HIDDEN_BODY");
  expect(routed.result.message.content).not.toContain("description:");
  expect(routed.result.message.details.skills[0]).toMatchObject({
    name: "added-by-extension",
    path: added.filePath,
  });
  expect(routed.result.message.content).toContain("recovery catalog");
  expect(f.stats().judgeCalls).toBe(1);
});

test("confident none suppresses the catalog while uncertainty, errors, and explicit invocation fall back", async () => {
  const none = await fixture({
    enabled: true,
    judge: async () => new Map([["x", 0]]),
  });
  const x = await none.skill("x");
  await none.input("ordinary");
  const selectedNone = await none.before("ordinary", [x]);
  expect(selectedNone.systemPromptOptions.skills).toEqual([]);
  expect(selectedNone.result.message.content).not.toContain("BODY_x");

  const uncertain = await fixture({
    enabled: true,
    judge: async () => new Map([["x", 0.5]]),
  });
  const ux = await uncertain.skill("x");
  await uncertain.input("ordinary");
  const fallback = await uncertain.before("ordinary", [ux]);
  expect(fallback.result).toBeUndefined();
  expect(fallback.systemPromptOptions.skills).toEqual([ux]);

  const failed = await fixture({
    enabled: true,
    judge: () => Promise.reject(new Error("secret response")),
  });
  const fx = await failed.skill("x");
  await failed.input("ordinary");
  const errorFallback = await failed.before("ordinary", [fx]);
  expect(errorFallback.systemPromptOptions.skills).toEqual([fx]);

  const explicit = await fixture({ enabled: true });
  const ex = await explicit.skill("x");
  await explicit.input("/skill:x exact args");
  const explicitFallback = await explicit.before("/skill:x exact args", [ex]);
  expect(explicitFallback.systemPromptOptions.skills).toEqual([ex]);
  expect(explicit.stats().judgeCalls).toBe(0);
});

test("outer deadline and revocation prevent late injection and later requests", async () => {
  let release: (() => void) | undefined;
  const deferred = new Promise<Map<string, number>>((resolve) => {
    release = () => resolve(new Map([["x", 1]]));
  });
  const f = await fixture({ enabled: true, judge: async () => deferred });
  const x = await f.skill("x");
  await f.input("request A");
  const running = f.before("request A", [x]);
  while (f.stats().judgeCalls === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await f.commands.get("skill-router").handler("disable", f.ctx);
  release?.();
  const stale = await running;
  expect(stale.result).toBeUndefined();
  expect(stale.systemPromptOptions.skills).toEqual([x]);
  await f.input("request B");
  await f.before("request B", [x]);
  expect(f.stats().judgeCalls).toBe(1);

  const hung = await fixture({
    enabled: true,
    judge: async () => new Promise(() => undefined),
  });
  const hx = await hung.skill("x");
  await hung.input("hang");
  const started = Date.now();
  const timedOut = await hung.before("hang", [hx]);
  expect(Date.now() - started).toBeLessThan(500);
  expect(timedOut.systemPromptOptions.skills).toEqual([hx]);
});

test("routing budget counts fresh requests rather than candidate judgments", async () => {
  const f = await fixture({
    enabled: true,
    judge: async (names) => new Map(names.map((name) => [name, 0])),
  });
  const skills = await Promise.all(
    Array.from({ length: 101 }, (_, index) => f.skill(`budget-${index}`)),
  );

  for (let request = 1; request <= 100; request++) {
    await f.input(`budget request ${request}`);
    const routed = await f.before(`budget request ${request}`, skills);
    expect(routed.systemPromptOptions.skills).toEqual([]);
    expect(routed.result).toBeDefined();
  }
  const callsAfterBudget = f.stats().judgeCalls;
  expect(callsAfterBudget).toBeGreaterThan(100);

  await f.input("budget request 101");
  const fallback = await f.before("budget request 101", skills);
  expect(fallback.systemPromptOptions.skills).toEqual(skills);
  expect(fallback.result).toBeUndefined();
  expect(f.stats().judgeCalls).toBe(callsAfterBudget);
});

test("queued request receives a stable identity-anchored fallback prefix without mutating canonical history", async () => {
  const f = await fixture({ enabled: true });
  const x = await f.skill("x");
  await f.input("request A");
  const routed = await f.before("request A", [x]);
  expect(routed.systemPromptOptions.skills).toEqual([]);
  await f.input("queued B", "interactive", { streamingBehavior: "followUp" });
  const canonical = [
    { role: "user", content: "request A", timestamp: 1 },
    {
      role: "custom",
      customType: "skill-router-selected",
      content: routed.result.message.content,
      details: routed.result.message.details,
      display: false,
      timestamp: 2,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "answer A" }],
      timestamp: 3,
    },
    { role: "user", content: "EXPANDED queued B", timestamp: 4 },
  ];
  const first = await f.handlers.get("context")?.(
    { type: "context", messages: canonical },
    f.ctx,
  );
  const withTool = [
    ...canonical,
    {
      role: "assistant",
      content: [{ type: "text", text: "calling" }],
      timestamp: 5,
    },
    {
      role: "toolResult",
      content: [{ type: "text", text: "secret tool output" }],
      timestamp: 6,
    },
  ];
  const second = await f.handlers.get("context")?.(
    { type: "context", messages: withTool },
    f.ctx,
  );
  await f.handlers.get("agent_settled")?.({ type: "agent_settled" }, f.ctx);
  const later = await f.handlers.get("context")?.(
    {
      type: "context",
      messages: [
        ...withTool,
        { role: "assistant", content: "done", timestamp: 7 },
        { role: "user", content: "later fresh", timestamp: 8 },
      ],
    },
    f.ctx,
  );
  expect(canonical).toHaveLength(4);
  expect(withTool).toHaveLength(6);
  const fallback = (result: any) =>
    result.messages.find(
      (message: any) => message.customType === "skill-router-native-fallback",
    );
  const firstFallback = fallback(first);
  expect(firstFallback).toEqual(fallback(second));
  expect(firstFallback).toEqual(fallback(later));
  for (const result of [first, second, later]) {
    expect(result.messages.indexOf(fallback(result))).toBe(
      result.messages.findIndex(
        (message: any) => message.content === "EXPANDED queued B",
      ) - 1,
    );
  }
  expect(JSON.stringify(firstFallback)).toContain("<available_skills>");
  expect(JSON.stringify(firstFallback)).toContain("x");
});

test.each(["disable", "logout"])(
  "%s preserves queued native fallback after successful routing",
  async (action) => {
    const f = await fixture({ enabled: true });
    const x = await f.skill("x");
    await f.input("request A");
    const routed = await f.before("request A", [x]);
    expect(routed.systemPromptOptions.skills).toEqual([]);

    await f.commands.get("skill-router").handler(action, f.ctx);
    await f.input("queued B", "interactive", { streamingBehavior: "followUp" });
    const projected = await f.handlers.get("context")?.(
      {
        type: "context",
        messages: [
          { role: "user", content: "request A", timestamp: 1 },
          {
            role: "custom",
            customType: "skill-router-selected",
            content: routed.result.message.content,
            details: routed.result.message.details,
            display: false,
            timestamp: 2,
          },
          { role: "assistant", content: "answer A", timestamp: 3 },
          { role: "user", content: "EXPANDED queued B", timestamp: 4 },
        ],
      },
      f.ctx,
    );

    const fallbackIndex = projected.messages.findIndex(
      (message: any) => message.customType === "skill-router-native-fallback",
    );
    const queuedIndex = projected.messages.findIndex(
      (message: any) => message.content === "EXPANDED queued B",
    );
    expect(fallbackIndex).toBe(queuedIndex - 1);
    expect(projected.messages[fallbackIndex].content).toContain(
      "<available_skills>",
    );
    expect(projected.messages[fallbackIndex].content).toContain("x");
    expect(f.stats()).toMatchObject({
      enabled: false,
      cleared: action === "logout" ? 1 : 0,
    });
  },
);

test("recent context is current-branch plain user/assistant text only and visible body provenance deduplicates until compaction", async () => {
  let recent = "";
  const f = await fixture({
    enabled: true,
    judge: (_names, context) => {
      recent = context.recentText;
      return Promise.resolve(new Map([["x", 1]]));
    },
  });
  const x = await f.skill("x", "ONE_BODY");
  await f.input("safe old user");
  const prior = await f.before("safe old user", [x]);
  f.entries.push(
    { type: "message", message: { role: "user", content: "safe old user" } },
    {
      type: "message",
      message: { role: "user", content: "resumed unsafe expanded body" },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "plain assistant" },
          { type: "thinking", thinking: "reasoning" },
        ],
      },
    },
    { type: "custom_message", customType: "other", content: "custom secret" },
    {
      type: "message",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "tool secret" }],
      },
    },
  );
  f.entries.push({
    type: "custom_message",
    customType: "skill-router-selected",
    content: prior.result.message.content,
    details: prior.result.message.details,
  });
  await f.input("new current");
  const deduped = await f.before("new current", [x]);
  expect(recent).toContain("safe old user");
  expect(recent).toContain("plain assistant");
  expect(recent).not.toContain("resumed unsafe");
  expect(recent).not.toContain("reasoning");
  expect(recent).not.toContain("custom secret");
  expect(recent).not.toContain("tool secret");
  expect(deduped.result.message.content).not.toContain("ONE_BODY");

  f.entries.splice(0);
  await f.handlers.get("session_compact")?.({ type: "session_compact" }, f.ctx);
  await f.input("after compact");
  const reinjected = await f.before("after compact", [x]);
  expect(reinjected.result.message.content).toContain("ONE_BODY");
});

test("selected body deduplication requires matching source provenance", async () => {
  const f = await fixture({ enabled: true });
  const first = await f.skill("first", "IDENTICAL_BODY");
  const second = await f.skill("second", "IDENTICAL_BODY");
  await f.input("first request");
  const selectedFirst = await f.before("first request", [first]);
  f.entries.push({
    type: "custom_message",
    customType: "skill-router-selected",
    content: selectedFirst.result.message.content,
    details: selectedFirst.result.message.details,
  });

  await f.input("different source");
  const differentSource = await f.before("different source", [second]);
  expect(differentSource.result.message.content).toContain("IDENTICAL_BODY");
  expect(differentSource.result.message.content).toContain(second.filePath);

  await f.input("same source");
  const sameSource = await f.before("same source", [first]);
  expect(sameSource.result.message.content).not.toContain("IDENTICAL_BODY");
});

test("raw input provenance cannot shift across handled, fallback, or queued inputs", async () => {
  const classified: string[] = [];
  const f = await fixture({
    enabled: true,
    judge: (names, context) => {
      classified.push(context.currentRequest);
      return Promise.resolve(new Map(names.map((name) => [name, 0])));
    },
  });
  const x = await f.skill("x");

  await f.input("handled A");
  await f.input("fresh B");
  await f.before("fresh B", [x]);
  expect(classified).toEqual(["fresh B"]);

  await f.input("empty catalog input");
  await f.before("empty catalog input", []);
  await f.input("fresh C");
  await f.before("fresh C", [x]);
  expect(classified.at(-1)).toBe("fresh C");

  await f.input("forced input");
  await f.before("forced input", [x], "forced");
  await f.input("fresh D");
  await f.before("fresh D", [x]);
  expect(classified.at(-1)).toBe("fresh D");

  await f.input("deferred A");
  await f.input("queued B", "interactive", { streamingBehavior: "followUp" });
  await f.before("deferred A", [x]);
  expect(classified.at(-1)).toBe("deferred A");

  const calls = f.stats().judgeCalls;
  await f.input("x".repeat(9000));
  await f.before("oversized", [x]);
  expect(f.stats().judgeCalls).toBe(calls);
});

test("compaction restores a frozen body as stable provider-only history across later routes", async () => {
  const f = await fixture({ enabled: true });
  const x = await f.skill("x", "COMPACTION_BODY");
  await f.input("route");
  const routed = await f.before("route", [x]);
  expect(routed.result.message.content).toContain("COMPACTION_BODY");
  f.entries.push({
    type: "custom_message",
    customType: "skill-router-selected",
    content: routed.result.message.content,
    details: routed.result.message.details,
  });
  await f.input("route again");
  const deduplicated = await f.before("route again", [x]);
  expect(deduplicated.result.message.content).not.toContain("COMPACTION_BODY");

  f.entries.splice(0);
  await f.handlers.get("session_compact")?.({ type: "session_compact" }, f.ctx);
  const compacted = [
    { role: "system", content: "system", timestamp: 1 },
    { role: "user", content: "retained", timestamp: 2 },
  ];
  const compactedSnapshot = structuredClone(compacted);
  const first = await f.handlers.get("context")?.(
    { type: "context", messages: compacted },
    f.ctx,
  );
  const continued = [
    ...compacted,
    {
      role: "assistant",
      content: [{ type: "text", text: "tool" }],
      timestamp: 3,
    },
  ];
  const continuedSnapshot = structuredClone(continued);
  const second = await f.handlers.get("context")?.(
    { type: "context", messages: continued },
    f.ctx,
  );
  const injected = (result: any) =>
    result?.messages.find(
      (message: any) =>
        message.customType === "skill-router-selected" &&
        String(message.content).includes("COMPACTION_BODY"),
    );
  const recovered = injected(first);
  const recoveredIndex = first.messages.indexOf(recovered);
  expect(recovered).toBeDefined();
  expect(recovered).toEqual(injected(second));
  expect(second.messages.indexOf(injected(second))).toBe(recoveredIndex);
  expect(compacted).toEqual(compactedSnapshot);
  expect(continued).toEqual(continuedSnapshot);

  await f.handlers.get("agent_settled")?.({ type: "agent_settled" }, f.ctx);
  await f.input("same skill fresh");
  const fresh = await f.before("same skill fresh", [x]);
  expect(fresh.result.message.content).not.toContain("COMPACTION_BODY");
  const afterFreshCanonical = [
    ...continued,
    { role: "user", content: "same skill fresh", timestamp: 4 },
    {
      role: "custom",
      customType: "skill-router-selected",
      content: fresh.result.message.content,
      details: fresh.result.message.details,
      display: false,
      timestamp: 5,
    },
  ];
  const afterFresh = await f.handlers.get("context")?.(
    { type: "context", messages: afterFreshCanonical },
    f.ctx,
  );
  expect(injected(afterFresh)).toEqual(recovered);
  expect(afterFresh.messages.indexOf(injected(afterFresh))).toBe(
    recoveredIndex,
  );
  expect(
    afterFresh.messages.filter((message: any) =>
      String(message.content).includes("COMPACTION_BODY"),
    ),
  ).toHaveLength(1);

  await f.handlers.get("agent_settled")?.({ type: "agent_settled" }, f.ctx);
  await f.configStore.save(false);
  await f.input("disabled fresh");
  const fallback = await f.before("disabled fresh", [x]);
  expect(fallback.result).toBeUndefined();
  expect(fallback.systemPromptOptions.skills).toEqual([x]);
  const disabledCanonical = [
    ...afterFreshCanonical,
    { role: "user", content: "disabled fresh", timestamp: 6 },
  ];
  const afterFallback = await f.handlers.get("context")?.(
    { type: "context", messages: disabledCanonical },
    f.ctx,
  );
  expect(injected(afterFallback)).toEqual(recovered);
  expect(afterFallback.messages.indexOf(injected(afterFallback))).toBe(
    recoveredIndex,
  );
  expect(compacted).toEqual(compactedSnapshot);
  expect(continued).toEqual(continuedSnapshot);

  await f.handlers.get("session_tree")?.({ type: "session_tree" }, f.ctx);
  expect(
    await f.handlers.get("context")?.(
      { type: "context", messages: compacted },
      f.ctx,
    ),
  ).toBeUndefined();
});

test("retained recovered bodies preserve old source content when the skill changes", async () => {
  const f = await fixture({ enabled: true });
  const oldSkill = await f.skill("x", "OLD_RECOVERED_BODY");
  await f.input("old route");
  const oldRoute = await f.before("old route", [oldSkill]);
  f.entries.push({
    type: "custom_message",
    customType: "skill-router-selected",
    content: oldRoute.result.message.content,
    details: oldRoute.result.message.details,
  });
  await f.input("deduplicate old route");
  await f.before("deduplicate old route", [oldSkill]);
  f.entries.splice(0);
  await f.handlers.get("session_compact")?.({ type: "session_compact" }, f.ctx);
  const compacted = [{ role: "user", content: "retained", timestamp: 1 }];
  const recovered = await f.handlers.get("context")?.(
    { type: "context", messages: compacted },
    f.ctx,
  );
  expect(JSON.stringify(recovered.messages)).toContain("OLD_RECOVERED_BODY");

  const changedSkill = await f.skill("x", "NEW_SOURCE_BODY");
  await f.input("changed route");
  const changed = await f.before("changed route", [changedSkill]);
  expect(changed.result.message.content).toContain("NEW_SOURCE_BODY");
  const canonicalWithChangedBody = [
    ...compacted,
    { role: "user", content: "changed route", timestamp: 2 },
    {
      role: "custom",
      customType: "skill-router-selected",
      content: changed.result.message.content,
      details: changed.result.message.details,
      display: false,
      timestamp: 3,
    },
  ];
  const projected = await f.handlers.get("context")?.(
    { type: "context", messages: canonicalWithChangedBody },
    f.ctx,
  );
  const visible = JSON.stringify(projected.messages);
  expect(visible).toContain("OLD_RECOVERED_BODY");
  expect(visible).toContain("NEW_SOURCE_BODY");
  expect(compacted).toEqual([
    { role: "user", content: "retained", timestamp: 1 },
  ]);
});

test("observed user identities are pruned to the visible canonical branch", async () => {
  const f = await fixture({ enabled: true });
  const x = await f.skill("x");
  await f.input("route");
  const routed = await f.before("route", [x]);
  const selected = {
    role: "custom",
    customType: "skill-router-selected",
    content: routed.result.message.content,
    details: routed.result.message.details,
    display: false,
    timestamp: 2,
  };
  const repeatedUser = { role: "user", content: "same", timestamp: 1 };
  await f.handlers.get("context")?.(
    { type: "context", messages: [repeatedUser, selected] },
    f.ctx,
  );
  const otherBranch = await f.handlers.get("context")?.(
    {
      type: "context",
      messages: [{ role: "user", content: "other", timestamp: 3 }, selected],
    },
    f.ctx,
  );
  expect(
    otherBranch.messages.filter(
      (message: any) => message.customType === "skill-router-native-fallback",
    ),
  ).toHaveLength(1);

  const returnedIdentity = await f.handlers.get("context")?.(
    { type: "context", messages: [repeatedUser, selected] },
    f.ctx,
  );
  expect(
    returnedIdentity.messages.filter(
      (message: any) => message.customType === "skill-router-native-fallback",
    ),
  ).toHaveLength(1);
});

test("canonical identities are bounded digests with deterministic duplicate occurrences", () => {
  const image = `data:image/png;base64,${"A".repeat(2_000_000)}`;
  const repeatedImage = {
    role: "user",
    timestamp: 7,
    content: [{ type: "image", data: image, mimeType: "image/png" }],
  };
  const messages = [
    repeatedImage,
    structuredClone(repeatedImage),
    { role: "user", timestamp: 7, content: "same text" },
    { role: "user", timestamp: 7, content: "same text" },
  ];

  const first = identifyCanonicalMessages(messages);
  const second = identifyCanonicalMessages(messages);
  expect(first).toEqual(second);
  expect(new Set(first.map((message) => message.identity)).size).toBe(4);
  expect(first.map((message) => message.identity.slice(-2))).toEqual([
    ":0",
    ":1",
    ":0",
    ":1",
  ]);
  for (const message of first) {
    expect(message.identity).toMatch(HASHED_IDENTITY);
    expect(message.identity).not.toContain("data:image");
    expect(message.identity).not.toContain("same text");
  }
});

test("inactive context handling does not inspect canonical message content", async () => {
  const f = await fixture();
  const message = {
    role: "user",
    timestamp: 1,
    get content(): never {
      throw new Error("inactive router inspected content");
    },
  };

  expect(
    await f.handlers.get("context")?.(
      { type: "context", messages: [message] },
      f.ctx,
    ),
  ).toBeUndefined();
});

test("management UX separates login and consent, blocks headless grants, and sanitizes failures", async () => {
  const headless = await fixture({
    enabled: false,
    secret: "ABCDEFGHIJKLMNOP",
  });
  await headless.commands.get("skill-router").handler("login", headless.ctx);
  await headless.commands.get("skill-router").handler("enable", headless.ctx);
  expect(headless.savedKeys).toEqual([]);
  expect(headless.stats().enabled).toBe(false);
  expect(headless.stats().clientCreates).toBe(0);
  expect(
    headless.sent.every((item) => item.sendOptions.triggerTurn === false),
  ).toBe(true);

  const declined = await fixture({
    hasUI: true,
    mode: "tui",
    confirm: [true, false],
    secret: "ABCDEFGHIJKLMNOP",
  });
  await declined.commands.get("skill-router").handler("login", declined.ctx);
  expect(declined.savedKeys).toEqual(["ABCDEFGHIJKLMNOP"]);
  expect(declined.stats().enabled).toBe(false);
  await declined.commands.get("skill-router").handler("enable", declined.ctx);
  expect(declined.stats().enabled).toBe(false);

  const invalid = await fixture({ hasUI: true, mode: "tui", secret: "short" });
  await invalid.commands.get("skill-router").handler("login", invalid.ctx);
  expect(invalid.savedKeys).toEqual([]);
  expect(JSON.stringify(invalid.notifications)).not.toContain("short");

  let releaseVerification: (() => void) | undefined;
  const verification = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });
  const cancelled = await fixture({
    hasUI: true,
    mode: "tui",
    confirm: true,
    secret: "ABCDEFGHIJKLMNOP",
    verify: () => verification,
  });
  const login = cancelled.commands
    .get("skill-router")
    .handler("login", cancelled.ctx);
  while (cancelled.stats().clientCreates === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await cancelled.commands
    .get("skill-router")
    .handler("disable", cancelled.ctx);
  releaseVerification?.();
  await login;
  expect(cancelled.savedKeys).toEqual([]);

  await declined.commands.get("skill-router").handler("logout", declined.ctx);
  expect(declined.stats()).toMatchObject({ enabled: false, cleared: 1 });
});
