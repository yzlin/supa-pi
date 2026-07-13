import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createBashTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { DEFAULT_RTK_CONFIG } from "./config";
import rtkExtension, { createRtkBashTool } from "./index";
import { createRtkRuntime } from "./runtime";

const theme = {
  bg: (_token: string, text: string) => text.trimEnd(),
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
};
const tempDirs: string[] = [];

function fakeBashTool() {
  let delegated: unknown;
  const tool = {
    name: "bash",
    label: "bash",
    description: "bash",
    parameters: Type.Object({
      command: Type.String(),
      timeout: Type.Optional(Type.Number()),
    }),
    renderShell: "default" as const,
    renderCall: () => ({
      render: () => ["native call"],
      invalidate() {
        // Native test component has no cached state.
      },
    }),
    renderResult: () => ({
      render: () => ["native result"],
      invalidate() {
        // Native test component has no cached state.
      },
    }),
    execute(_id: string, params: unknown) {
      delegated = params;
      return Promise.resolve({
        content: [{ type: "text" as const, text: "ok" }],
      });
    },
  };
  return { getDelegated: () => delegated, tool };
}

function displayConfig(enabled: boolean) {
  return {
    enabled,
    mode: "compact" as const,
    collapsed: true,
    previewLines: 20,
    rtkHints: true,
  };
}

function writeDisplayConfig(cwd: string, enabled: boolean): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "tool-display.json"),
    JSON.stringify({ output: { bash: { enabled } } })
  );
}

beforeAll(() => {
  initTheme("dark", false);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RTK bash presentation", () => {
  test("enabled presentation requires reasoning, owns its shell, and strips reasoning", async () => {
    const base = fakeBashTool();
    const runtime = createRtkRuntime({ ...DEFAULT_RTK_CONFIG, enabled: false });
    const tool = createRtkBashTool(base.tool as never, runtime, () =>
      displayConfig(true)
    );

    expect(Object.keys(tool.parameters.properties)).toEqual([
      "reasoning",
      "command",
      "timeout",
    ]);
    expect(tool.parameters.required as string[]).toContain("reasoning");
    expect(tool.renderShell).toBe("self");

    const result = await tool.execute(
      "id" as never,
      { reasoning: "Check status", command: "git status", timeout: 4 } as never,
      undefined as never,
      undefined as never,
      { hasUI: false } as never
    );
    expect(base.getDelegated()).toEqual({ command: "git status", timeout: 4 });
    expect(
      (result.details as { toolDisplay?: { durationMs?: number } }).toolDisplay
        ?.durationMs
    ).toBeNumber();
  });

  test("disabled presentation retains native schema, renderers, and shell", () => {
    const base = fakeBashTool();
    const runtime = createRtkRuntime(DEFAULT_RTK_CONFIG);
    const tool = createRtkBashTool(base.tool as never, runtime, () =>
      displayConfig(false)
    );

    expect(tool.parameters).toBe(base.tool.parameters);
    expect(tool.renderShell).toBe("default");
    expect(tool.renderCall).toBe(base.tool.renderCall);
    expect(tool.renderResult).toBe(base.tool.renderResult);
  });

  test("disabled real bash tool uses Pi native ToolExecutionComponent presentation", () => {
    const runtime = createRtkRuntime(DEFAULT_RTK_CONFIG);
    const native = createBashTool(process.cwd());
    const tool = createRtkBashTool(native, runtime, () => displayConfig(false));
    expect(tool.renderCall).toBeUndefined();
    expect(tool.renderResult).toBeUndefined();

    const component = new ToolExecutionComponent(
      "bash",
      "native-bash",
      { command: "printf ok" },
      {},
      tool,
      {
        requestRender() {
          // Deterministic native renderer test does not schedule redraws.
        },
      } as never,
      process.cwd()
    );
    expect(() => component.render(80)).not.toThrow();
    component.updateResult(
      { content: [{ type: "text", text: "ok" }], isError: false },
      false
    );
    expect(component.render(80).join("\n")).toContain("ok");
  });

  test("renders command fallback, elapsed restored duration, errors, and badges", () => {
    const base = fakeBashTool();
    const runtime = createRtkRuntime(DEFAULT_RTK_CONFIG);
    const tool = createRtkBashTool(base.tool as never, runtime, () =>
      displayConfig(true)
    );
    const state = {};
    const context = {
      args: { command: "false" },
      state,
      invalidate() {
        // Test renderer does not need redraw scheduling.
      },
    };
    const call = tool.renderCall(
      context.args as never,
      theme as never,
      context as never
    );
    expect(call.render(100)).toEqual(["┊ • ⚡️ bash false", "┊   false → <1s"]);

    const result = tool.renderResult(
      {
        content: [{ type: "text", text: "Command failed with exit code: 7" }],
        details: {
          toolDisplay: { durationMs: 2100 },
          truncation: { truncated: true },
          rtkCompaction: { savedChars: 99, originalChars: 120, finalChars: 21 },
        },
        isError: true,
      } as never,
      {} as never,
      theme as never,
      { ...context, isError: true } as never
    );
    expect(call.render(100)).toEqual(["┊ × ⚡️ bash false"]);
    expect(result.render(100)[0]).toBe(
      "┊   false → error in 2s [truncated] [RTK saved 99]"
    );

    const expanded = tool.renderResult(
      {
        content: [{ type: "text", text: "one\ntwo" }],
        details: { toolDisplay: { durationMs: 500 } },
      },
      { expanded: true } as never,
      theme as never,
      { args: { command: "printf 'one\\ntwo'" }, state: {} } as never
    );
    expect(expanded.render(100).map((line) => line.trimEnd())).toEqual([
      "┊   printf 'one\\ntwo' → done in <1s",
      "one",
      "two",
    ]);
  });

  test("session reload refreshes copied runtime metadata in both directions", () => {
    const cwd = join(
      import.meta.dir,
      `.tmp-rtk-${Date.now()}-${Math.random()}`
    );
    mkdirSync(cwd, { recursive: true });
    tempDirs.push(cwd);
    writeDisplayConfig(cwd, true);
    const tools: ToolDefinition[] = [];
    let registry: ToolDefinition | undefined;
    let refreshCount = 0;
    const handlers = new Map<
      string,
      Array<(event: unknown, ctx: { cwd: string }) => void>
    >();
    const api = Object.create(null) as ExtensionAPI;
    Object.assign(api, {
      on(
        name: string,
        handler: (event: unknown, ctx: { cwd: string }) => void
      ) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand() {
        // Commands are outside this registration test.
      },
      registerTool(tool: ToolDefinition) {
        tools[0] = tool;
        refreshCount += 1;
        registry = { ...tool };
      },
    });
    const parameterNames = (): string[] => {
      if (!registry) {
        return [];
      }
      const parameters: object = registry.parameters;
      if (!("properties" in parameters)) {
        return [];
      }
      return Object.keys(parameters.properties as object);
    };
    rtkExtension(api);

    for (const handler of handlers.get("session_start") ?? []) {
      handler({ type: "session_start" }, { cwd });
    }
    expect(registry?.renderShell).toBe("self");
    expect(parameterNames()).toContain("reasoning");

    writeDisplayConfig(cwd, false);
    for (const handler of handlers.get("session_switch") ?? []) {
      handler({ type: "session_switch" }, { cwd });
    }
    expect(registry?.renderShell).toBeUndefined();
    expect(registry?.renderCall).toBeUndefined();
    expect(parameterNames()).not.toContain("reasoning");

    writeDisplayConfig(cwd, true);
    for (const handler of handlers.get("session_start") ?? []) {
      handler({ type: "session_start" }, { cwd });
    }
    expect(registry?.renderShell).toBe("self");
    expect(parameterNames()).toContain("reasoning");
    expect(tools).toHaveLength(1);
    expect(refreshCount).toBe(4);
  });
});
