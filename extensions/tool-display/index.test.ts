import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEditToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolRenderContext,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import * as configModule from "./config";
import toolDisplayExtension from "./index";
import {
  cleanupToolDisplayTimers,
  type PresentationState,
} from "./presentation";

const plainTheme = {
  bg: (_token: string, text: string) => text.trimEnd(),
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
};

const tempDirs: string[] = [];
afterEach(() => {
  cleanupToolDisplayTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function projectConfig(editEnabled: boolean): string {
  const cwd = mkdtempSync(join(tmpdir(), "tool-display-registration-"));
  tempDirs.push(cwd);
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "tool-display.json"),
    JSON.stringify({ tools: { edit: { enabled: editEnabled } } }),
  );
  return cwd;
}

type Resolver = Parameters<ExtensionAPI["registerToolRenderer"]>[0];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function harness(initialConfig?: object) {
  const commands = new Map<string, Command>();
  const tools: ToolDefinition[] = [];
  const effectiveTools = new Map<string, ToolDefinition>();
  const resolvers: Resolver[] = [];
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: { cwd: string }) => void>
  >();
  const pi = Object.create(null) as ExtensionAPI;
  Object.assign(pi, {
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
      effectiveTools.set(tool.name, tool);
    },
    registerToolRenderer(resolver: Resolver) {
      resolvers.push(resolver);
    },
    on(event: string, handler: (event: unknown, ctx: { cwd: string }) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  });
  const cwd = projectConfig(false);
  if (initialConfig) {
    writeFileSync(
      join(cwd, ".pi", "tool-display.json"),
      JSON.stringify(initialConfig),
    );
  }
  const priorCwd = process.cwd();
  try {
    process.chdir(cwd);
    toolDisplayExtension(pi);
  } finally {
    process.chdir(priorCwd);
  }
  for (const handler of handlers.get("session_start") ?? []) {
    handler({}, { cwd });
  }
  return {
    tools,
    effectiveTools,
    resolvers,
    cwd,
    handlers,
    runCommand(args: string) {
      const context = {
        cwd,
        ui: { notify() {} },
      } as Parameters<Command["handler"]>[1];
      return commands.get("tool-display")?.handler(args, context);
    },
    resolve(
      name: string,
      next: () => ToolRenderers | undefined = () => undefined,
    ) {
      return resolvers[0]?.(name, next);
    },
  };
}

const owned = ["read", "grep", "find", "ls", "edit", "write", "bash"];

function renderFixture(
  renderers: ToolRenderers,
  args: Record<string, unknown>,
  text = "one\ntwo",
) {
  const context = { args, state: {}, invalidate() {}, argsComplete: true };
  const call = renderers.renderCall?.(
    args,
    plainTheme as never,
    context as never,
  );
  const result = renderers.renderResult?.(
    {
      content: [{ type: "text", text }],
      details: { toolDisplay: { durationMs: 1200 } },
    },
    { expanded: false, isPartial: false },
    plainTheme as never,
    context as never,
  );
  return {
    call: call?.render(160).join("\n"),
    result: result?.render(160).join("\n"),
    context,
  };
}

describe("renderer resolver", () => {
  test("resolves and renders all tools without loading config from disk", () => {
    const h = harness();
    const loadConfig = spyOn(configModule, "loadToolDisplayConfig");
    try {
      for (const name of [...owned, "mcp__figma__get_file"]) {
        const renderers = h.resolve(name) as ToolRenderers;
        renderFixture(renderers, { path: "a.ts", command: "echo hello" });
      }
      expect(loadConfig).not.toHaveBeenCalled();
    } finally {
      loadConfig.mockRestore();
    }
  });

  test("preset off and reset refresh drawing gates without a session reload", async () => {
    const h = harness();
    const upstream: ToolRenderers = { renderShell: "default" };
    await h.runCommand("preset off");
    for (const name of [...owned, "mcp__figma__get_file"]) {
      expect(h.resolve(name, () => upstream)).toBe(upstream);
    }
    await h.runCommand("reset");
    for (const name of [...owned, "mcp__figma__get_file"]) {
      expect(h.resolve(name, () => upstream)?.renderShell).toBe("self");
    }
  });

  test("existing renderers use preview settings refreshed by preset commands", async () => {
    const h = harness();
    const renderers = h.resolve("bash") as ToolRenderers;
    expect(
      renderFixture(renderers, { command: "echo hello" }).result,
    ).not.toContain("two");
    await h.runCommand("preset verbose");
    expect(
      renderFixture(renderers, { command: "echo hello" }).result,
    ).toContain("two");
  });

  test("uses one resolver and owned drawing ignores next even without execution overrides", () => {
    const h = harness({
      tools: {
        read: { enabled: false },
        search: { enabled: false },
        write: { enabled: false },
        edit: { enabled: false },
      },
    });
    expect(h.resolvers).toHaveLength(1);
    for (const name of owned) {
      let calls = 0;
      const r = h.resolve(name, () => {
        calls += 1;
        return {};
      });
      expect(calls).toBe(0);
      expect(r?.renderShell).toBe("self");
      expect(r?.renderCall).toBeFunction();
      expect(r?.renderResult).toBeFunction();
    }
    expect(h.tools).toHaveLength(0);
  });

  test("reads every drawing gate from current config and passes next through when off", () => {
    const h = harness();
    const upstream: ToolRenderers = { renderShell: "default" };
    writeFileSync(
      join(h.cwd, ".pi", "tool-display.json"),
      JSON.stringify({
        output: {
          read: { enabled: false },
          search: { enabled: false },
          bash: { enabled: false },
          fallback: { enabled: false },
        },
        diff: { enabled: false },
      }),
    );
    for (const handler of h.handlers.get("session_switch") ?? []) {
      handler({}, { cwd: h.cwd });
    }
    for (const name of [...owned, "mcp__figma__get_file"]) {
      expect(h.resolve(name, () => upstream)).toBe(upstream);
    }
    writeFileSync(join(h.cwd, ".pi", "tool-display.json"), "{}");
    for (const handler of h.handlers.get("session_start") ?? []) {
      handler({}, { cwd: h.cwd });
    }
    expect(h.resolve("read", () => upstream)?.renderShell).toBe("self");
  });

  test("fills only missing non-owned fields and preserves a complete renderer", () => {
    const h = harness();
    const full = h.resolve("read") as ToolRenderers;
    expect(h.resolve("custom", () => full)).toBe(full);
    for (const field of ["renderCall", "renderResult"] as const) {
      const partial: ToolRenderers = {
        renderShell: "default",
        [field]: full[field],
      };
      const composed = h.resolve("custom", () => partial);
      expect(composed?.[field]).toBe(partial[field]);
      expect(composed?.renderCall).toBeFunction();
      expect(composed?.renderResult).toBeFunction();
      expect(composed?.renderShell).toBe("default");
    }
    expect(h.resolve("custom", () => ({}))?.renderShell).toBe("self");
  });

  test.each([false, true])(
    "settles generic headers with a preserved custom result renderer (error=%s)",
    (isError) => {
      const h = harness();
      const customResult: NonNullable<ToolRenderers["renderResult"]> = () =>
        new Text("custom result", 0, 0);
      const r = h.resolve("result_only", () => ({
        renderResult: customResult,
      })) as ToolRenderers;
      expect(r.renderResult).toBe(customResult);
      const context: ToolRenderContext<
        PresentationState,
        Record<string, unknown>
      > = {
        args: { key: "abc" },
        state: {},
        invalidate() {},
        toolCallId: "result-only",
        lastComponent: undefined,
        cwd: h.cwd,
        executionStarted: false,
        argsComplete: false,
        isPartial: true,
        expanded: false,
        showImages: false,
        isError: false,
      };
      const drawCall = () =>
        r
          .renderCall?.(context.args, plainTheme as never, context)
          ?.render(100)
          .join("\n");
      expect(drawCall()).toContain("•");
      context.executionStarted = true;
      context.argsComplete = true;
      expect(drawCall()).toContain("→");
      const pendingTimer = context.state.toolDisplayPresentation?.timer;
      expect(pendingTimer).toBeDefined();
      const clear = spyOn(globalThis, "clearTimeout");
      try {
        context.isPartial = false;
        context.isError = isError;
        expect(drawCall()).toContain(isError ? "×" : "✓");
        expect(drawCall()).not.toContain("→");
        expect(context.state.toolDisplayPresentation?.settled).toBe(true);
        expect(context.state.toolDisplayPresentation?.error).toBe(isError);
        expect(context.state.toolDisplayPresentation?.timer).toBeUndefined();
        expect(clear).toHaveBeenCalledWith(pendingTimer);
        expect(
          r
            .renderResult?.(
              { content: [{ type: "text", text: "done" }], details: {} },
              { expanded: false, isPartial: false },
              plainTheme as never,
              context,
            )
            ?.render(100)
            .join("\n")
            .trimEnd(),
        ).toBe("custom result");
        drawCall();
        expect(context.state.toolDisplayPresentation?.timer).toBeUndefined();

        // Stored results can settle without markExecutionStarted ever being called.
        context.state = {};
        context.executionStarted = false;
        expect(drawCall()).toContain(isError ? "×" : "✓");
        expect(context.state.toolDisplayPresentation?.timer).toBeUndefined();
      } finally {
        clear.mockRestore();
      }
    },
  );

  test("draws unregistered resumed MCP calls, sanitizes args and body, expands previews", () => {
    const h = harness({ output: { fallback: { previewLines: 1 } } });
    const r = h.resolve("mcp__figma__get_file") as ToolRenderers;
    expect(r.renderShell).toBe("self");
    const rendered = renderFixture(
      r,
      { reasoning: "Inspect\nfile\u0007", key: "\u001b[31mabc\u001b[0m" },
      "\u001b[31mfirst\u001b[0m\nsecond",
    );
    expect(rendered.call).toContain("mcp__figma__get_file Inspect file");
    expect(rendered.result).toContain("first");
    expect(rendered.result).not.toContain("second");
    expect(rendered.result).toContain("1s");
    expect(rendered.result).not.toContain("\u001b[31m");
    const expanded = r.renderResult?.(
      {
        content: [
          { type: "text", text: "first\nsecond" },
          { type: "image", data: "", mimeType: "image/png" },
        ],
        details: {},
      },
      { expanded: true, isPartial: false },
      plainTheme as never,
      rendered.context as never,
    );
    expect(expanded?.render(160).join("\n")).toContain("second");
    expect(expanded?.render(160).join("\n")).toContain("[image]");
  });

  test("fallback respects state duration and Pi error context on redraw", () => {
    const h = harness();
    const r = h.resolve("custom") as ToolRenderers;
    const rendered = renderFixture(r, { key: "abc" });
    const redraw = r.renderResult?.(
      { content: [{ type: "text", text: "denied" }], details: {} },
      { expanded: false, isPartial: false },
      plainTheme as never,
      { ...rendered.context, isError: true } as never,
    );
    expect(redraw?.render(160).join("\n")).toContain("error in 1s");
  });

  test("draws bash by name without RTK and tolerates missing reasoning", () => {
    const h = harness();
    for (const name of owned) {
      const r = h.resolve(name) as ToolRenderers;
      const rendered = renderFixture(r, {
        path: "a.ts",
        command: "echo hello",
      });
      expect(rendered.call).not.toContain("undefined");
      expect(rendered.result).not.toContain("RTK");
      if (name === "bash") {
        expect(rendered.call).toContain("⚡️ bash echo hello");
        const compacted = r.renderResult?.(
          {
            content: [{ type: "text", text: "done" }],
            details: {
              rtkCompaction: {
                savedChars: 90,
                originalChars: 120,
                finalChars: 30,
              },
            },
          },
          { expanded: false, isPartial: false },
          plainTheme as never,
          rendered.context as never,
        );
        expect(compacted?.render(160).join("\n")).toContain("RTK saved 90");
      }
    }
  });

  test("native edit supplies final diff details without re-registration", async () => {
    const h = harness();
    writeFileSync(join(h.cwd, "a.ts"), "old\n");
    const args = { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] };
    const native = createEditToolDefinition(h.cwd);
    const result = await native.execute(
      "edit",
      args,
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details?.diff).toContain("+1 new");
    const r = h.resolve("edit");
    const expanded = r?.renderResult?.(
      result,
      { expanded: true, isPartial: false },
      plainTheme as never,
      { args, state: {}, invalidate() {} } as never,
    );
    expect(expanded?.render(100).join("\n")).toContain("new");
    expect(h.tools.some((t) => t.name === "edit")).toBe(false);
  });
});

describe("execution registration", () => {
  test("registers reasoning/schema overrides without drawing and only opts into candidate edit", () => {
    const h = harness();
    expect(h.tools.map((t) => t.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "write",
    ]);
    for (const tool of h.tools) {
      expect(Object.keys(tool.parameters.properties)[0]).toBe("reasoning");
      expect(tool.parameters.required?.[0]).toBe("reasoning");
      expect(tool.renderShell).toBeUndefined();
      expect(tool.renderCall).toBeUndefined();
      expect(tool.renderResult).toBeUndefined();
    }
    for (const handler of h.handlers.get("session_switch") ?? []) {
      handler({}, { cwd: projectConfig(true) });
    }
    const edit = h.tools.find((t) => t.name === "edit");
    expect(Object.keys(edit?.parameters.properties ?? {})).toEqual(["text"]);
    expect(edit?.renderCall).toBeUndefined();
    expect(edit?.renderResult).toBeUndefined();
    expect(edit?.renderShell).toBeUndefined();
  });

  test("restores effective native edit schema and execution after disabling candidate edit", async () => {
    const h = harness();
    const candidateCwd = projectConfig(true);
    for (const handler of h.handlers.get("session_switch") ?? []) {
      handler({}, { cwd: candidateCwd });
    }
    expect(
      Object.keys(h.effectiveTools.get("edit")?.parameters.properties ?? {}),
    ).toEqual(["text"]);

    for (const handler of h.handlers.get("session_switch") ?? []) {
      handler({}, { cwd: h.cwd });
    }
    const restored = h.effectiveTools.get("edit");
    const native = createEditToolDefinition(h.cwd);
    expect(restored?.parameters).toEqual(native.parameters);
    expect(restored?.prepareArguments).toBe(native.prepareArguments);
    expect(restored?.renderCall).toBeUndefined();
    expect(restored?.renderResult).toBeUndefined();
    expect(restored?.renderShell).toBeUndefined();
    writeFileSync(join(h.cwd, "a.ts"), "old\n");
    writeFileSync(join(candidateCwd, "a.ts"), "candidate workspace\n");
    const result = await restored?.execute(
      "restored-edit",
      { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
      undefined,
      undefined,
      { cwd: h.cwd } as never,
    );
    expect(readFileSync(join(h.cwd, "a.ts"), "utf8")).toBe("new\n");
    expect(readFileSync(join(candidateCwd, "a.ts"), "utf8")).toBe(
      "candidate workspace\n",
    );
    expect(result?.details).toEqual(
      expect.objectContaining({ diff: expect.stringContaining("+1 new") }),
    );

    const nextCwd = projectConfig(false);
    writeFileSync(join(nextCwd, "a.ts"), "old\n");
    for (const handler of h.handlers.get("session_switch") ?? []) {
      handler({}, { cwd: nextCwd });
    }
    await h.effectiveTools
      .get("edit")
      ?.execute(
        "next-native-edit",
        { path: "a.ts", edits: [{ oldText: "old", newText: "next" }] },
        undefined,
        undefined,
        { cwd: nextCwd } as never,
      );
    expect(readFileSync(join(nextCwd, "a.ts"), "utf8")).toBe("next\n");
    expect(readFileSync(join(h.cwd, "a.ts"), "utf8")).toBe("new\n");
  });
});
