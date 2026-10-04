import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import rtkExtension from "./rtk";
import toolDisplayExtension from "./tool-display";

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
) as { pi?: { extensions?: string[] } };
const rtkIndexSource = readFileSync(
  join(import.meta.dir, "rtk", "index.ts"),
  "utf8",
);
const toolDisplayIndexSource = readFileSync(
  join(import.meta.dir, "tool-display", "index.ts"),
  "utf8",
);
type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type RendererResolver = Parameters<ExtensionAPI["registerToolRenderer"]>[0];
type EventHandler = (event: unknown, ctx: { cwd: string }) => void;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = join(
    import.meta.dir,
    `.tmp-extension-registration-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeToolDisplayConfig(cwd: string, tools: unknown): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "tool-display.json"),
    JSON.stringify({ tools }),
  );
}

function createExtensionHarness() {
  const tools: RegisteredTool[] = [];
  const resolvers: RendererResolver[] = [];
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
    registerToolRenderer(resolver: RendererResolver) {
      resolvers.push(resolver);
    },
  } as unknown as ExtensionAPI;

  return { api, commands, eventHandlers, handlers, tools, resolvers };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("extension registration compatibility", () => {
  test("nests prompt wrappers in cleanup-safe order", () => {
    const extensions = packageJson.pi?.extensions ?? [];
    const autoRenameIndex = extensions.indexOf("./extensions/auto-rename");
    expect(extensions.indexOf("./extensions/prompt-commands")).toBeLessThan(
      autoRenameIndex,
    );
    expect(autoRenameIndex).toBeLessThan(
      extensions.indexOf("./extensions/context-docs"),
    );
  });

  test("tool ownership is explicit", () => {
    const extensions = packageJson.pi?.extensions ?? [];

    expect(extensions).toContain("./extensions/rtk");
    expect(extensions).toContain("./extensions/tool-display");
    expect(extensions).not.toContain("./extensions/multi-edit.ts");
  });

  test("tool-display draws edit and bash without registering either by default", () => {
    const harness = createExtensionHarness();

    toolDisplayExtension(harness.api);

    expect(harness.tools.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "write",
    ]);
    expect(harness.resolvers).toHaveLength(1);
    for (const name of ["edit", "bash"]) {
      expect(harness.tools.map((tool) => tool.name)).not.toContain(name);
      const renderers = harness.resolvers[0]?.(name, () => undefined);
      expect(renderers?.renderShell).toBe("self");
      expect(renderers?.renderCall).toBeFunction();
      expect(renderers?.renderResult).toBeFunction();
    }
    for (const tool of harness.tools) {
      expect(tool.renderShell).toBeUndefined();
      expect(tool.renderCall).toBeUndefined();
      expect(tool.renderResult).toBeUndefined();
    }
  });

  test("opt-in candidate edit patch adds follow switched session write permission", async () => {
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
    const initialEdit = harness.tools.find((tool) => tool.name === "edit");
    expect(initialEdit).toBeDefined();
    expect(Object.keys(initialEdit?.parameters.properties ?? {})).toEqual([
      "text",
    ]);
    writeToolDisplayConfig(cwd, {
      edit: { enabled: true },
      write: { enabled: false },
    });
    for (const handler of harness.eventHandlers.get("session_switch") ?? []) {
      handler({}, { cwd });
    }
    const edit = harness.tools.findLast((tool) => tool.name === "edit");
    if (!edit) {
      throw new Error("Expected enabled candidate edit registration");
    }

    expect(
      edit.execute(
        "tool-call-id",
        {
          text: `*** Begin Patch
*** Add File: should-not-exist.txt
+blocked
*** End Patch`,
        },
        undefined,
        undefined,
        { cwd } as never,
      ),
    ).rejects.toThrow("Patch Add File requires the write tool to be enabled");
    expect(existsSync(join(cwd, "should-not-exist.txt"))).toBe(false);
  });

  test("rtk owns reasoned bash execution without renderers; tool-display resolves bash drawing", () => {
    const harness = createExtensionHarness();

    rtkExtension(harness.api);

    expect(harness.tools.map((tool) => tool.name)).toEqual(["bash"]);
    const bash = harness.tools[0];
    expect(bash?.parameters.properties.reasoning.type).toBe("string");
    expect(bash?.parameters.required).toContain("reasoning");
    expect(bash?.renderShell).toBeUndefined();
    expect(bash?.renderCall).toBeUndefined();
    expect(bash?.renderResult).toBeUndefined();
    expect(harness.resolvers).toHaveLength(0);
    expect(rtkIndexSource).toContain("createBashTool");
    expect(rtkIndexSource).toContain("withReasonedBash");
    expect(rtkIndexSource).toContain("resolveRtkCommand");
    for (const file of readdirSync(join(import.meta.dir, "rtk"))) {
      if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
        expect(
          readFileSync(join(import.meta.dir, "rtk", file), "utf8"),
        ).not.toContain("../tool-display");
      }
    }

    toolDisplayExtension(harness.api);
    expect(harness.tools.filter((tool) => tool.name === "bash")).toEqual([
      bash,
    ]);
    expect(harness.resolvers).toHaveLength(1);
    const renderers = harness.resolvers[0]?.("bash", () => bash);
    expect(renderers?.renderShell).toBe("self");
    expect(renderers?.renderCall).toBeFunction();
    expect(renderers?.renderResult).toBeFunction();
  });

  test("full reads render through shared tool-display details", () => {
    expect(toolDisplayIndexSource).toContain("createToolDisplayReadDetails");
    expect(
      readFileSync(
        join(import.meta.dir, "tool-display", "presentation.ts"),
        "utf8",
      ),
    ).toContain("details.toolDisplay?.fullRead");
  });
});
