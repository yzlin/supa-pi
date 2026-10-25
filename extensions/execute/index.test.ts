import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXECUTE_DRAFT_MESSAGE,
  EXECUTE_DRAFT_SOURCE_LABEL,
  EXECUTE_INVOCATION_PREAMBLE,
  EXECUTE_SYNTHESIS_MESSAGE,
  SPEC_DRAFTED_ENTRY_TYPE,
} from "./constants";
import executeExtension from "./index";
import { emptyLedger, LEDGER_ENTRY_TYPE, transitionLedger } from "./ledger";
import { renderSpecStatus, validSlug } from "./spec-log";

const reviewedEvent = {
  event: "reviewed",
  ts: "2026-10-25T12:00:00.000Z",
  hash: "a".repeat(64),
  round: 1,
  trigger: { source: "fallback", dcCount: 9, reason: "no consent" },
  decision: "accept",
  answers: [],
  findings: 0,
};
const acceptedEvent = {
  event: "accepted",
  ts: "2026-10-25T12:00:00.000Z",
  hash: "a".repeat(64),
  invocationId: "invocation",
  assignments: [{ id: "a", dependencies: [] }],
};

const EXECUTION_BRIEF = [
  "# Execution Brief",
  "## Execution Scope\nShip it",
  "## Plan\n- Implement it",
  "## Done Criteria\n- Done",
  "## Verification\n- Test it",
  "## Out of Scope\n- Anything else",
].join("\n\n");

function createMockCtx(
  branchEntries: unknown[] = [],
  {
    cwd = "/workspace",
    hasUI = false,
    choice,
  }: { cwd?: string; hasUI?: boolean; choice?: string } = {},
) {
  const notifications: Array<{ message: string; level: string }> = [];
  const selections: Array<{ title: string; options: string[] }> = [];

  return {
    notifications,
    selections,
    ctx: {
      cwd,
      hasUI,
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "session",
        getBranch() {
          return branchEntries;
        },
        getEntries() {
          throw new Error("Must not read all entries");
        },
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        select(title: string, options: string[]) {
          selections.push({ title, options });
          return Promise.resolve(choice);
        },
      },
    },
  };
}

function createMockPiRuntime() {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> | void }
  >();
  const tools = new Map<string, unknown>();
  const hooks = new Map<string, unknown>();
  const entries: Array<{ type: string; customType: string; data: unknown }> =
    [];
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
  const displayedMessages: Array<{
    customType: string;
    content: string;
    display: boolean;
  }> = [];

  return {
    entries,
    commands,
    tools,
    hooks,
    sentUserMessages,
    displayedMessages,
    pi: {
      sendMessage(message: {
        customType: string;
        content: string;
        display: boolean;
      }) {
        displayedMessages.push(message);
      },
      appendEntry(customType: string, data: unknown) {
        entries.push({ type: "custom", customType, data });
      },
      registerCommand(
        name: string,
        definition: {
          handler: (args: string, ctx: unknown) => Promise<void> | void;
        },
      ) {
        commands.set(name, definition);
      },
      registerTool(definition: { name: string }) {
        tools.set(definition.name, definition);
      },
      on(event: string, handler: unknown) {
        hooks.set(event, handler);
      },
      sendUserMessage(content: string, options?: unknown) {
        sentUserMessages.push({ content, options });
      },
    },
  };
}

function invocationSuffix(
  runtime: ReturnType<typeof createMockPiRuntime>,
): string {
  const suffix = runtime.sentUserMessages[0]?.content.match(
    /\n\nExecution checkpoint invocationId: [a-f0-9-]{36}$/,
  )?.[0];
  if (!suffix) {
    throw new Error("Expected session-scoped invocation token");
  }
  return suffix;
}

async function runExecuteCommand(
  runtime: ReturnType<typeof createMockPiRuntime>,
  args: string,
  ctx: unknown,
): Promise<void> {
  const handler = runtime.commands.get("execute")?.handler;

  if (!handler) {
    throw new Error("Expected execute command handler");
  }

  await handler(args, ctx);
}

describe("execute command", () => {
  it("preserves image-bearing parent input while drafting requirements instead of forwarding history", async () => {
    const runtime = createMockPiRuntime();
    const imageMessage = {
      role: "user",
      content: [
        { type: "image" },
        { type: "text", text: "Implement the pictured UI" },
      ],
    };
    const branch = [
      {
        type: "message",
        message: { role: "assistant", content: EXECUTION_BRIEF },
      },
      { type: "message", message: imageMessage },
    ];
    const before = structuredClone(branch);
    const { ctx } = createMockCtx(branch);
    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "", ctx);
    expect(runtime.sentUserMessages[0]?.content).toBe(
      `${EXECUTE_DRAFT_MESSAGE}${invocationSuffix(runtime)}`,
    );
    expect(runtime.sentUserMessages[0]?.content).toContain("attached images");
    expect(branch).toEqual(before);
    expect(runtime.hooks.has("input")).toBe(false);
  });

  it("ignores incomplete briefs and non-text content", async () => {
    for (const content of [
      EXECUTION_BRIEF.replace("## Verification", "## Not Verification"),
      [{ type: "image" }],
      [{ type: "text" }],
    ]) {
      const runtime = createMockPiRuntime();
      const { ctx } = createMockCtx([
        { type: "message", message: { role: "assistant", content } },
      ]);
      executeExtension(runtime.pi as never);
      await runExecuteCommand(runtime, "", ctx);
      expect(runtime.sentUserMessages[0]?.content).toBe(
        `${EXECUTE_DRAFT_MESSAGE}${invocationSuffix(runtime)}`,
      );
    }
  });

  it("sends an explicit plan packet immediately when idle", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "implement @plan.md", ctx);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\nimplement @plan.md\n</plan>${invocationSuffix(runtime)}`,
        options: undefined,
      },
    ]);
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "This explicit `/execute` invocation authorizes blocking `subagent` calls",
    );
    expect(notifications).toEqual([]);
  });

  it("queues the same packet as a follow-up when busy", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "implement @plan.md", {
      ...ctx,
      isIdle: () => false,
    });

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\nimplement @plan.md\n</plan>${invocationSuffix(runtime)}`,
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toEqual([
      { message: "Queued /execute as a follow-up", level: "info" },
    ]);
  });

  it("drafts a Spec from the latest fresh assistant Execution Brief", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: EXECUTION_BRIEF }],
        },
      },
    ]);

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_DRAFT_MESSAGE}\n${EXECUTE_DRAFT_SOURCE_LABEL}\n\n<execution-brief>\n${EXECUTION_BRIEF}\n</execution-brief>${invocationSuffix(runtime)}`,
        options: undefined,
      },
    ]);
  });

  it("drafts without the brief when a later user message makes it stale", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([
      {
        type: "message",
        message: { role: "assistant", content: EXECUTION_BRIEF },
      },
      {
        type: "message",
        message: { role: "user", content: "Actually, include settings too" },
      },
    ]);

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expect(runtime.sentUserMessages[0]?.content).toBe(
      `${EXECUTE_DRAFT_MESSAGE}${invocationSuffix(runtime)}`,
    );
  });

  it("drafts a Spec when no usable brief exists", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx();

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expect(runtime.sentUserMessages[0]?.content).toBe(
      `${EXECUTE_DRAFT_MESSAGE}${invocationSuffix(runtime)}`,
    );
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "follow the `to-spec` skill",
    );
  });

  it("registers only the narrow checkpoint and branch lifecycle hooks", () => {
    const runtime = createMockPiRuntime();

    executeExtension(runtime.pi as never);

    expect([...runtime.commands.keys()]).toEqual(["execute", "to-spec"]);
    expect([...runtime.tools.keys()]).toEqual(["execute_checkpoint"]);
    expect(runtime.hooks.has("session_start")).toBe(true);
    expect(runtime.hooks.has("session_tree")).toBe(true);
  });
});

const temporaryWorkspaces: string[] = [];
afterEach(() => {
  for (const directory of temporaryWorkspaces.splice(0)) {
    execFileSync("trash", [directory]);
  }
});

function specCommandHarness() {
  const cwd = mkdtempSync(join(tmpdir(), "to-spec-command-"));
  temporaryWorkspaces.push(cwd);
  mkdirSync(join(cwd, ".pi/specs"), { recursive: true });
  const runtime = createMockPiRuntime();
  const { ctx, notifications } = createMockCtx();
  executeExtension(runtime.pi as never);
  const handler = runtime.commands.get("to-spec")?.handler;
  if (!handler) {
    throw new Error("Missing to-spec command");
  }
  return { runtime, ctx: { ...ctx, cwd }, notifications, handler };
}

describe("to-spec command", () => {
  it("renders multiline status without a model turn", async () => {
    const h = specCommandHarness();
    writeFileSync(join(h.ctx.cwd, ".pi/specs/goal.md"), "Brief");
    for (const args of ["status", "status goal"]) {
      await h.handler(args, h.ctx);
      expect(h.runtime.displayedMessages.at(-1)).toEqual({
        customType: "spec-status",
        content: renderSpecStatus(
          h.ctx.cwd,
          args === "status" ? undefined : "goal",
        ),
        display: true,
      });
    }
    expect(h.runtime.sentUserMessages).toEqual([]);
    expect(h.runtime.entries).toEqual([]);
  });

  it("sends canonical packets with derived or explicit slugs and instructions", async () => {
    for (const [args, content] of [
      [
        "",
        "Use the `to-spec` skill as canonical for this explicit command.\n\nSlug: derive one from the goal",
      ],
      [
        "goal",
        "Use the `to-spec` skill as canonical for this explicit command.\n\nSlug: goal",
      ],
      [
        "goal Keep tests\non boundary",
        "Use the `to-spec` skill as canonical for this explicit command.\n\nSlug: goal\n\nKeep tests\non boundary",
      ],
    ]) {
      const h = specCommandHarness();
      await h.handler(args, h.ctx);
      expect(h.runtime.sentUserMessages).toEqual([
        { content, options: undefined },
      ]);
      expect(h.notifications).toEqual([]);
      expect(h.runtime.entries).toEqual([]);
    }
  });

  it("queues packets while busy", async () => {
    const h = specCommandHarness();
    await h.handler("goal", { ...h.ctx, isIdle: () => false });
    expect(h.runtime.sentUserMessages[0]?.options).toEqual({
      deliverAs: "followUp",
    });
    expect(h.notifications).toEqual([
      { message: "Queued /to-spec as a follow-up", level: "info" },
    ]);
  });

  it("refuses a corrupt log, failing closed as accepted", async () => {
    for (const content of ["corrupt\n"]) {
      const h = specCommandHarness();
      writeFileSync(join(h.ctx.cwd, ".pi/specs/goal.log.jsonl"), content);
      await h.handler("goal", h.ctx);
      expect(h.runtime.sentUserMessages).toEqual([]);
      expect(h.notifications).toEqual([
        {
          message: "Spec goal was already accepted; choose a new slug",
          level: "error",
        },
      ]);
    }
  });

  it("includes the overwrite-confirmation note for an unaccepted Spec", async () => {
    const h = specCommandHarness();
    writeFileSync(join(h.ctx.cwd, ".pi/specs/goal.md"), "Brief");
    await h.handler("goal Extra instructions", h.ctx);
    expect(h.runtime.sentUserMessages[0]?.content).toBe(
      "Use the `to-spec` skill as canonical for this explicit command.\n\nSlug: goal\n\nExisting unaccepted Spec: .pi/specs/goal.md — confirm overwrite with the user before writing.\n\nExtra instructions",
    );
  });

  it("treats a reviewed-only log as unaccepted and refuses once accepted", async () => {
    const h = specCommandHarness();
    writeFileSync(join(h.ctx.cwd, ".pi/specs/goal.md"), "Brief");
    const logPath = join(h.ctx.cwd, ".pi/specs/goal.log.jsonl");
    writeFileSync(logPath, `${JSON.stringify(reviewedEvent)}\n`);
    await h.handler("goal", h.ctx);
    expect(h.notifications).toEqual([]);
    expect(h.runtime.sentUserMessages[0]?.content).toContain(
      "Existing unaccepted Spec: .pi/specs/goal.md",
    );
    writeFileSync(
      logPath,
      `${JSON.stringify(reviewedEvent)}\n${JSON.stringify(acceptedEvent)}\n`,
    );
    await h.handler("goal", h.ctx);
    expect(h.runtime.sentUserMessages).toHaveLength(1);
    expect(h.notifications).toEqual([
      {
        message: "Spec goal was already accepted; choose a new slug",
        level: "error",
      },
    ]);
  });

  it("rejects reserved subcommand words as slugs", () => {
    expect(validSlug("status")).toBe(false);
    expect(validSlug("classifier")).toBe(false);
    expect(validSlug("classifiers")).toBe(true);
  });
});

describe("to-spec classifier consent", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
  function consentHarness({
    hasUI = true,
    confirm = true,
    models = [{ provider: "typesafe", id: "jev-latest" }] as unknown[],
    registryError = undefined as Error | undefined,
  } = {}) {
    const h = specCommandHarness();
    const agentDir = mkdtempSync(join(tmpdir(), "to-spec-agent-"));
    temporaryWorkspaces.push(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const confirms: string[][] = [];
    const ctx = {
      ...h.ctx,
      hasUI,
      modelRegistry: {
        getAvailableOfType: () =>
          registryError
            ? Promise.reject(registryError)
            : Promise.resolve(models),
        classify: () => Promise.reject(new Error("Must not classify")),
      },
      ui: {
        ...h.ctx.ui,
        confirm: (title: string, message: string) => {
          confirms.push([title, message]);
          return Promise.resolve(confirm);
        },
      },
    };
    const configPath = join(agentDir, "spec-review/config.json");
    return { ...h, ctx, confirms, configPath };
  }

  it("shows status, enables only after UI confirmation naming the model, and disables", async () => {
    const h = consentHarness();
    await h.handler("classifier", h.ctx);
    expect(h.notifications.at(-1)).toEqual({
      message: "Spec review classifier disabled; model=typesafe/jev-latest",
      level: "info",
    });
    await h.handler("classifier enable", h.ctx);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]?.[1]).toContain("typesafe/jev-latest");
    expect(h.confirms[0]?.[1]).toContain("full text will leave this machine");
    expect(JSON.parse(readFileSync(h.configPath, "utf8"))).toEqual({
      enabled: true,
    });
    await h.handler("classifier", h.ctx);
    expect(h.notifications.at(-1)?.message).toBe(
      "Spec review classifier enabled; model=typesafe/jev-latest",
    );
    await h.handler("classifier disable", h.ctx);
    expect(JSON.parse(readFileSync(h.configPath, "utf8"))).toEqual({
      enabled: false,
    });
    await h.handler("classifier bogus", h.ctx);
    expect(h.notifications.at(-1)).toEqual({
      message: "Usage: /to-spec classifier [enable|disable]",
      level: "error",
    });
    expect(h.runtime.sentUserMessages).toEqual([]);
  });

  it("refuses enable when declined, without UI or without a model", async () => {
    for (const options of [
      { confirm: false },
      { hasUI: false },
      { models: [{ provider: "x", id: "gpt" }] },
    ]) {
      const h = consentHarness(options);
      await h.handler("classifier enable", h.ctx);
      expect(existsSync(h.configPath)).toBe(false);
      expect(h.confirms).toHaveLength(options.confirm === false ? 1 : 0);
    }
    const none = consentHarness({ models: [] });
    await none.handler("classifier", none.ctx);
    expect(none.notifications.at(-1)?.message).toBe(
      "Spec review classifier disabled; model=none",
    );
    await none.handler("classifier enable", none.ctx);
    expect(none.notifications.at(-1)).toEqual({
      message:
        "No credentialed Jev classifier is available; Spec review classifier stays disabled.",
      level: "error",
    });
  });

  it("reports registry failures instead of a missing model", async () => {
    const h = consentHarness({ registryError: new Error("auth expired") });
    await h.handler("classifier", h.ctx);
    expect(h.notifications.at(-1)).toEqual({
      message:
        "Spec review classifier disabled; model=none (registry error: auth expired)",
      level: "info",
    });
    await h.handler("classifier enable", h.ctx);
    expect(h.notifications.at(-1)).toEqual({
      message:
        "Spec review classifier registry failed: auth expired; Spec review classifier stays disabled.",
      level: "error",
    });
    expect(h.confirms).toHaveLength(0);
    expect(existsSync(h.configPath)).toBe(false);
  });

  it("reports invalid or unsafe config as disabled", async () => {
    for (const [content, mode] of [
      ["{bad", 0o600],
      [JSON.stringify({ enabled: true }), 0o644],
    ] as const) {
      const h = consentHarness();
      mkdirSync(join(h.configPath, ".."), { mode: 0o700 });
      writeFileSync(h.configPath, content, { mode });
      chmodSync(h.configPath, mode);
      await h.handler("classifier", h.ctx);
      expect(h.notifications.at(-1)?.message).toStartWith(
        "Spec review classifier disabled (",
      );
    }
  });

  it("refuses invalid and oversized slugs without sending", async () => {
    const h = specCommandHarness();
    for (const slug of ["Upper", "../goal", "-goal", "a_b", "a".repeat(49)]) {
      await h.handler(slug, h.ctx);
      expect(h.notifications.at(-1)).toMatchObject({ level: "error" });
    }
    expect(h.runtime.sentUserMessages).toEqual([]);
  });
});

const brief = {
  type: "message",
  message: { role: "assistant", content: EXECUTION_BRIEF },
};
const userMessage = {
  type: "message",
  message: { role: "user", content: "Also cover settings" },
};
function marker(slug = "goal") {
  return {
    type: "custom",
    customType: SPEC_DRAFTED_ENTRY_TYPE,
    data: { slug },
  };
}
function ledgerEntry(specPath?: string, complete = false) {
  const accepted = transitionLedger(
    emptyLedger("session", "old-invocation"),
    {
      invocationId: "old-invocation",
      action: "accept",
      plan: "Canonical plan",
      approval: "Safe",
      ...(specPath ? { specPath } : {}),
      assignments: [
        {
          id: "a",
          task: "Implement A",
          scope: ["src/a.ts"],
          dependencies: [],
          ...(specPath ? { criteria: ["DC-1"] } : {}),
        },
      ],
    },
    "attempt",
    complete ? { verified: ["a"], blocked: {}, priorRepairs: {} } : undefined,
    specPath ? ["DC-1"] : undefined,
  );
  const data = complete
    ? transitionLedger(accepted, {
        invocationId: "old-invocation",
        action: "verify",
        assignmentId: "a",
        passed: true,
        evidence: ["bun test: exit 0"],
        blockers: [],
        criteria: [{ id: "DC-1", evidence: "bun test: exit 0" }],
      })
    : accepted;
  return { type: "custom", customType: LEDGER_ENTRY_TYPE, data };
}

async function runBareExecute(
  branch: unknown[],
  {
    hasUI = false,
    choice,
    files = ["goal.md"],
    logs = {},
  }: {
    hasUI?: boolean;
    choice?: string;
    files?: string[];
    logs?: Record<string, unknown[]>;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "execute-command-"));
  temporaryWorkspaces.push(cwd);
  mkdirSync(join(cwd, ".pi/specs"), { recursive: true });
  for (const file of files) {
    writeFileSync(join(cwd, ".pi/specs", file), "# Execution Brief\n");
  }
  for (const [slug, events] of Object.entries(logs)) {
    writeFileSync(
      join(cwd, ".pi/specs", `${slug}.log.jsonl`),
      events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    );
  }
  const runtime = createMockPiRuntime();
  const mock = createMockCtx(branch, { cwd, hasUI, choice });
  executeExtension(runtime.pi as never);
  await runExecuteCommand(runtime, "", mock.ctx);
  const content = runtime.sentUserMessages[0]?.content;
  return {
    ...mock,
    runtime,
    content,
    planPacket: (plan: string) =>
      `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\n${plan}\n</plan>${invocationSuffix(runtime)}`,
    draftPacket: () => `${EXECUTE_DRAFT_MESSAGE}${invocationSuffix(runtime)}`,
  };
}

describe("bare execute Spec resolution", () => {
  it("runs a drafted Spec when no user message followed its marker", async () => {
    const result = await runBareExecute([userMessage, marker(), brief]);
    expect(result.content).toBe(result.planPacket("@.pi/specs/goal.md"));
    expect(result.selections).toEqual([]);
  });

  it("asks with UI when user messages followed the marker", async () => {
    const branch = [marker(), userMessage];
    const use = await runBareExecute(branch, {
      hasUI: true,
      choice: "Use .pi/specs/goal.md",
    });
    expect(use.selections).toEqual([
      {
        title:
          "Messages followed the drafted Spec. Run it or draft a new Spec?",
        options: ["Use .pi/specs/goal.md", "Draft a new Spec"],
      },
    ]);
    expect(use.content).toBe(use.planPacket("@.pi/specs/goal.md"));

    const draft = await runBareExecute(branch, {
      hasUI: true,
      choice: "Draft a new Spec",
    });
    expect(draft.content).toBe(draft.draftPacket());

    const cancelled = await runBareExecute(branch, { hasUI: true });
    expect(cancelled.runtime.sentUserMessages).toEqual([]);
    expect(cancelled.notifications).toEqual([
      { message: "/execute cancelled", level: "info" },
    ]);
  });

  it("drafts a new Spec without UI when user messages followed the marker", async () => {
    const result = await runBareExecute([marker(), userMessage]);
    expect(result.selections).toEqual([]);
    expect(result.content).toBe(result.draftPacket());
  });

  it("ignores markers whose Spec is missing or already accepted", async () => {
    for (const files of [[], ["goal.md", "goal.log.jsonl"]]) {
      const result = await runBareExecute([marker()], { files });
      expect(result.content).toBe(result.draftPacket());
    }
  });

  it("runs a drafted Spec whose log has only reviewed events", async () => {
    const result = await runBareExecute([marker()], {
      files: ["goal.md"],
      logs: { goal: [reviewedEvent] },
    });
    expect(result.content).toBe(result.planPacket("@.pi/specs/goal.md"));
    const accepted = await runBareExecute([marker()], {
      files: ["goal.md"],
      logs: { goal: [reviewedEvent, acceptedEvent] },
    });
    expect(accepted.content).toBe(accepted.draftPacket());
  });

  it("uses the latest usable marker and skips later unusable ones", async () => {
    const result = await runBareExecute([marker(), marker("gone")]);
    expect(result.content).toBe(result.planPacket("@.pi/specs/goal.md"));
  });

  it("ignores markers outside the current branch", async () => {
    const result = await runBareExecute([brief]);
    expect(result.content).toBe(
      `${EXECUTE_DRAFT_MESSAGE}\n${EXECUTE_DRAFT_SOURCE_LABEL}\n\n<execution-brief>\n${EXECUTION_BRIEF}\n</execution-brief>${invocationSuffix(result.runtime)}`,
    );
  });

  it("resumes an unfinished branch ledger Spec before markers", async () => {
    const result = await runBareExecute([
      marker(),
      ledgerEntry(".pi/specs/other.md"),
      userMessage,
    ]);
    expect(result.content).toBe(result.planPacket("@.pi/specs/other.md"));
  });

  it("keeps brief reuse or synthesis for an unfinished non-Spec ledger plan", async () => {
    const reused = await runBareExecute([marker(), ledgerEntry(), brief]);
    expect(reused.content).toBe(reused.planPacket(EXECUTION_BRIEF));

    const synthesized = await runBareExecute([
      marker(),
      ledgerEntry(),
      brief,
      userMessage,
    ]);
    expect(synthesized.content).toBe(
      `${EXECUTE_SYNTHESIS_MESSAGE}${invocationSuffix(synthesized.runtime)}`,
    );
  });

  it("falls back to today's behavior when the branch ledger is unreadable", async () => {
    const result = await runBareExecute([
      marker(),
      { type: "custom", customType: LEDGER_ENTRY_TYPE },
    ]);
    expect(result.content).toBe(
      `${EXECUTE_SYNTHESIS_MESSAGE}${invocationSuffix(result.runtime)}`,
    );
  });

  it("does not resume a completed Spec ledger", async () => {
    const result = await runBareExecute([
      ledgerEntry(".pi/specs/other.md", true),
      marker(),
    ]);
    expect(result.content).toBe(result.planPacket("@.pi/specs/goal.md"));
  });

  it("keeps explicit-argument packets unchanged with a marker", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([marker()]);
    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "@.pi/specs/other.md", ctx);
    expect(runtime.sentUserMessages[0]?.content).toBe(
      `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\n@.pi/specs/other.md\n</plan>${invocationSuffix(runtime)}`,
    );
  });
});

describe("execute documentation contract", () => {
  it("documents native workflow dispatch and main-session verification", () => {
    const skill = readFileSync(
      join(import.meta.dir, "../../skills/execute/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("subagent({");
    expect(skill).toContain("execute_checkpoint");
    expect(skill).toContain("StructuredOutput");
    expect(skill).toContain("conservative danger preflight");
    expect(skill).toContain("explicit user approval");
    expect(skill).toContain(
      "main session still performs independent verification",
    );
    expect(skill).not.toMatch(
      /SubagentWorkflow|TaskCreate|TaskUpdate|@tintinweb/,
    );
  });
});
