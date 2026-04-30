import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildContextDocsMessage,
  buildContextDocsPrompt,
  buildSessionEvidencePacket,
  classifyContextDocNote,
  default as contextDocsExtension,
  detectSecret,
  getContextDocsArgumentCompletions,
  matchNaturalLanguageInput,
  planMarkedBlockUpdate,
  reachesContextMapThreshold,
  shouldInjectContextDocsReminder,
} from "./index";
import { parseContextDocsArgs } from "./parse";

function createHarness(confirmResult = true) {
  const commands = new Map<
    string,
    {
      handler: (...args: any[]) => unknown;
      getArgumentCompletions?: (prefix: string) => unknown;
    }
  >();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];

  const pi = {
    registerCommand(
      name: string,
      options: {
        handler: (...args: any[]) => unknown;
        getArgumentCompletions?: (prefix: string) => unknown;
      }
    ) {
      commands.set(name, options);
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
    sendUserMessage(content: unknown, options?: unknown) {
      sentUserMessages.push({ content, options });
    },
  };

  const notifications: Array<{ message: string; level: string }> = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      async confirm(title: string, message: string) {
        confirms.push({ title, message });
        return confirmResult;
      },
    },
  };

  contextDocsExtension(pi as never);

  return {
    commands,
    handlers,
    sentUserMessages,
    notifications,
    confirms,
    ctx,
  };
}

describe("context-docs parsing", () => {
  it("parses adr arguments deterministically", () => {
    const parsed = parseContextDocsArgs(
      "adr",
      "./extensions --title 'Use context docs' --status accepted -- Record decisions",
      process.cwd()
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value).toMatchObject({
      command: "adr",
      workflow: "adr",
      targetRoot: path.join(process.cwd(), "extensions"),
      targetLabel: "./extensions",
      instruction: "Record decisions",
      options: {
        title: "Use context docs",
        status: "accepted",
      },
    });
  });

  it("rejects ambiguous freeform arguments", () => {
    const parsed = parseContextDocsArgs(
      "context-review",
      "./extensions extra",
      process.cwd()
    );

    expect(parsed).toEqual({
      ok: false,
      error:
        "Ambiguous arguments. Use '/context-review <target> -- <instruction>' for freeform text.",
    });
  });

  it("requires note text for context-note", () => {
    const parsed = parseContextDocsArgs("context-note", "", process.cwd());

    expect(parsed).toEqual({
      ok: false,
      error: "/context-note requires note text after '--'.",
    });
  });

  it("rejects targets outside the current project root", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "context-docs-"));
    const child = path.join(parent, "child");
    fs.mkdirSync(child);

    try {
      const parsed = parseContextDocsArgs(
        "context-review",
        ".. -- Check parent docs",
        child
      );

      expect(parsed).toEqual({
        ok: false,
        error: "Target path must stay inside current project: ..",
      });
    } finally {
      fs.rmSync(parent, { force: true, recursive: true });
    }
  });
});

describe("context-docs command registration", () => {
  it("registers all public commands", () => {
    const harness = createHarness();

    expect([...harness.commands.keys()].sort()).toEqual([
      "adr",
      "context-grill",
      "context-note",
      "context-review",
      "context-setup",
    ]);
  });

  it("sends a normalized prompt immediately when idle", async () => {
    const harness = createHarness();
    const command = harness.commands.get("context-review");

    await command?.handler(
      "./extensions --scope all -- Check stale docs",
      harness.ctx
    );

    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.sentUserMessages[0]?.options).toBeUndefined();
    expect(String(harness.sentUserMessages[0]?.content)).toContain(
      "Resolved command input:"
    );
    expect(String(harness.sentUserMessages[0]?.content)).toContain(
      "- command: /context-review"
    );
    expect(String(harness.sentUserMessages[0]?.content)).toContain(
      `- target root: ${path.join(process.cwd(), "extensions")}`
    );
    expect(String(harness.sentUserMessages[0]?.content)).toContain(
      "- scope: all"
    );
  });

  it("queues a follow-up prompt when busy", async () => {
    const harness = createHarness();
    const command = harness.commands.get("context-setup");

    await command?.handler("./extensions --dry-run", {
      ...harness.ctx,
      isIdle: () => false,
    });

    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.sentUserMessages[0]?.options).toEqual({
      deliverAs: "followUp",
    });
    expect(harness.notifications).toEqual([
      {
        message: "Queued /context-setup as a follow-up",
        level: "info",
      },
    ]);
  });

  it("warns and does not send on invalid input", async () => {
    const harness = createHarness();
    const command = harness.commands.get("adr");

    await command?.handler("--status unknown -- Decide", harness.ctx);

    expect(harness.sentUserMessages).toEqual([]);
    expect(harness.notifications).toEqual([
      {
        message:
          "--status must be one of: proposed, accepted, superseded, deprecated, rejected.",
        level: "warning",
      },
    ]);
  });

  it("refuses secret-bearing command prompts", async () => {
    const harness = createHarness();
    const command = harness.commands.get("context-note");

    await command?.handler("-- token=super-secret-token-value", harness.ctx);

    expect(harness.sentUserMessages).toEqual([]);
    expect(harness.notifications).toEqual([
      {
        message: "Refusing context-docs prompt: possible assigned secret.",
        level: "warning",
      },
    ]);
  });
});

describe("context-docs completions", () => {
  it("suggests flags and target directories at the root", () => {
    const completions = getContextDocsArgumentCompletions(
      "context-setup",
      "",
      process.cwd()
    );

    expect(completions).toContainEqual(
      expect.objectContaining({ value: "--dry-run", label: "--dry-run" })
    );
    expect(completions).toContainEqual(
      expect.objectContaining({ value: "extensions/", label: "extensions/" })
    );
  });

  it("suggests enum values for value flags", () => {
    const completions = getContextDocsArgumentCompletions(
      "adr",
      "--status a",
      process.cwd()
    );

    expect(completions).toEqual([{ value: "accepted", label: "accepted" }]);
  });

  it("stops completing after freeform instruction separator", () => {
    const completions = getContextDocsArgumentCompletions(
      "context-grill",
      "-- architecture",
      process.cwd()
    );

    expect(completions).toBeNull();
  });
});

describe("context-docs natural-language interception", () => {
  it("matches only clear prefixes", () => {
    expect(matchNaturalLanguageInput("context note: remember this")).toEqual({
      command: "context-note",
      instruction: "remember this",
    });
    expect(matchNaturalLanguageInput("Take note that use Bun tests")).toEqual({
      command: "context-note",
      instruction: "use Bun tests",
    });
    expect(
      matchNaturalLanguageInput("Remember that CONTEXT.md is product language")
    ).toEqual({
      command: "context-note",
      instruction: "CONTEXT.md is product language",
    });
    expect(
      matchNaturalLanguageInput("Record that ADRs capture tradeoffs")
    ).toEqual({
      command: "context-note",
      instruction: "ADRs capture tradeoffs",
    });
    expect(matchNaturalLanguageInput("please write an adr")).toBeNull();
    expect(matchNaturalLanguageInput("Remember Bun.")).toBeNull();
    expect(matchNaturalLanguageInput("/adr -- Decide")).toBeNull();
  });

  it("transforms confirmed natural-language input into a normalized prompt", async () => {
    const harness = createHarness(true);
    const handler = harness.handlers.get("input");

    const result = await handler?.(
      {
        type: "input",
        text: "adr: choose sqlite for local cache",
        source: "interactive",
      },
      harness.ctx
    );

    expect(harness.confirms).toEqual([
      {
        title: "Run context-docs command?",
        message:
          "Interpret this input as /adr -- choose sqlite for local cache",
      },
    ]);
    expect(result).toMatchObject({ action: "transform" });
    expect(String((result as { text: string }).text)).toContain(
      "- command: /adr"
    );
    expect(String((result as { text: string }).text)).toContain(
      "- instruction: choose sqlite for local cache"
    );
  });

  it("routes natural-language note prefixes to context-note with confirmation", async () => {
    const harness = createHarness(true);
    const handler = harness.handlers.get("input");

    const result = await handler?.(
      {
        type: "input",
        text: "Remember that CONTEXT.md stays domain/product only",
        source: "interactive",
      },
      harness.ctx
    );

    expect(harness.confirms).toEqual([
      {
        title: "Run context-docs command?",
        message:
          "Interpret this input as /context-note -- CONTEXT.md stays domain/product only",
      },
    ]);
    expect(result).toMatchObject({ action: "transform" });
    expect(String((result as { text: string }).text)).toContain(
      "- command: /context-note"
    );
  });

  it("preserves apostrophes in natural-language note prefixes", async () => {
    const harness = createHarness(true);
    const handler = harness.handlers.get("input");

    const result = await handler?.(
      {
        type: "input",
        text: "Remember that don't put secrets in CONTEXT.md",
        source: "interactive",
      },
      harness.ctx
    );

    expect(result).toMatchObject({ action: "transform" });
    expect(String((result as { text: string }).text)).toContain(
      "- instruction: don't put secrets in CONTEXT.md"
    );
  });

  it("handles secret-bearing natural-language note prefixes without sending them", async () => {
    const harness = createHarness(true);
    const handler = harness.handlers.get("input");

    const result = await handler?.(
      {
        type: "input",
        text: "Remember that token=super-secret-token-value",
        source: "interactive",
      },
      harness.ctx
    );

    expect(result).toEqual({ action: "handled" });
    expect(harness.confirms).toEqual([]);
    expect(harness.notifications).toEqual([
      {
        message: "Refusing context-docs prompt: possible assigned secret.",
        level: "warning",
      },
    ]);
  });

  it("continues original input when user rejects the natural-language transform", async () => {
    const harness = createHarness(false);
    const handler = harness.handlers.get("input");

    const result = await handler?.(
      {
        type: "input",
        text: "context review: stale docs",
        source: "interactive",
      },
      harness.ctx
    );

    expect(result).toEqual({ action: "continue" });
  });
});

describe("context-docs runtime reminder", () => {
  it("does not inject for every prompt", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-docs-"));
    try {
      expect(shouldInjectContextDocsReminder("what is 2+2?", tempRoot)).toBe(
        false
      );
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("injects only when context docs are relevant to project work", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-docs-"));
    try {
      fs.writeFileSync(path.join(tempRoot, "CONTEXT.md"), "# CONTEXT\n");

      expect(
        shouldInjectContextDocsReminder("fix the cache bug", tempRoot)
      ).toBe(true);
      expect(shouldInjectContextDocsReminder("what is 2+2?", tempRoot)).toBe(
        false
      );
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("injects for context-docs command work without existing context docs", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-docs-"));
    try {
      expect(
        shouldInjectContextDocsReminder(
          "/context-review -- Check drift",
          tempRoot
        )
      ).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("uses the tiny reminder in before_agent_start", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-docs-"));
    try {
      const harness = createHarness();
      const handler = harness.handlers.get("before_agent_start");

      const skipped = handler?.(
        {
          type: "before_agent_start",
          prompt: "what is 2+2?",
          systemPrompt: "base",
        },
        { ...harness.ctx, cwd: tempRoot }
      );

      const injected = handler?.(
        {
          type: "before_agent_start",
          prompt: "/context-note -- Keep docs scoped",
          systemPrompt: "base",
        },
        { ...harness.ctx, cwd: tempRoot }
      ) as { systemPrompt?: string } | undefined;

      expect(skipped).toBeUndefined();
      expect(injected?.systemPrompt).toContain("Context-docs:");
      expect(injected?.systemPrompt).toContain(
        "CONTEXT.md domain/product only"
      );
      expect(injected?.systemPrompt).toContain("no pi-tasks");
    } finally {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("context-docs helper modules", () => {
  it("classifies domain terms", () => {
    const result = classifyContextDocNote(
      "Domain term: a leaf session means the active branch tip in Pi history."
    );

    expect(result).toEqual(
      expect.objectContaining({ accepted: true, kind: "domain-term" })
    );
  });

  it("classifies ADR notes with rationale", () => {
    const result = classifyContextDocNote(
      "ADR: Use Bun for extension tests because this repo runs TypeScript tests directly with bun test."
    );

    expect(result).toEqual(
      expect.objectContaining({ accepted: true, kind: "adr" })
    );
  });

  it("classifies agent conventions", () => {
    const result = classifyContextDocNote(
      "Agent convention: agents must use Bun commands and must not run ./runner."
    );

    expect(result).toEqual(
      expect.objectContaining({ accepted: true, kind: "agent-convention" })
    );
  });

  it("classifies context boundaries", () => {
    const result = classifyContextDocNote(
      "CONTEXT-MAP: extensions/context-docs owns durable-doc classification, depends on no sibling extension, and coordinates with command handoff only through Pi APIs."
    );

    expect(result).toEqual(
      expect.objectContaining({ accepted: true, kind: "context-map" })
    );
  });

  it("rejects rejected notes", () => {
    const result = classifyContextDocNote(
      "Rejected: not worth documenting this one-off typo."
    );

    expect(result).toEqual(
      expect.objectContaining({
        accepted: false,
        reason: "explicitly rejected",
      })
    );
  });

  it("challenges weak ADR notes", () => {
    const result = classifyContextDocNote("ADR: Use a cache.");

    expect(result).toEqual(
      expect.objectContaining({
        accepted: false,
        reason: "weak adr",
        challenge: expect.stringContaining("rationale"),
      })
    );
  });

  it("classifies Bun package manager conventions", () => {
    const result = classifyContextDocNote(
      "Use Bun as the package manager instead of npm for installs and tests."
    );

    expect(result).toEqual(
      expect.objectContaining({ accepted: true, kind: "project-convention" })
    );
  });

  it("requires the CONTEXT-MAP boundary threshold", () => {
    expect(
      reachesContextMapThreshold(
        "context-map boundary: this module owns prompt handoff"
      )
    ).toBeTrue();
    expect(reachesContextMapThreshold("context-map boundary only")).toBeFalse();
  });

  it("plans marked block updates", () => {
    const appended = planMarkedBlockUpdate(
      "# Docs\n",
      "glossary",
      "- Leaf: branch tip"
    );
    expect(appended.action).toBe("append");
    expect(appended.content).toContain("<!-- context-docs:start glossary -->");

    const replaced = planMarkedBlockUpdate(
      appended.content,
      "glossary",
      "- Leaf: current branch tip"
    );
    expect(replaced.action).toBe("replace");
    expect(replaced.content).toContain("- Leaf: current branch tip");
    expect(replaced.content).not.toContain("- Leaf: branch tip");
  });

  it("refuses secret-bearing prompt evidence", () => {
    expect(
      detectSecret("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz")
    ).toEqual(
      expect.objectContaining({ hasSecret: true, reason: "openai api key" })
    );

    const result = buildContextDocsPrompt({
      basePrompt: "base",
      request: "document this",
      evidencePacket: "token=super-secret-token-value",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: expect.stringContaining("Refusing"),
      })
    );
  });

  it("builds a session evidence packet", () => {
    const packet = buildSessionEvidencePacket({
      leafId: "leaf-123",
      entries: [
        { type: "message", message: { role: "system", content: "hidden" } },
        {
          type: "message",
          message: { role: "user", content: "Remember Bun." },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Use bun test for validation." }],
          },
        },
      ],
    });

    expect(packet).toContain("<session-evidence>");
    expect(packet).toContain("leaf: leaf-123");
    expect(packet).toContain("message 1 (user):\nRemember Bun.");
    expect(packet).toContain(
      "message 2 (assistant):\nUse bun test for validation."
    );
    expect(packet).not.toContain("hidden");
  });

  it("builds a prompt handoff", () => {
    const built = buildContextDocsPrompt({
      basePrompt: "base prompt",
      request: "write context docs",
      evidencePacket:
        "<session-evidence>\nmessage 1 (user):\nUse Bun.\n</session-evidence>",
    });

    expect(built).toEqual(
      expect.objectContaining({
        ok: true,
        prompt: expect.stringContaining("<handoff>"),
      })
    );
  });
});

describe("context-docs prompt", () => {
  it("includes pi-task guardrail in normalized handoff", () => {
    const parsed = parseContextDocsArgs(
      "context-setup",
      "-- Refresh docs",
      process.cwd()
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(buildContextDocsMessage(parsed.value)).toContain(
      "Do not create, modify, schedule, or manage pi-tasks."
    );
  });

  it("includes Matt-compatible context scaffold guidance", () => {
    const parsed = parseContextDocsArgs(
      "context-setup",
      "-- Refresh docs",
      process.cwd()
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const message = buildContextDocsMessage(parsed.value);

    expect(message).toContain("Matt-compatible scaffold");
    expect(message).toContain("CONTEXT.md");
    expect(message).toContain("CONTEXT-MAP.md");
  });

  it("states strict context-doc scope boundaries", () => {
    const parsed = parseContextDocsArgs(
      "context-setup",
      "-- Refresh docs",
      process.cwd()
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const message = buildContextDocsMessage(parsed.value);

    expect(message).toContain(
      "`CONTEXT.md`: the human-readable domain/product context entrypoint."
    );
    expect(message).toContain(
      "agent conventions, written to the managed `AGENTS.md`, not `CONTEXT.md`"
    );
    expect(message).toContain(
      "Architecture Decision Record for a tradeoff decision"
    );
    expect(message).toContain(
      "Update `CONTEXT-MAP.md` only for real durable-context boundaries"
    );
  });

  it("includes review extraction and grill behavior rules", () => {
    const parsed = parseContextDocsArgs(
      "context-review",
      "--scope all -- Find stale context",
      process.cwd()
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const message = buildContextDocsMessage(parsed.value);

    expect(message).toContain("/context-review extraction rules");
    expect(message).toContain("Do not extract:");
    expect(message).toContain("/context-grill behavior");
    expect(message).toContain("Ask exactly one high-leverage question");
  });
});
