import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { expandHome, loadObsidianConfig } from "./config";
import {
  discoverClaudeChain,
  loadContextFiles,
  OBSIDIAN_CONTEXT_ENTRY,
} from "./context";
import obsidianExtension from "./index";
import { assertContained, resolveActiveVault } from "./vault";

function makeVault(name: string) {
  const root = join(tmpdir(), `obsidian-${name}-${crypto.randomUUID()}`);
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  return root;
}

function realVault(root: string, name?: string) {
  return { path: root, realPath: realpathSync(root), name };
}

const originalConfigPath = process.env.PI_OBSIDIAN_CONFIG_PATH;
const VAULT_HOME_PATTERN = /\/Vault$/;

afterEach(() => {
  if (originalConfigPath === undefined) {
    process.env.PI_OBSIDIAN_CONFIG_PATH = undefined;
  } else {
    process.env.PI_OBSIDIAN_CONFIG_PATH = originalConfigPath;
  }
});

function useTempConfig(name: string) {
  const root = join(tmpdir(), `obsidian-config-${name}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  process.env.PI_OBSIDIAN_CONFIG_PATH = join(root, "obsidian.json");
  return root;
}

function writeConfig(config: unknown) {
  if (!process.env.PI_OBSIDIAN_CONFIG_PATH) {
    throw new Error("Expected PI_OBSIDIAN_CONFIG_PATH");
  }
  writeFileSync(process.env.PI_OBSIDIAN_CONFIG_PATH, JSON.stringify(config));
}

type HookName = "before_agent_start" | "before_provider_request" | "tool_call";
type HookHandler = (event: unknown, context: ExtensionContext) => unknown;
type RegisteredCommand = NonNullable<
  Parameters<ExtensionAPI["registerCommand"]>[1]
>;

interface SessionEntry {
  customType?: string;
  data?: unknown;
}

function createExtensionHarness() {
  const hooks = new Map<HookName, HookHandler>();
  let command: RegisteredCommand | undefined;
  const entries: SessionEntry[] = [];
  const notifications: Array<{ text: string; level: string }> = [];

  obsidianExtension({
    on(
      name: string,
      handler: (event: unknown, context: ExtensionContext) => unknown
    ) {
      hooks.set(name as HookName, handler);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    registerCommand(_name: string, options: RegisteredCommand) {
      command = options;
    },
  } as ExtensionAPI);

  if (!command?.handler) {
    throw new Error("Obsidian command was not registered");
  }
  const registeredCommand = command;

  function makeCtx(cwd: string): ExtensionContext {
    return {
      cwd,
      sessionManager: {
        getEntries: () => entries,
      },
    } as ExtensionContext;
  }

  return {
    entries,
    beforeAgentStart(cwd: string, systemPrompt = "base prompt") {
      return hooks.get("before_agent_start")?.({ systemPrompt }, makeCtx(cwd));
    },
    beforeProviderRequest(payload: unknown, cwd: string) {
      return hooks.get("before_provider_request")?.({ payload }, makeCtx(cwd));
    },
    toolCall(event: Partial<ToolCallEvent>, cwd: string) {
      return hooks.get("tool_call")?.(event, makeCtx(cwd));
    },
    async status(cwd: string, args = "status") {
      await registeredCommand.handler(args, {
        cwd,
        sessionManager: { getEntries: () => entries },
        ui: {
          notify(text: string, level: string) {
            notifications.push({ text, level });
          },
        },
      } as ExtensionCommandContext);
      return notifications;
    },
  };
}

describe("obsidian config", () => {
  it("normalizes config and expands home paths", () => {
    const home = useTempConfig("config");
    const vault = join(home, "Vault");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeConfig({
      enabled: true,
      vaults: [
        { path: vault, name: "home" },
        { path: "relative" },
        { path: join(home, "missing") },
      ],
    });

    expect(expandHome("~/Vault")).toMatch(VAULT_HOME_PATTERN);
    expect(loadObsidianConfig()).toEqual({
      enabled: true,
      vaults: [realVault(vault, "home")],
      warnings: [
        "Rejected Obsidian vault with non-absolute path",
        `Rejected missing Obsidian vault: ${join(home, "missing")}`,
      ],
    });
  });

  it("rejects directories that are not Obsidian vaults", () => {
    const home = useTempConfig("validation");
    const notVault = join(home, "not-vault");
    mkdirSync(notVault, { recursive: true });
    writeConfig({
      enabled: true,
      vaults: [{ path: notVault }],
    });

    expect(loadObsidianConfig()).toEqual({
      enabled: true,
      vaults: [],
      warnings: [`Rejected missing Obsidian vault: ${notVault}`],
    });
  });
});

describe("obsidian context", () => {
  it("discovers only parent-to-child CLAUDE.md chain", () => {
    const root = makeVault("chain");
    const child = join(root, "area", "project");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "root");
    writeFileSync(join(root, "area", "CLAUDE.MD"), "area");
    writeFileSync(join(child, "CLAUDE.md"), "project");
    mkdirSync(join(child, "descendant"), { recursive: true });
    writeFileSync(join(child, "descendant", "CLAUDE.md"), "ignored");

    expect(
      discoverClaudeChain(realVault(root), join(child, "note.md"))
    ).toEqual([
      realpathSync(join(root, "CLAUDE.md")),
      realpathSync(join(root, "area", "CLAUDE.MD")),
      realpathSync(join(child, "CLAUDE.md")),
    ]);
  });

  it("discovers CLAUDE.md chain for missing target directories", () => {
    const root = makeVault("missing-target");
    const child = join(root, "area");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "root");
    writeFileSync(join(child, "CLAUDE.md"), "area");

    expect(
      discoverClaudeChain(realVault(root), join(child, "new", "note.md"))
    ).toEqual([
      realpathSync(join(root, "CLAUDE.md")),
      realpathSync(join(child, "CLAUDE.md")),
    ]);
  });

  it("dedupes CLAUDE paths when loading context", () => {
    const root = makeVault("dedupe");
    const claude = join(root, "CLAUDE.md");
    writeFileSync(claude, "root");

    expect(loadContextFiles([claude, claude])).toBe(`## ${claude}\n\nroot`);
  });

  it("blocks oversized context instead of truncating", () => {
    const root = makeVault("limit");
    const claude = join(root, "CLAUDE.md");
    writeFileSync(claude, "x".repeat(64 * 1024 + 1));

    expect(() => loadContextFiles([claude])).toThrow("exceeds 64KB");
  });

  it("blocks context chains over the total size limit", () => {
    const root = makeVault("total-limit");
    const paths = Array.from({ length: 5 }, (_item, index) => {
      const path = join(root, `CLAUDE-${index}.md`);
      writeFileSync(path, "x".repeat(64 * 1024));
      return path;
    });

    expect(() => loadContextFiles(paths)).toThrow("exceeds 256KB total");
  });

  it("restores persisted loaded paths by real path identity", () => {
    useTempConfig("session");
    const root = makeVault("session");
    const child = join(root, "child");
    mkdirSync(child, { recursive: true });
    const rootClaude = join(root, "CLAUDE.md");
    const childClaude = join(child, "CLAUDE.md");
    writeFileSync(rootClaude, "root");
    writeFileSync(childClaude, "child");
    writeConfig({ enabled: true, vaults: [{ path: root }] });

    const harness = createExtensionHarness();

    expect(harness.beforeAgentStart(child)).toBeUndefined();
    expect(harness.beforeAgentStart(child)).toBeUndefined();
    expect(
      harness.beforeProviderRequest({ system: "base provider prompt" }, child)
    ).toEqual({
      system: expect.stringContaining(`## ${realpathSync(childClaude)}`),
    });
    expect(harness.entries).toEqual([
      {
        customType: OBSIDIAN_CONTEXT_ENTRY,
        data: { paths: [realpathSync(rootClaude), realpathSync(childClaude)] },
      },
    ]);
  });
});

describe("obsidian vault resolution", () => {
  it("uses realpath containment for symlinked paths", () => {
    const root = makeVault("realpath");
    const outside = join(tmpdir(), `obsidian-outside-${crypto.randomUUID()}`);
    mkdirSync(outside, { recursive: true });
    const link = join(root, "link");
    symlinkSync(outside, link);

    expect(assertContained(realVault(root), link)).toBe(false);
    expect(resolveActiveVault(link, [realVault(root)])).toBeNull();
  });

  it("stays inactive outside configured vault cwd", () => {
    useTempConfig("outside");
    const root = makeVault("outside-vault");
    const outside = join(
      tmpdir(),
      `obsidian-outside-cwd-${crypto.randomUUID()}`
    );
    mkdirSync(outside, { recursive: true });
    writeConfig({ enabled: true, vaults: [{ path: root }] });

    const harness = createExtensionHarness();

    expect(harness.beforeAgentStart(outside)).toBeUndefined();
    expect(
      harness.toolCall(
        { toolName: "read", input: { path: join(root, "note.md") } },
        outside
      )
    ).toBeUndefined();
  });

  it("uses deepest overlapping vault and warns", () => {
    const root = makeVault("root");
    const nested = join(root, "nested");
    mkdirSync(join(nested, ".obsidian"), { recursive: true });

    const active = resolveActiveVault(join(nested, "note.md"), [
      realVault(root, "root"),
      realVault(nested, "nested"),
    ]);

    expect(active?.vault.name).toBe("nested");
    expect(active?.warnings).toEqual([
      "Overlapping Obsidian vaults detected; deepest root wins",
    ]);
  });
});

describe("obsidian extension behavior", () => {
  it("injects initial context into provider payloads once", () => {
    useTempConfig("append-prompt");
    const root = makeVault("append-prompt");
    writeFileSync(join(root, "CLAUDE.md"), "root rules");
    writeConfig({ enabled: true, vaults: [{ path: root }] });

    const harness = createExtensionHarness();

    expect(harness.beforeAgentStart(root, "base prompt")).toBeUndefined();
    const result = harness.beforeProviderRequest(
      { system: "base provider prompt" },
      root
    ) as { system: string };

    expect(result.system).toStartWith("base provider prompt\n\n");
    expect(result.system.match(/root rules/g)).toHaveLength(1);
  });

  it("injects context loaded by a guarded tool call into provider retry payloads", () => {
    useTempConfig("provider-retry");
    const root = makeVault("provider-retry");
    const child = join(root, "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "CLAUDE.md"), "retry rules");
    writeConfig({ enabled: true, vaults: [{ path: root }] });

    const harness = createExtensionHarness();
    harness.toolCall(
      { toolName: "read", input: { path: join(child, "note.md") } },
      root
    );

    expect(
      harness.beforeProviderRequest({ system: "base provider prompt" }, root)
    ).toEqual({
      system: expect.stringContaining("base provider prompt\n\nObsidian"),
    });
    expect(
      harness.beforeProviderRequest(
        { messages: [{ role: "system", content: "base message prompt" }] },
        root
      )
    ).toEqual({
      messages: [
        {
          role: "system",
          content: expect.stringContaining("retry rules"),
        },
      ],
    });
    expect(
      harness.beforeProviderRequest(
        {
          system: [
            { type: "text", text: "oauth identity" },
            { type: "text", text: "base provider prompt" },
          ],
        },
        root
      )
    ).toEqual({
      system: [
        { type: "text", text: "oauth identity" },
        {
          type: "text",
          text: expect.stringContaining("retry rules"),
        },
      ],
    });
  });

  it("does not persist oversized context loaded by a guarded tool call", () => {
    useTempConfig("guard-limit");
    const root = makeVault("guard-limit");
    const child = join(root, "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "CLAUDE.md"), "x".repeat(64 * 1024 + 1));
    writeConfig({ enabled: true, vaults: [{ path: root }] });

    const harness = createExtensionHarness();

    expect(
      harness.toolCall(
        { toolName: "read", input: { path: join(child, "note.md") } },
        root
      )
    ).toEqual({
      block: true,
      reason: `Obsidian context file exceeds 64KB: ${realpathSync(
        join(child, "CLAUDE.md")
      )}`,
    });
    expect(harness.entries).toEqual([]);
  });

  it("blocks the first structured tool call to load missing context, then allows retry", () => {
    useTempConfig("guard");
    const root = makeVault("guard");
    const child = join(root, "child");
    mkdirSync(child, { recursive: true });
    const claude = join(child, "CLAUDE.md");
    writeFileSync(claude, "child rules");
    writeConfig({ enabled: true, vaults: [{ path: root }] });

    const harness = createExtensionHarness();
    const event = { toolName: "read", input: { path: join(child, "note.md") } };

    expect(harness.toolCall(event, root)).toEqual({
      block: true,
      reason: `Obsidian loaded missing CLAUDE context for ${join(
        child,
        "note.md"
      )}. Retry the same structured tool call now.`,
    });
    expect(harness.toolCall(event, root)).toBeUndefined();
    expect(harness.entries).toEqual([
      {
        customType: OBSIDIAN_CONTEXT_ENTRY,
        data: { paths: [realpathSync(claude)] },
      },
    ]);
  });

  it("blocks guarded structured tool paths outside the active vault", () => {
    useTempConfig("guard-outside");
    const root = makeVault("guard-outside");
    const outside = join(
      tmpdir(),
      `obsidian-guard-outside-${crypto.randomUUID()}`
    );
    mkdirSync(outside, { recursive: true });
    writeConfig({ enabled: true, vaults: [{ path: root }] });

    const harness = createExtensionHarness();

    expect(
      harness.toolCall({ toolName: "read", input: { path: outside } }, root)
    ).toEqual({
      block: true,
      reason: "Obsidian guard blocked path outside the active vault.",
    });
  });

  it("reports status with config, active vault, loaded paths, and warnings", async () => {
    useTempConfig("status");
    const root = makeVault("status-root");
    const nested = join(root, "nested");
    mkdirSync(join(nested, ".obsidian"), { recursive: true });
    writeFileSync(join(nested, "CLAUDE.md"), "nested");
    writeConfig({
      enabled: true,
      vaults: [
        { path: root, name: "root" },
        { path: nested, name: "nested" },
        { path: "relative" },
      ],
    });

    const harness = createExtensionHarness();
    harness.beforeAgentStart(nested);
    const notifications = await harness.status(nested);

    expect(notifications).toEqual([
      {
        level: "info",
        text: [
          "enabled: true",
          "configured vaults: 2",
          "active vault: nested",
          "loaded CLAUDE paths: 1",
          `  - ${realpathSync(join(nested, "CLAUDE.md"))}`,
          "warning: Rejected Obsidian vault with non-absolute path",
          "warning: Overlapping Obsidian vaults detected; deepest root wins",
        ].join("\n"),
      },
    ]);
  });

  it("defaults bare obsidian command to status", async () => {
    useTempConfig("bare-status");
    writeConfig({ enabled: false, vaults: [] });
    const harness = createExtensionHarness();

    expect(await harness.status(tmpdir(), "")).toEqual([
      {
        level: "info",
        text: [
          "enabled: false",
          "configured vaults: 0",
          "active vault: none",
          "loaded CLAUDE paths: 0",
        ].join("\n"),
      },
    ]);
  });

  it("shows usage for unsupported obsidian command arguments", async () => {
    const harness = createExtensionHarness();

    expect(await harness.status(tmpdir(), "nope")).toEqual([
      { text: "Usage: /obsidian status", level: "warning" },
    ]);
  });
});
