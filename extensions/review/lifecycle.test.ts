import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import reviewExtension from "./index";
import { ReviewRunController } from "./lifecycle";
import { mockChildren, plan, reviewer } from "./test-fixtures";
import type { ReviewWorkflowResult } from "./workflow";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture(onCall?: Parameters<typeof mockChildren>[1]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-lifecycle-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "target.txt"), "original");
  let sessionManager = SessionManager.inMemory(root);
  const origin = sessionManager.appendCustomEntry("fixture-origin", {});
  sessionManager.appendCustomEntry("fixture-anchor", {});
  const parent = new AbortController();
  const children = mockChildren(
    [reviewer("code-reviewer", []), reviewer("code-reviewer", [])],
    onCall,
  );
  const ctx = {
    cwd: root,
    hasUI: false,
    mode: "rpc",
    signal: parent.signal,
    isIdle: () => true,
    scopedModels: [],
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionId: () => sessionManager.getSessionId(),
      getLeafId: () => sessionManager.getLeafId(),
      getEntries: () => sessionManager.getEntries(),
      getBranch: () => sessionManager.getBranch(),
    },
    ui: { notify() {}, confirm: async () => false },
    executeTool: children.executeTool,
  };
  const controller = new ReviewRunController();
  const savedPlan = structuredClone(plan);
  const target = { type: "folder" as const, paths: ["target.txt"] };
  const prepared = await controller.prepare(ctx as never, target, savedPlan);
  const published: ReviewWorkflowResult[] = [];
  const run = (id = prepared.id, signal?: AbortSignal) =>
    controller.run(id, ctx as never, signal);
  const finalize = (id = prepared.id, signal?: AbortSignal) =>
    controller.finalize(
      id,
      ctx as never,
      (result) => {
        published.push(result);
      },
      signal,
    );
  return {
    root,
    ctx,
    parent,
    children,
    controller,
    prepared,
    savedPlan,
    target,
    published,
    run,
    finalize,
    switchSession: () => {
      sessionManager = SessionManager.inMemory(root);
    },
    switchBranch: () => {
      sessionManager.branch(origin);
    },
  };
}

test("prepared plans and target are cloned, raw captures private and publication is once", async () => {
  const f = await fixture();
  f.savedPlan.reviewerPanel = [
    { model: "attacker/model", thinkingLevel: "low" },
  ];
  f.target.paths[0] = "missing";
  expect(Object.keys(f.prepared)).toEqual(["id"]);
  await f.run();
  expect(f.children.calls.map(({ model }) => model)).toEqual([
    "test/alpha",
    "test/beta",
  ]);
  for (const captured of f.children.outcomes) {
    captured.result.structuredContent = { report: "forged" };
  }
  await f.finalize();
  expect(f.published).toHaveLength(1);
  expect(f.published[0]?.verifier.verdict).toBe("correct");
  expect(f.finalize()).rejects.toThrow();
  expect(f.run()).rejects.toThrow();
});
test("unknown IDs and another controller's prepared ID cannot run or finalize", async () => {
  const f = await fixture();
  const other = await fixture();
  for (const id of [randomUUID(), other.prepared.id]) {
    expect(f.run(id)).rejects.toThrow("Unknown");
    expect(f.finalize(id)).rejects.toThrow("Unknown");
  }
  expect(f.children.calls).toEqual([]);
  expect(f.published).toEqual([]);
});
test("assistant-authored completion is not readiness", async () => {
  const f = await fixture();
  expect(f.finalize()).rejects.toThrow("not ready");
  expect(f.published).toEqual([]);
});
test("one-shot execution rejects concurrent and completed redispatch", async () => {
  const f = await fixture(async () => {
    await Bun.sleep(5);
  });
  const first = f.run();
  expect(f.run()).rejects.toThrow("already dispatched");
  await first;
  expect(f.run()).rejects.toThrow("already dispatched");
  expect(f.children.calls).toHaveLength(2);
});
test("concurrent finalization has one publication", async () => {
  const f = await fixture();
  await f.run();
  const results = await Promise.allSettled([f.finalize(), f.finalize()]);
  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  expect(f.published).toHaveLength(1);
});
for (const fault of [
  "cancel",
  "parent-abort",
  "tool-abort",
  "session",
  "cwd",
  "branch",
  "stale",
]) {
  test(`fails closed before execution: ${fault}`, async () => {
    const f = await fixture();
    let signal: AbortSignal | undefined;
    if (fault === "cancel") {
      f.controller.cancel();
    }
    if (fault === "parent-abort") {
      f.parent.abort();
    }
    if (fault === "tool-abort") {
      signal = AbortSignal.abort();
    }
    if (fault === "session") {
      f.switchSession();
    }
    if (fault === "cwd") {
      f.ctx.cwd = os.tmpdir();
    }
    if (fault === "branch") {
      f.switchBranch();
    }
    if (fault === "stale") {
      await fs.writeFile(path.join(f.root, "target.txt"), "changed");
    }
    expect(f.run(f.prepared.id, signal)).rejects.toThrow();
    expect(f.finalize()).rejects.toThrow();
    expect(f.children.calls).toEqual([]);
    expect(f.published).toEqual([]);
  });
  test(`fails closed after completed execution: ${fault}`, async () => {
    const f = await fixture();
    await f.run();
    let signal: AbortSignal | undefined;
    if (fault === "cancel") {
      f.controller.cancel();
    }
    if (fault === "parent-abort") {
      f.parent.abort();
    }
    if (fault === "tool-abort") {
      signal = AbortSignal.abort();
    }
    if (fault === "session") {
      f.switchSession();
    }
    if (fault === "cwd") {
      f.ctx.cwd = os.tmpdir();
    }
    if (fault === "branch") {
      f.switchBranch();
    }
    if (fault === "stale") {
      await fs.writeFile(path.join(f.root, "target.txt"), "changed");
    }
    expect(f.finalize(f.prepared.id, signal)).rejects.toThrow();
    expect(f.published).toEqual([]);
  });
}
test("target mutation during child calls prevents capture readiness", async () => {
  const f = await fixture(async (_params, index) => {
    if (index === 0) {
      await fs.writeFile(path.join(f.root, "target.txt"), "changed");
    }
  });
  expect(f.run()).rejects.toThrow("stale");
  expect(f.finalize()).rejects.toThrow();
  expect(f.published).toEqual([]);
});
test("cancel aborts only review-owned children, settles them, and requires fresh prepare", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const signals: AbortSignal[] = [];
  const f = await fixture(async (_params, index, signal) => {
    signals.push(signal!);
    if (index === 1) {
      entered();
    }
    await new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const unrelated = new AbortController();
  const running = f.run();
  const failure = running.catch((error: unknown) => error);
  await started;
  f.controller.cancel();
  await f.controller.settle();
  expect(await failure).toBeInstanceOf(Error);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(unrelated.signal.aborted).toBe(false);
  expect(f.parent.signal.aborted).toBe(false);
  expect(f.finalize()).rejects.toThrow();
  const fresh = await f.controller.prepare(
    f.ctx as never,
    { type: "folder", paths: ["target.txt"] },
    plan,
  );
  expect(fresh.id).not.toBe(f.prepared.id);
});
for (const fault of ["cancel", "branch", "abort", "session"]) {
  test(`invalidates during asynchronous finalization: ${fault}`, async () => {
    const f = await fixture();
    await f.run();
    const finalizing = f.finalize();
    if (fault === "cancel") {
      f.controller.cancel();
    }
    if (fault === "branch") {
      f.switchBranch();
    }
    if (fault === "abort") {
      f.parent.abort();
    }
    if (fault === "session") {
      f.switchSession();
    }
    expect(finalizing).rejects.toThrow();
    expect(f.published).toEqual([]);
  });
}

type EventHandler = (event: unknown, ctx: unknown) => unknown;
interface Tool {
  name: string;
  parameters: {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
  };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: AgentToolUpdateCallback | undefined,
    ctx: unknown,
  ) => Promise<unknown>;
}
async function extensionFixture() {
  const f = await fixture();
  const events = new Map<string, EventHandler>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const tools = new Map<string, Tool>();
  const handoffs: string[] = [];
  const messages: Array<{
    customType: string;
    content: string;
    details: Record<string, unknown>;
  }> = [];
  reviewExtension({
    on: (name: string, handler: EventHandler) => events.set(name, handler),
    registerCommand: (
      name: string,
      definition: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => commands.set(name, definition),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerMessageRenderer() {},
    appendEntry() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    sendUserMessage: (text: string) => handoffs.push(text),
    sendMessage: (message: (typeof messages)[number]) => {
      messages.push(message);
    },
  } as never);
  await commands
    .get("review")!
    .handler(
      "folder target.txt --reviewers code-reviewer --reviewer-models test/alpha=medium,test/beta=high --synthesizer-model test/synth --verifier-model test/verify",
      f.ctx,
    );
  const id = handoffs[0]?.match(
    /review_run\(\{runId: "([a-f0-9-]+)"\}\)/u,
  )?.[1];
  expect(id).toBeDefined();
  const run = (params: Record<string, unknown> = { runId: id }) =>
    tools
      .get("review_run")!
      .execute("run", params, undefined, undefined, f.ctx);
  const finalize = (params: Record<string, unknown> = { runId: id }) =>
    tools
      .get("review_finalize")!
      .execute("finalize", params, undefined, undefined, f.ctx);
  return {
    ...f,
    tools,
    events,
    commands,
    handoffs,
    messages,
    id,
    run,
    finalize,
  };
}
test("closed handoff runs blocking children then publishes the preserved report contract", async () => {
  const f = await extensionFixture();
  expect(f.handoffs[0]?.length).toBeLessThan(1000);
  expect(f.handoffs[0]).toContain(`review_finalize({runId: "${f.id}"})`);
  expect(f.handoffs[0]).not.toContain("SubagentWorkflow");
  expect(f.events.has("tool_call")).toBe(false);
  expect(f.events.has("tool_result")).toBe(false);
  for (const name of ["review_run", "review_finalize"]) {
    expect(f.tools.get(name)?.parameters.additionalProperties).toBe(false);
    expect(Object.keys(f.tools.get(name)?.parameters.properties ?? {})).toEqual(
      ["runId"],
    );
  }
  expect(f.finalize()).rejects.toThrow("not ready");
  await f.run();
  expect(f.messages).toEqual([]);
  await f.finalize();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]?.customType).toBe("review-report");
  expect(Object.keys(f.messages[0]?.details ?? {}).sort()).toEqual([
    "coverage",
    "report",
    "reviewers",
    "verifier",
  ]);
  expect(f.run()).rejects.toThrow();
  expect(f.finalize()).rejects.toThrow();
});
for (const key of ["script", "model", "results", "rawJson", "resultPath"]) {
  test(`tool boundary rejects raw payload injection: ${key}`, async () => {
    const f = await extensionFixture();
    const params = { runId: f.id, [key]: "forged" };
    expect(f.run(params)).rejects.toThrow("Invalid review_run arguments");
    expect(f.finalize(params)).rejects.toThrow(
      "Invalid review_finalize arguments",
    );
    expect(f.children.calls).toEqual([]);
    expect(f.messages).toEqual([]);
  });
}
for (const event of [
  "session_shutdown",
  "session_start",
  "session_tree",
  "session_before_tree",
  "session_before_switch",
  "session_before_fork",
  "user_bash",
]) {
  test(`extension lifecycle invalidates publication: ${event}`, async () => {
    const f = await extensionFixture();
    await f.run();
    await f.events.get(event)?.({}, f.ctx);
    expect(f.finalize()).rejects.toThrow();
    expect(f.messages).toEqual([]);
  });
}
test("/review cancel and non-extension user input invalidate completed captures", async () => {
  for (const mode of ["command", "input"]) {
    const f = await extensionFixture();
    await f.run();
    if (mode === "command") {
      await f.commands.get("review")!.handler("cancel", f.ctx);
    } else {
      await f.events.get("input")?.(
        { source: "rpc", text: "other work" },
        f.ctx,
      );
    }
    expect(f.finalize()).rejects.toThrow();
    expect(f.messages).toEqual([]);
  }
});

test("aborting the run's tool signal after completion still invalidates pending publication", async () => {
  const f = await fixture();
  const tool = new AbortController();
  await f.run(f.prepared.id, tool.signal);
  tool.abort();
  expect(f.finalize()).rejects.toThrow();
  expect(f.published).toEqual([]);
});
