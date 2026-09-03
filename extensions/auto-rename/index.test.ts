import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import promptCommandsExtension from "../prompt-commands";
import autoRenameExtension from "./index";

type Handler = (event: any, ctx: any) => unknown;
type SessionModel = NonNullable<
  Parameters<typeof createAgentSession>[0]
>["model"];
interface Command {
  handler: (args: string, ctx: any) => unknown;
}

const FALLBACK_NAME_PATTERN = /^session-[0-9a-f]{8}$/;
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function completion(text = "Improve Session Naming Flow") {
  return Promise.resolve({
    stopReason: "stop",
    content: [{ type: "text", text }],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function settleBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function harness(
  options: {
    sessionId?: string | null;
    name?: string;
    hasUI?: boolean;
    branch?: any[];
    complete?: (...args: any[]) => Promise<any>;
    setSessionName?: (name: string) => void;
    config?: unknown | "malformed";
  } = {}
) {
  const home = mkdtempSync(join(tmpdir(), "auto-rename-"));
  homes.push(home);
  if (options.config !== undefined) {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "auto-rename.json"),
      options.config === "malformed" ? "{" : JSON.stringify(options.config)
    );
  }

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const notifications: Array<{ message: string; level: string }> = [];
  const writes: string[] = [];
  const calls: any[][] = [];
  let sessionId: string | null =
    options.sessionId === undefined ? "session-a" : options.sessionId;
  let name = options.name;
  let branch = options.branch ?? [];
  let leafId = "leaf-a";
  const complete = options.complete ?? (() => completion());
  const model = { provider: "mock", id: "active" };
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(commandName: string, registeredCommand: Command) {
      commands.set(commandName, registeredCommand);
    },
    getSessionName: () => name,
    setSessionName(next: string) {
      options.setSessionName?.(next);
      name = next;
      writes.push(next);
    },
  };
  const ctx = {
    hasUI: options.hasUI ?? true,
    mode: options.hasUI === false ? "print" : "tui",
    model,
    modelRegistry: {
      complete(...args: any[]) {
        calls.push(args);
        return complete(...args);
      },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
      getLeafId: () => leafId,
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    autoRenameExtension(pi as never);
  } finally {
    process.env.HOME = oldHome;
  }

  async function emit(event: string, payload: any = {}) {
    const old = process.env.HOME;
    process.env.HOME = home;
    try {
      return await handlers.get(event)?.({ type: event, ...payload }, ctx);
    } finally {
      process.env.HOME = old;
    }
  }
  async function command(args = "") {
    const old = process.env.HOME;
    process.env.HOME = home;
    try {
      return await commands.get("auto-rename")?.handler(args, ctx);
    } finally {
      process.env.HOME = old;
    }
  }

  return {
    calls,
    command,
    commands,
    ctx,
    emit,
    handlers,
    model,
    notifications,
    writes,
    get name() {
      return name;
    },
    setName(value: string | undefined) {
      name = value;
    },
    setSessionId(value: string | null) {
      sessionId = value;
    },
    setBranch(value: any[], leaf = leafId) {
      branch = value;
      leafId = leaf;
    },
  };
}

const user = (content: unknown) => ({
  type: "message",
  message: { role: "user", content },
});

async function start(h: ReturnType<typeof harness>, reason = "startup") {
  await h.emit("session_start", { reason });
}

async function input(
  h: ReturnType<typeof harness>,
  text: string,
  source = "interactive"
) {
  await h.emit("input", { text, source });
}

async function createRealSession(
  extensionFactories: Array<(pi: ExtensionAPI) => void>,
  additionalPromptTemplatePaths: string[] = [],
  sessionId?: string,
  model?: SessionModel
) {
  const directory = mkdtempSync(join(tmpdir(), "auto-rename-real-"));
  homes.push(directory);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    extensionFactories,
    additionalPromptTemplatePaths,
  });
  await loader.reload();
  const result = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader: loader,
    model,
    sessionManager: SessionManager.inMemory(
      directory,
      sessionId ? { id: sessionId } : undefined
    ),
    settingsManager,
  });
  await result.session.extensionRunner.emit({
    type: "session_start",
    reason: "startup",
  });
  return result.session;
}

async function disposeRealSession(
  session: Awaited<ReturnType<typeof createRealSession>>
): Promise<void> {
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  session.dispose();
}

describe("auto-rename prompt lifecycle", () => {
  it("restores the native prompt after composed extension shutdown", async () => {
    const originalPrompt = AgentSession.prototype.prompt;
    const session = await createRealSession(
      [promptCommandsExtension, autoRenameExtension],
      [join(import.meta.dir, "..", "..", "prompts")]
    );

    expect(AgentSession.prototype.prompt).not.toBe(originalPrompt);
    await disposeRealSession(session);
    await settleBackgroundWork();
    expect(AgentSession.prototype.prompt).toBe(originalPrompt);
  });

  it("restores native prompt after reload removes auto-rename", async () => {
    const originalPrompt = AgentSession.prototype.prompt;
    const composed = await createRealSession([
      promptCommandsExtension,
      autoRenameExtension,
    ]);
    await disposeRealSession(composed);

    const promptCommandsOnly = await createRealSession([
      promptCommandsExtension,
    ]);
    await disposeRealSession(promptCommandsOnly);
    await settleBackgroundWork();

    expect(AgentSession.prototype.prompt).toBe(originalPrompt);
  });

  it("names only the exact prompted session when IDs collide", async () => {
    const reviewCommand = (pi: ExtensionAPI) => {
      pi.registerCommand("review", {
        description: "Diagnostic review command",
        handler: () => Promise.resolve(),
      });
    };
    const first = await createRealSession(
      [autoRenameExtension, reviewCommand],
      [],
      "shared-session-id"
    );
    const second = await createRealSession(
      [autoRenameExtension, reviewCommand],
      [],
      "shared-session-id"
    );

    try {
      await first.prompt("/review uncommitted", { source: "rpc" });
      await settleBackgroundWork();

      expect(first.sessionName).toMatch(FALLBACK_NAME_PATTERN);
      expect(second.sessionName).toBeUndefined();
    } finally {
      await disposeRealSession(first);
      await disposeRealSession(second);
    }
  });

  it("does not name a rejected prompt or retain it as source", async () => {
    const session = await createRealSession([autoRenameExtension]);
    const queued: unknown[] = [];
    session.agent.steer = (message) => queued.push(message);
    (session as unknown as { _isAgentRunActive: boolean })._isAgentRunActive =
      true;

    try {
      await expect(
        session.prompt("rejected private prompt", { source: "rpc" })
      ).rejects.toThrow("streamingBehavior");
      await settleBackgroundWork();
      expect(session.sessionName).toBeUndefined();

      await session.prompt("accepted public prompt", {
        source: "rpc",
        streamingBehavior: "steer",
      });
      await settleBackgroundWork();
      expect(queued).toHaveLength(1);
      expect(session.sessionName).toMatch(FALLBACK_NAME_PATTERN);
    } finally {
      await disposeRealSession(session);
    }
  });

  it("names an extension command from its raw pre-dispatch prompt", async () => {
    let reviewRan = false;
    const reviewCommand = (pi: ExtensionAPI) => {
      pi.registerCommand("review", {
        description: "Diagnostic review command",
        handler: () => {
          reviewRan = true;
          return Promise.resolve();
        },
      });
    };
    const session = await createRealSession([
      autoRenameExtension,
      reviewCommand,
    ]);

    try {
      await session.prompt("/review uncommitted", { source: "rpc" });
      await settleBackgroundWork();

      expect(reviewRan).toBe(true);
      expect(session.sessionName).toMatch(FALLBACK_NAME_PATTERN);
    } finally {
      await disposeRealSession(session);
    }
  });

  it("ignores extension-origin prompts at the pre-dispatch seam", async () => {
    const session = await createRealSession([autoRenameExtension]);
    const queued: unknown[] = [];
    session.agent.steer = (message) => queued.push(message);
    (session as unknown as { _isAgentRunActive: boolean })._isAgentRunActive =
      true;

    try {
      await session.sendUserMessage("/review uncommitted", {
        deliverAs: "steer",
      });
      await settleBackgroundWork();

      expect(queued).toHaveLength(1);
      expect(session.sessionName).toBeUndefined();
    } finally {
      await disposeRealSession(session);
    }
  });

  it("names grill-me from raw text before its long-running agent settles", async () => {
    const namingSources: string[] = [];
    const namingSpy = (pi: ExtensionAPI) => {
      pi.on("session_start", (_event, ctx) => {
        const registry = ctx.modelRegistry as unknown as {
          complete: (_model: unknown, request: any) => Promise<any>;
        };
        registry.complete = (_model, request) => {
          namingSources.push(request.messages[0].content);
          return completion("Raw Grill Prompt Title");
        };
      });
    };
    const model = {
      provider: "test",
      id: "active",
      api: "test-api",
    } as SessionModel;
    const session = await createRealSession(
      [namingSpy, promptCommandsExtension, autoRenameExtension],
      [join(import.meta.dir, "..", "..", "prompts")],
      undefined,
      model
    );
    const queued: unknown[] = [];
    session.agent.steer = (message) => queued.push(message);
    (session as unknown as { _isAgentRunActive: boolean })._isAgentRunActive =
      true;

    try {
      await session.prompt("/grill-me test plan", {
        source: "rpc",
        streamingBehavior: "steer",
      });
      await settleBackgroundWork();

      expect(queued).toHaveLength(1);
      expect(namingSources).toEqual(["/grill-me test plan"]);
      expect(session.sessionName).toBe("Raw Grill Prompt Title");
    } finally {
      await disposeRealSession(session);
    }
  });
});

describe("auto-rename lifecycle", () => {
  it("does nothing on startup/resume/reload/fork and names a resumed session from its persisted first request", async () => {
    const h = harness({ branch: [user("Persisted old request")] });
    for (const reason of ["startup", "resume", "reload", "fork"]) {
      await start(h, reason);
      expect(h.calls).toHaveLength(0);
      expect(h.writes).toHaveLength(0);
    }
    await input(h, "New follow-up request");
    await h.emit("agent_settled");
    expect(h.calls[0]?.[1].messages[0].content).toBe("Persisted old request");
  });

  it("handles string or text-block persisted messages", async () => {
    const first = harness({ branch: [user("String fallback")] });
    await start(first);
    await first.emit("agent_settled");
    expect(first.calls[0]?.[1].messages[0].content).toBe("String fallback");

    const second = harness({
      branch: [
        user([{ type: "image" }, { type: "text", text: "Block fallback" }]),
      ],
    });
    await start(second);
    await second.emit("agent_settled");
    expect(second.calls[0]?.[1].messages[0].content).toBe("Block fallback");
  });

  it("preserves preexisting names and deduplicates repeated settled events", async () => {
    const named = harness({
      name: "Manual Existing Name",
      branch: [user("request")],
    });
    await start(named);
    await named.emit("agent_settled");
    expect(named.calls).toHaveLength(0);

    const h = harness({ branch: [user("request")] });
    await start(h);
    await Promise.all([
      h.emit("agent_settled"),
      h.emit("agent_settled"),
      h.emit("agent_settled"),
    ]);
    await h.emit("agent_settled");
    expect(h.calls).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
  });

  it("manual /name during generation blocks the automatic write", async () => {
    const wait = deferred<any>();
    const h = harness({
      branch: [user("request")],
      complete: () => wait.promise,
    });
    await start(h);
    const settling = h.emit("agent_settled");
    h.setName("Human Chosen Name");
    await h.emit("session_info_changed", { name: "Human Chosen Name" });
    wait.resolve(await completion());
    await settling;
    expect(h.name).toBe("Human Chosen Name");
    expect(h.writes).toHaveLength(0);
  });

  it("prevents stale writes after session ID change, shutdown, reload, and fork", async () => {
    for (const transition of ["id", "shutdown", "reload", "fork"] as const) {
      const wait = deferred<any>();
      const h = harness({
        branch: [user("request")],
        complete: () => wait.promise,
      });
      await start(h);
      const settling = h.emit("agent_settled");
      if (transition === "id") {
        h.setSessionId("session-b");
      }
      if (transition === "shutdown") {
        await h.emit("session_shutdown", { reason: "quit" });
      }
      if (transition === "reload") {
        await start(h, "reload");
      }
      if (transition === "fork") {
        await start(h, "fork");
      }
      wait.resolve(await completion());
      await settling;
      expect(h.writes).toHaveLength(0);
    }
  });

  it("tree navigation keeps the branch's persisted first request when a follow-up arrives before settlement", async () => {
    const h = harness({ branch: [user("first branch request")] });
    await start(h);
    h.setBranch([user("second branch request")], "leaf-b");
    await h.emit("session_tree", { newLeafId: "leaf-b" });
    await input(h, "later branch follow-up");
    expect(h.calls).toHaveLength(0);
    await h.emit("agent_settled");
    await h.emit("agent_settled");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.[1].messages[0].content).toBe("second branch request");
  });

  it("keeps an in-flight automatic title current when same-branch messages advance the leaf", async () => {
    const wait = deferred<any>();
    const h = harness({
      branch: [user("first request")],
      complete: () => wait.promise,
    });
    await start(h);

    await h.emit("agent_settled");
    h.setBranch(
      [user("first request"), user("same branch follow-up")],
      "advanced-leaf"
    );
    await h.emit("agent_settled");
    expect(h.calls).toHaveLength(1);

    wait.resolve(await completion("Stable Branch Title"));
    await settleBackgroundWork();
    expect(h.name).toBe("Stable Branch Title");

    await h.emit("agent_settled");
    expect(h.calls).toHaveLength(1);
  });

  it("returns from agent_settled before deferred automatic naming completes", async () => {
    const wait = deferred<any>();
    const h = harness({
      branch: [user("request")],
      complete: () => wait.promise,
    });
    await start(h);

    await h.emit("agent_settled");

    expect(h.calls).toHaveLength(1);
    expect(h.writes).toHaveLength(0);
    wait.resolve(await completion());
    await settleBackgroundWork();
    expect(h.name).toBe("Improve Session Naming Flow");
  });

  it("reports automatic persistence failure and retries the uncompleted branch", async () => {
    let attempts = 0;
    const h = harness({
      branch: [user("request")],
      setSessionName: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("private persistence detail");
        }
      },
    });
    await start(h);

    await h.emit("agent_settled");
    await settleBackgroundWork();
    expect(h.name).toBeUndefined();
    expect(h.writes).toHaveLength(0);
    expect(h.notifications).toEqual([
      {
        message: "Auto-rename could not save the session name.",
        level: "warning",
      },
    ]);
    expect(h.notifications[0]?.message).not.toContain("private");

    await h.emit("agent_settled");
    await settleBackgroundWork();
    expect(h.calls).toHaveLength(2);
    expect(attempts).toBe(2);
    expect(h.name).toBe("Improve Session Naming Flow");
  });

  it("uses deterministic fallback silently for expected model failure and stays headless-safe", async () => {
    const h = harness({
      hasUI: false,
      branch: [user("private prompt")],
      complete: () => Promise.reject(new Error("secret provider error")),
    });
    await start(h);
    await h.emit("agent_settled");
    await settleBackgroundWork();
    expect(h.name).toMatch(FALLBACK_NAME_PATTERN);
    expect(h.name).not.toContain("private");
    expect(h.notifications).toEqual([]);
  });
});

describe("/auto-rename command and configuration", () => {
  it("bare and status reload config and report only safe bounded state", async () => {
    const h = harness({
      name: "Current Name",
      config: {
        enabled: false,
        prompt: "TOP SECRET PROMPT",
        maxQueryLength: 123,
        maxNameLength: 44,
        timeoutMs: 555,
        debug: true,
      },
    });
    await start(h);
    await h.command();
    await h.command("status");
    expect(h.notifications).toHaveLength(2);
    for (const { message } of h.notifications) {
      expect(message).toContain("disabled");
      expect(message).toContain("Current Name");
      expect(message).toContain("pending: no");
      expect(message).toContain("maxQueryLength: 123");
      expect(message).toContain("maxNameLength: 44");
      expect(message).toContain("timeoutMs: 555");
      expect(message).toContain("debug: true");
      expect(message).not.toContain("TOP SECRET");
      expect(message).not.toContain("session-a");
      expect(message).not.toContain("source");
    }
  });

  it("reports pending and only the last failure category", async () => {
    const wait = deferred<any>();
    const h = harness({
      branch: [user("secret source")],
      complete: () => wait.promise,
    });
    await start(h);
    const settling = h.emit("agent_settled");
    await h.command("status");
    expect(h.notifications.at(-1)?.message).toContain("pending: yes");
    wait.resolve({ stopReason: "stop", content: [] });
    await settling;
    await settleBackgroundWork();
    await h.command("status");
    const status = h.notifications.at(-1)?.message ?? "";
    expect(status).toContain("last failure: empty-output");
    expect(status).not.toContain("secret source");
  });

  it("regen replaces an unchanged existing name using persisted source", async () => {
    const h = harness({
      name: "Existing Session Name",
      branch: [user("persisted")],
    });
    await start(h);
    await h.command("regen");
    expect(h.calls[0]?.[1].messages[0].content).toBe("persisted");
    expect(h.name).toBe("Improve Session Naming Flow");
  });

  it("regen preserves a concurrently changed name and guards session replacement", async () => {
    for (const change of ["name", "session"] as const) {
      const wait = deferred<any>();
      const h = harness({
        name: "Original Name",
        branch: [user("request")],
        complete: () => wait.promise,
      });
      await start(h);
      const regenerating = h.command("regen");
      if (change === "name") {
        h.setName("New Manual Name");
      } else {
        h.setSessionId("session-b");
      }
      wait.resolve(await completion());
      await regenerating;
      expect(h.writes).toHaveLength(0);
    }
  });

  it("regen reports missing source or session without changing the name", async () => {
    const noSource = harness({ name: "Keep Name" });
    await start(noSource);
    await noSource.command("regen");
    expect(noSource.notifications.at(-1)?.message).toContain("No user request");
    expect(noSource.name).toBe("Keep Name");

    const noSession = harness({
      sessionId: null,
      name: "Keep Name",
      branch: [user("request")],
    });
    await start(noSession);
    await noSession.command("regen");
    expect(noSession.notifications.at(-1)?.message).toContain(
      "No current session"
    );
    expect(noSession.name).toBe("Keep Name");
  });

  it("unsupported arguments return concise usage", async () => {
    const h = harness();
    await h.command("wat extra");
    expect(h.notifications).toEqual([
      { message: "Usage: /auto-rename [status|regen]", level: "warning" },
    ]);
  });

  it("invalid config disables naming and warns once in UI without leaking details", async () => {
    const h = harness({ config: "malformed", branch: [user("request")] });
    await start(h);
    await start(h, "reload");
    await h.emit("agent_settled");
    expect(h.calls).toHaveLength(0);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]?.message).toBe(
      "Auto-rename disabled: invalid global configuration."
    );
    await h.command("status");
    expect(h.notifications.at(-1)?.message).toContain("disabled-invalid");
  });

  it("invalid config warns once through concise console.warn when headless", async () => {
    const messages: string[] = [];
    const original = console.warn;
    console.warn = (message?: any) => messages.push(String(message));
    try {
      const h = harness({
        hasUI: false,
        config: { unknownSecretKey: "secret" },
      });
      await start(h);
      await start(h, "reload");
      expect(messages).toEqual(["auto-rename: disabled-invalid"]);
      expect(messages.join(" ")).not.toContain("unknownSecretKey");
      expect(h.notifications).toEqual([]);
    } finally {
      console.warn = original;
    }
  });

  it("disabled config and no session/source prevent automatic model calls", async () => {
    const disabled = harness({
      config: { enabled: false },
      branch: [user("request")],
    });
    await start(disabled);
    await disabled.emit("agent_settled");
    const noSession = harness({ sessionId: null, branch: [user("request")] });
    await start(noSession);
    await noSession.emit("agent_settled");
    const noSource = harness();
    await start(noSource);
    await noSource.emit("agent_settled");
    expect(disabled.calls).toHaveLength(0);
    expect(noSession.calls).toHaveLength(0);
    expect(noSource.calls).toHaveLength(0);
  });
});
