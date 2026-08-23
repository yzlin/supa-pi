import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import autoRenameExtension from "./auto-rename";
import contextDocsExtension from "./context-docs";
import rtkExtension from "./rtk";
import toolDisplayExtension from "./tool-display";

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")
) as { pi?: { extensions?: string[] } };
const rtkIndexSource = readFileSync(
  join(import.meta.dir, "rtk", "index.ts"),
  "utf8"
);
const toolDisplayIndexSource = readFileSync(
  join(import.meta.dir, "tool-display", "index.ts"),
  "utf8"
);
type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type EventHandler = (event: unknown, ctx: { cwd: string }) => void;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = join(
    import.meta.dir,
    `.tmp-extension-registration-${Date.now()}-${Math.random()}`
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeToolDisplayConfig(cwd: string, tools: unknown): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "tool-display.json"),
    JSON.stringify({ tools })
  );
}

function createExtensionHarness() {
  const tools: RegisteredTool[] = [];
  const commands: string[] = [];
  const handlers: string[] = [];
  const eventHandlers = new Map<string, EventHandler[]>();

  const api = {
    on(name: string, handler: EventHandler) {
      handlers.push(name);
      eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  return { api, commands, eventHandlers, handlers, tools };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("extension registration compatibility", () => {
  test("auto-rename captures raw input before context-docs transforms it", async () => {
    const extensions = packageJson.pi?.extensions ?? [];
    const autoRenamePath = "./extensions/auto-rename";
    const contextDocsPath = "./extensions/context-docs";
    expect(extensions.indexOf(autoRenamePath)).toBeLessThan(
      extensions.indexOf(contextDocsPath)
    );

    const lifecycleHandlers = new Map<
      string,
      Array<(event: any, ctx: any) => unknown>
    >();
    const namingSources: string[] = [];
    let sessionName: string | undefined;
    const api = {
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        lifecycleHandlers.set(name, [
          ...(lifecycleHandlers.get(name) ?? []),
          handler,
        ]);
      },
      registerCommand() {
        // Commands are irrelevant to this input-chain integration harness.
      },
      getSessionName: () => sessionName,
      setSessionName(name: string) {
        sessionName = name;
      },
    } as unknown as ExtensionAPI;
    const factories = new Map([
      [autoRenamePath, autoRenameExtension],
      [contextDocsPath, contextDocsExtension],
    ]);
    for (const path of extensions) {
      factories.get(path)?.(api);
    }

    const cwd = tempDir();
    const ctx = {
      cwd,
      hasUI: true,
      model: { provider: "mock", id: "active" },
      modelRegistry: {
        complete(_model: unknown, request: any) {
          namingSources.push(request.messages[0].content);
          return Promise.resolve({
            stopReason: "stop",
            content: [{ type: "text", text: "Original Context Request" }],
          });
        },
      },
      sessionManager: {
        getSessionId: () => "session-integration",
        getBranch: () => [],
      },
      ui: {
        confirm: () => Promise.resolve(true),
        notify() {
          // No notification is expected in this integration path.
        },
      },
    };
    const originalHome = process.env.HOME;
    process.env.HOME = cwd;
    try {
      for (const handler of lifecycleHandlers.get("session_start") ?? []) {
        await handler({ type: "session_start", reason: "startup" }, ctx);
      }
      let text = "context note: preserve the original request";
      for (const handler of lifecycleHandlers.get("input") ?? []) {
        const result = (await handler(
          { type: "input", source: "interactive", text },
          ctx
        )) as { action?: string; text?: string } | undefined;
        if (result?.action === "transform" && result.text) {
          text = result.text;
        }
      }
      expect(text).toContain("Use the canonical `context-docs` skill");
      for (const handler of lifecycleHandlers.get("agent_settled") ?? []) {
        await handler({ type: "agent_settled" }, ctx);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      process.env.HOME = originalHome;
    }

    expect(namingSources).toEqual([
      "context note: preserve the original request",
    ]);
    expect(sessionName).toBe("Original Context Request");
  });

  test("tool ownership is explicit", () => {
    const extensions = packageJson.pi?.extensions ?? [];

    expect(extensions).toContain("./extensions/rtk");
    expect(extensions).toContain("./extensions/tool-display");
    expect(extensions.indexOf("./extensions/rtk")).toBeLessThan(
      extensions.indexOf("./extensions/tool-display")
    );
    expect(extensions).not.toContain("./extensions/multi-edit.ts");
  });

  test("tool-display leaves built-in edit and bash available by default", () => {
    const harness = createExtensionHarness();

    toolDisplayExtension(harness.api);

    expect(harness.tools.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
    ]);
    const edit = harness.tools.find((tool) => tool.name === "edit");
    expect(Object.keys(edit?.parameters.properties ?? {})).toEqual([
      "path",
      "edits",
    ]);
    expect(harness.tools.map((tool) => tool.name)).not.toContain("bash");
    expect(
      harness.tools
        .filter((tool) => tool.renderShell === "default")
        .map((tool) => tool.name)
    ).toEqual([]);
  });

  test("edit patch add permission follows current session config", async () => {
    const cwd = tempDir();
    const originalCwd = process.cwd();
    writeToolDisplayConfig(cwd, {
      edit: { enabled: true },
      write: { enabled: true },
    });
    const harness = createExtensionHarness();

    try {
      process.chdir(cwd);
      toolDisplayExtension(harness.api);
    } finally {
      process.chdir(originalCwd);
    }
    writeToolDisplayConfig(cwd, {
      edit: { enabled: true },
      write: { enabled: false },
    });
    for (const handler of harness.eventHandlers.get("session_switch") ?? []) {
      handler({}, { cwd });
    }
    const edit = harness.tools.find((tool) => tool.name === "edit");

    await expect(
      edit?.execute(
        "tool-call-id",
        {
          text: `*** Begin Patch
*** Add File: should-not-exist.txt
+blocked
*** End Patch`,
        },
        undefined,
        undefined,
        { cwd } as never
      )
    ).rejects.toThrow("Patch Add File requires the write tool to be enabled");
    expect(existsSync(join(cwd, "should-not-exist.txt"))).toBe(false);
  });

  test("rtk actively owns bash execution while using tool-display bash renderers", () => {
    const harness = createExtensionHarness();

    rtkExtension(harness.api);

    expect(harness.tools.map((tool) => tool.name)).toEqual(["bash"]);
    expect(rtkIndexSource).toContain("createBashTool");
    expect(rtkIndexSource).toContain("renderBashToolCall");
    expect(rtkIndexSource).toContain("renderCompactBashResult");
    expect(rtkIndexSource).toContain("toolDisplayConfig.output.bash");
    expect(rtkIndexSource).toContain("resolveRtkCommand");
  });

  test("full reads render through shared tool-display details", () => {
    expect(toolDisplayIndexSource).toContain("createToolDisplayReadDetails");
    expect(
      readFileSync(
        join(import.meta.dir, "tool-display", "presentation.ts"),
        "utf8"
      )
    ).toContain("details.toolDisplay?.fullRead");
  });
});
