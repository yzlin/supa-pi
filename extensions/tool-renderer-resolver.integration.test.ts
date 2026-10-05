/**
 * SDK-level resumed-call probe using Pi 1.0.1's real loader, ExtensionRunner,
 * and terminal built-in renderer lookup. No MCP connection or live TUI/HTML
 * export is exercised; the disconnected call is supplied as stored args/result.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ToolRenderContext,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";

import { AuthStorage } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { withBuiltInRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import {
  initTheme,
  theme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import rtkExtension from "./rtk";
import toolDisplayExtension from "./tool-display";

const ownCall: NonNullable<ToolRenderers["renderCall"]> = () =>
  new Text("custom call", 0, 0);
const ownResult: NonNullable<ToolRenderers["renderResult"]> = () =>
  new Text("custom result", 0, 0);
let cwd: string;
let nativeRunner: ExtensionRunner;
let rtkRunner: ExtensionRunner;

beforeAll(async () => {
  initTheme("dark", false);
  cwd = mkdtempSync(join(tmpdir(), "tool-renderer-sdk-probe-"));
  mkdirSync(join(cwd, ".pi"));
  // Pin the probe's gates regardless of machine-local global config.
  writeFileSync(
    join(cwd, ".pi", "tool-display.json"),
    JSON.stringify({
      tools: { edit: { enabled: false } },
      output: {
        bash: { enabled: true },
        fallback: { enabled: true, mode: "compact", collapsed: true },
      },
    }),
  );
  const registry = new ModelRegistry(
    await ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }),
  );

  async function loadRunner(withRtk: boolean) {
    const runtime = createExtensionRuntime();
    const eventBus = createEventBus();
    const extensions = [];
    if (withRtk) {
      extensions.push(
        await loadExtensionFromFactory(rtkExtension, cwd, eventBus, runtime),
      );
    }
    extensions.push(
      await loadExtensionFromFactory(
        toolDisplayExtension,
        cwd,
        eventBus,
        runtime,
      ),
      await loadExtensionFromFactory(
        (pi) => {
          for (const name of ["custom_partial", "custom_complete"]) {
            pi.registerTool({
              name,
              label: name,
              description: "Renderer composition fixture",
              parameters: Type.Object({}),
              renderShell: "default",
              renderCall: ownCall,
              ...(name === "custom_complete"
                ? { renderResult: ownResult }
                : {}),
              async execute() {
                return {
                  content: [{ type: "text", text: "fixture" }],
                  details: {},
                };
              },
            });
          }
        },
        cwd,
        eventBus,
        runtime,
      ),
    );
    return new ExtensionRunner(
      extensions,
      runtime,
      cwd,
      SessionManager.inMemory(cwd),
      registry,
    );
  }

  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    nativeRunner = await loadRunner(false);
    rtkRunner = await loadRunner(true);
  } finally {
    process.chdir(previousCwd);
  }
});

afterAll(async () => {
  await nativeRunner?.emit({ type: "session_shutdown" });
  await rtkRunner?.emit({ type: "session_shutdown" });
  if (cwd) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function resolve(runner: ExtensionRunner, name: string): ToolRenderers {
  // Same terminal lookup used by Pi's tool execution presentation.
  const renderers = runner.resolveToolRenderers(name, () =>
    withBuiltInRenderers(name, runner.getToolDefinition(name)),
  );
  if (!renderers?.renderCall || !renderers.renderResult) {
    throw new Error(`Expected complete renderers for ${name}`);
  }
  return renderers;
}

function renderStoredCall(
  renderers: ToolRenderers,
  args: Record<string, unknown>,
) {
  const context: ToolRenderContext<
    Record<string, unknown>,
    Record<string, unknown>
  > = {
    args,
    toolCallId: "resumed-call",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
  };
  const call = renderers.renderCall?.(args, theme, context)?.render(80) ?? [];
  const result =
    renderers
      .renderResult?.(
        {
          content: [
            {
              type: "text",
              text: "Design document\nA frame with two buttons.",
            },
          ],
          details: { toolDisplay: { durationMs: 120 } },
        },
        { expanded: true, isPartial: false },
        theme,
        context,
      )
      ?.render(80) ?? [];
  for (const lines of [call, result]) {
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.trim().length > 0)).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  }
  return { call, result };
}

describe("Pi 1.0.1 renderer resolver SDK probe", () => {
  test("draws a disconnected MCP-style resumed call without a registered definition", () => {
    const name = "mcp__figma__get_file";
    expect(rtkRunner.getToolDefinition(name)).toBeUndefined();
    expect(withBuiltInRenderers(name, undefined)).toBeUndefined();
    const renderers = resolve(rtkRunner, name);
    expect(renderers.renderShell).toBe("self");
    // Old sessions and native/MCP tools need no reasoning argument.
    const { call, result } = renderStoredCall(renderers, {
      fileKey: "design-123",
      depth: 2,
    });
    expect(call.join("\n")).toContain(name);
    expect(result.join("\n")).toContain("Design document");
  });

  test("fills only the missing result renderer on a registered tool", () => {
    const renderers = resolve(rtkRunner, "custom_partial");
    expect(renderers.renderResult).toBeFunction();
    expect(renderers.renderShell).toBe("default");
    const { call, result } = renderStoredCall(renderers, {});
    expect(call.join("\n").trimEnd()).toBe("custom call");
    expect(result.join("\n")).toContain("Design document");
  });

  test("draws complete registered renderers unchanged", () => {
    const definition = rtkRunner.getToolDefinition("custom_complete");
    expect(definition?.renderCall).toBe(ownCall);
    expect(definition?.renderResult).toBe(ownResult);
    const renderers = resolve(rtkRunner, "custom_complete");
    expect(renderers.renderShell).toBe(definition?.renderShell);
    const { call, result } = renderStoredCall(renderers, {});
    expect(call.join("\n").trimEnd()).toBe("custom call");
    expect(result.join("\n").trimEnd()).toBe("custom result");
  });

  test("draws bash by name both with RTK execution and without a registration", () => {
    expect(nativeRunner.getToolDefinition("bash")).toBeUndefined();
    const bash = rtkRunner.getToolDefinition("bash");
    expect(bash?.parameters.required).toContain("reasoning");
    expect(bash?.renderCall).toBeUndefined();
    expect(bash?.renderResult).toBeUndefined();
    for (const runner of [nativeRunner, rtkRunner]) {
      const renderers = resolve(runner, "bash");
      expect(renderers.renderShell).toBe("self");
      const { call } = renderStoredCall(renderers, { command: "printf hello" });
      expect(call).toHaveLength(2);
      expect(call.join("\n")).toContain("printf hello");
    }
  });
});
