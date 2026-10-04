import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { withReasonedBash } from "./reasoned-bash";
import * as rewrite from "./rewrite";
import { createRtkRuntime } from "./runtime";

const tempDirs: string[] = [];

function fakeBashTool(details?: unknown) {
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
        details,
      });
    },
  };
  return { getDelegated: () => delegated, tool };
}

function writeDisplayConfig(cwd: string, enabled: boolean): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "tool-display.json"),
    JSON.stringify({ output: { bash: { enabled } } }),
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

describe("RTK bash execution contract", () => {
  test("always requires reasoning first and strips it before RTK execution", async () => {
    const base = fakeBashTool();
    const runtime = createRtkRuntime({ ...DEFAULT_RTK_CONFIG, enabled: false });
    const tool = createRtkBashTool(base.tool, runtime);

    expect(Object.keys(tool.parameters.properties)).toEqual([
      "reasoning",
      "command",
      "timeout",
    ]);
    expect(tool.parameters.required as string[]).toContain("reasoning");
    expect(tool.parameters.properties.reasoning.description).toBe(
      "State short present-tense intent, maximum 12 words, without restating target",
    );
    expect(tool.promptGuidelines).toContain(
      "Give bash a short present-tense reasoning goal without repeating its command",
    );

    const result = await tool.execute(
      "id" as never,
      { reasoning: "Check status", command: "git status", timeout: 4 } as never,
      undefined as never,
      undefined as never,
      { hasUI: false } as never,
    );
    expect(base.getDelegated()).toEqual({ command: "git status", timeout: 4 });
    expect(
      (result.details as { toolDisplay?: { durationMs?: number } }).toolDisplay
        ?.durationMs,
    ).toBeNumber();
  });

  test("RTK rewrite gets only the command and execution receives no reasoning", async () => {
    const base = fakeBashTool();
    const runtime = createRtkRuntime(DEFAULT_RTK_CONFIG);
    const resolve = spyOn(rewrite, "resolveRtkCommand").mockReturnValue({
      status: "rewritten",
      command: "rtk git status",
      changed: true,
    });
    try {
      const tool = createRtkBashTool(base.tool, runtime);
      await tool.execute(
        "rewritten",
        { reasoning: "Check status", command: "git status", timeout: 4 },
        undefined,
        undefined,
        { hasUI: false } as never,
      );
      expect(resolve).toHaveBeenCalledWith("git status", expect.any(Object));
      expect(base.getDelegated()).toEqual({
        command: "rtk git status",
        timeout: 4,
      });
      expect(runtime.metrics.snapshot().rewritesApplied).toBe(1);
    } finally {
      resolve.mockRestore();
    }
  });

  test("definition has no renderers, even when the base tool has them", () => {
    const base = fakeBashTool();
    const runtime = createRtkRuntime(DEFAULT_RTK_CONFIG);
    const tool = createRtkBashTool(base.tool, runtime);

    expect(tool).not.toHaveProperty("renderShell");
    expect(tool).not.toHaveProperty("renderCall");
    expect(tool).not.toHaveProperty("renderResult");
  });

  test("real bash tool can use Pi native ToolExecutionComponent presentation", () => {
    const runtime = createRtkRuntime(DEFAULT_RTK_CONFIG);
    const native = createBashTool(process.cwd());
    const tool = createRtkBashTool(native, runtime);
    expect(tool).not.toHaveProperty("renderCall");
    expect(tool).not.toHaveProperty("renderResult");

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
      process.cwd(),
    );
    expect(() => component.render(80)).not.toThrow();
    component.updateResult(
      { content: [{ type: "text", text: "ok" }], isError: false },
      false,
    );
    expect(component.render(80).join("\n")).toContain("ok");
  });

  test("elapsed duration merges existing details and presentation metadata", async () => {
    const priorDetails = {
      toolDisplay: { durationMs: -1, restored: true },
      rtkCompaction: { savedChars: 99, originalChars: 120, finalChars: 21 },
      fullOutputPath: "/tmp/bash-output",
    };
    const base = fakeBashTool(priorDetails);
    const runtime = createRtkRuntime({ ...DEFAULT_RTK_CONFIG, enabled: false });
    const tool = createRtkBashTool(base.tool, runtime);
    const result = await tool.execute(
      "id" as never,
      { reasoning: "Check status", command: "git status" } as never,
      undefined as never,
      undefined as never,
      { hasUI: false } as never,
    );
    const details = result.details as typeof priorDetails;
    expect(details.toolDisplay.durationMs).toBeGreaterThanOrEqual(0);
    expect(details.toolDisplay.restored).toBe(true);
    expect(details.rtkCompaction).toEqual(priorDetails.rtkCompaction);
    expect(details.fullOutputPath).toBe(priorDetails.fullOutputPath);
    expect(priorDetails.toolDisplay.durationMs).toBe(-1);
  });

  test.each([null, "legacy", { toolDisplay: "legacy" }])(
    "elapsed duration tolerates legacy details: %j",
    async (details) => {
      const base = fakeBashTool(details);
      const runtime = createRtkRuntime({
        ...DEFAULT_RTK_CONFIG,
        enabled: false,
      });
      const result = await createRtkBashTool(base.tool, runtime).execute(
        "legacy",
        { reasoning: "Check status", command: "git status" },
        undefined,
        undefined,
        { hasUI: false } as never,
      );
      expect(result.details.toolDisplay.durationMs).toBeGreaterThanOrEqual(0);
    },
  );

  test("reasoned wrapper preserves guidelines, callbacks, and execution failures", async () => {
    const base = fakeBashTool();
    const controller = new AbortController();
    const failure = new Error("execution failed");
    const update = () => {};
    const context = { hasUI: false } as never;
    const tool = withReasonedBash({
      ...base.tool,
      promptGuidelines: ["Existing guideline"],
      async execute(id, params, signal, onUpdate, ctx) {
        expect(id).toBe("failed");
        expect(params).toEqual({ command: "false" });
        expect(signal).toBe(controller.signal);
        expect(onUpdate).toBe(update);
        expect(ctx).toBe(context);
        throw failure;
      },
    });
    expect(tool.promptGuidelines).toEqual([
      "Existing guideline",
      "Give bash a short present-tense reasoning goal without repeating its command",
    ]);
    const error = await tool
      .execute(
        "failed",
        { reasoning: "Check failure", command: "false" },
        controller.signal,
        update,
        context,
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBe(failure);
  });

  test("RTK source files do not depend on a sibling display extension", () => {
    const siblingPath = ["..", "tool-display"].join("/");
    for (const file of readdirSync(import.meta.dir).filter((name) =>
      name.endsWith(".ts"),
    )) {
      expect(readFileSync(join(import.meta.dir, file), "utf8")).not.toContain(
        siblingPath,
      );
    }
  });

  test("session reload refreshes cwd and keeps reasoning regardless of drawing config", async () => {
    const cwd = join(
      import.meta.dir,
      `.tmp-rtk-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(cwd, { recursive: true });
    tempDirs.push(cwd);
    const otherCwd = join(cwd, "other");
    mkdirSync(otherCwd);
    for (const [dir, marker] of [
      [cwd, "first"],
      [otherCwd, "second"],
    ]) {
      writeDisplayConfig(dir, true);
      writeFileSync(
        join(dir, ".pi", "rtk.json"),
        JSON.stringify({ enabled: false }),
      );
      writeFileSync(join(dir, "marker.txt"), marker);
    }
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
        handler: (event: unknown, ctx: { cwd: string }) => void,
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
    async function readMarker(): Promise<string> {
      if (!registry) {
        throw new Error("Bash was not registered");
      }
      const result = await registry.execute(
        "marker",
        { reasoning: "Check working directory", command: "cat marker.txt" },
        undefined,
        undefined,
        { hasUI: false } as never,
      );
      return result.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
    }
    rtkExtension(api);

    for (const handler of handlers.get("session_start") ?? []) {
      handler({ type: "session_start" }, { cwd });
    }
    expect(registry?.renderShell).toBeUndefined();
    expect(parameterNames()).toContain("reasoning");

    expect(await readMarker()).toBe("first");
    writeDisplayConfig(otherCwd, false);
    for (const handler of handlers.get("session_switch") ?? []) {
      handler({ type: "session_switch" }, { cwd: otherCwd });
    }
    expect(await readMarker()).toBe("second");
    expect(registry?.renderShell).toBeUndefined();
    expect(registry?.renderCall).toBeUndefined();
    expect(parameterNames()).toContain("reasoning");

    writeDisplayConfig(cwd, true);
    for (const handler of handlers.get("session_start") ?? []) {
      handler({ type: "session_start" }, { cwd });
    }
    expect(registry?.renderShell).toBeUndefined();
    expect(parameterNames()).toContain("reasoning");
    expect(await readMarker()).toBe("first");
    expect(tools).toHaveLength(1);
    expect(refreshCount).toBe(4);
  });
});
