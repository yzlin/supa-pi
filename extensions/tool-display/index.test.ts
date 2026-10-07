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
import { stripVTControlCharacters } from "node:util";

import {
  createEditToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolRenderContext,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { companionFixtures } from "./companion-fixtures";
import * as configModule from "./config";
import toolDisplayExtension from "./index";
import {
  cleanupToolDisplayTimers,
  renderGenericToolCall,
  renderGenericToolResult,
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

test("codemode redraws live nested subagent previews without parent result updates", () => {
  const h = harness();
  const emit = (type: string, event: object) => {
    for (const handler of h.handlers.get(type) ?? []) {
      handler({ type, ...event }, { cwd: h.cwd });
    }
  };
  const args = { code: "await tools.subagent({ task: 'Inspect' });" };
  let redraws = 0;
  const context = {
    args,
    toolCallId: "parent",
    state: {},
    invalidate() {
      redraws += 1;
    },
    argsComplete: true,
  };
  const call = h
    .resolve("codemode")
    ?.renderCall?.(args, plainTheme as never, context as never);
  const rows = () =>
    stripVTControlCharacters(call?.render(100).join("\n") ?? "");
  emit("tool_execution_start", {
    toolCallId: "parent",
    toolName: "codemode",
    args,
  });
  emit("tool_execution_update", {
    toolCallId: "parent/1",
    parentToolCallId: "parent",
    toolName: "subagent",
    partialResult: {
      details: {
        runId: "run-one",
        status: "running",
        attachCommand: "pi --attach-subagent run-one",
        text: "first preview",
      },
    },
  });
  expect(rows()).toContain("first preview");
  expect(rows()).toContain("pi --attach-subagent run-one");
  expect(redraws).toBeGreaterThan(0);
  emit("tool_execution_update", {
    toolCallId: "parent/1",
    parentToolCallId: "parent",
    toolName: "subagent",
    partialResult: {
      details: { runId: "run-one", status: "running", text: "second preview" },
    },
  });
  expect(rows()).toContain("second preview");
  expect(rows()).not.toContain("first preview");
  emit("tool_execution_end", {
    toolCallId: "parent/1",
    parentToolCallId: "parent",
    toolName: "subagent",
  });
  expect(rows()).not.toContain("second preview");
});

test("nested previews isolate parents and children, ignore bad events, and clear on lifecycle changes", () => {
  const h = harness();
  const emit = (type: string, event: object) => {
    for (const handler of h.handlers.get(type) ?? []) {
      handler({ type, ...event }, { cwd: h.cwd });
    }
  };
  const create = (toolCallId: string) => {
    const args = { code: "await tools.subagent({ task: 'Inspect' });" };
    emit("tool_execution_start", { toolCallId, toolName: "codemode", args });
    const component = h.resolve("codemode")?.renderCall?.(
      args,
      plainTheme as never,
      {
        toolCallId,
        args,
        state: {},
        invalidate() {},
      } as never,
    );
    return () =>
      stripVTControlCharacters(component?.render(100).join("\n") ?? "");
  };
  const update = (
    parentToolCallId: string | undefined,
    toolCallId: string,
    text: string,
    toolName = "subagent",
  ) =>
    emit("tool_execution_update", {
      parentToolCallId,
      toolCallId,
      toolName,
      partialResult: { details: { status: "queued", runId: toolCallId, text } },
    });
  const a = create("a");
  const b = create("b");
  update("a", "a/1", "FIRST_CHILD");
  update("a", "a/2", "SECOND_CHILD");
  update("b", "b/1", "OTHER_PARENT");
  update(undefined, "direct", "DIRECT_CALL");
  update("unknown", "unknown/1", "UNKNOWN_PARENT");
  update("a", "a/3", "NOT_SUBAGENT", "read");
  emit("tool_execution_update", {
    parentToolCallId: "a",
    toolCallId: "a/4",
    toolName: "subagent",
    partialResult: { details: { status: "running", text: "MALFORMED" } },
  });
  expect(a()).toContain("FIRST_CHILD");
  expect(a()).toContain("SECOND_CHILD");
  expect(a()).not.toMatch(
    /OTHER_PARENT|DIRECT_CALL|UNKNOWN_PARENT|NOT_SUBAGENT|MALFORMED/u,
  );
  expect(b()).toContain("OTHER_PARENT");
  expect(b()).not.toContain("FIRST_CHILD");
  emit("tool_execution_end", {
    parentToolCallId: "a",
    toolCallId: "a/1",
    toolName: "subagent",
    isError: true,
  });
  expect(a()).not.toContain("FIRST_CHILD");
  expect(a()).toContain("SECOND_CHILD");
  emit("tool_execution_end", {
    toolCallId: "a",
    toolName: "codemode",
    isError: true,
  });
  expect(a()).not.toContain("SECOND_CHILD");
  expect(b()).toContain("OTHER_PARENT");
  for (const type of ["session_switch", "session_start", "session_shutdown"]) {
    const parentId = `lifecycle-${type}`;
    const rows = create(parentId);
    update(parentId, `${parentId}/1`, "LIVE_PREVIEW");
    expect(rows()).toContain("LIVE_PREVIEW");
    emit(type, {});
    expect(rows()).not.toContain("LIVE_PREVIEW");
    update(parentId, `${parentId}/1`, "LATE_UPDATE");
    expect(rows()).not.toContain("LATE_UPDATE");
  }
  expect(b()).not.toContain("OTHER_PARENT");
});

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
          mcp: { enabled: false },
          codemode: { enabled: false },
          web: { enabled: false },
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
    const args = { reasoning: "Read file", path: "a.ts" };
    const original = renderFixture(full, args);
    const preserved = h.resolve("custom", () => full) as ToolRenderers;
    expect(preserved.renderShell).toBe(full.renderShell);
    const drawn = renderFixture(preserved, args);
    expect([drawn.call, drawn.result]).toEqual([
      original.call,
      original.result,
    ]);
    for (const field of ["renderCall", "renderResult"] as const) {
      const partial: ToolRenderers = {
        renderShell: "default",
        [field]: full[field],
      };
      const composed = h.resolve("custom", () => partial) as ToolRenderers;
      const key = field === "renderCall" ? "call" : "result";
      expect(renderFixture(composed, args)[key]).toBe(original[key]);
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
        expect(drawCall()).toContain(isError ? "✗" : "✓");
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
        expect(drawCall()).toContain(isError ? "✗" : "✓");
        expect(context.state.toolDisplayPresentation?.timer).toBeUndefined();
      } finally {
        clear.mockRestore();
      }
    },
  );

  test("draws unregistered resumed MCP calls, sanitizes args and body, expands previews", () => {
    const h = harness({ output: { mcp: { previewLines: 1 } } });
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

describe("companion renderer ownership", () => {
  test("owns every curated tool without resolving package renderers", () => {
    const h = harness();
    const upstream: ToolRenderers = {
      renderShell: "default",
      renderCall: () => new Text("package call", 0, 0),
      renderResult: () => new Text("package result", 0, 0),
    };
    for (const fixture of companionFixtures) {
      let nextCalls = 0;
      const renderer = h.resolve(fixture.name, () => {
        nextCalls += 1;
        return upstream;
      });
      expect(nextCalls).toBe(0);
      expect(renderer?.renderShell).toBe("self");
      const context = {
        args: fixture.args,
        state: {},
        invalidate() {},
        argsComplete: true,
      };
      const call = renderer?.renderCall?.(
        fixture.args,
        plainTheme as never,
        context as never,
      );
      expect(call?.render(180).join("\n")).toContain(fixture.call);
      const result = renderer?.renderResult?.(
        {
          content: [{ type: "text", text: fixture.text }],
          details: fixture.details,
        },
        { expanded: false, isPartial: false },
        plainTheme as never,
        context as never,
      );
      if (fixture.name === "codemode") {
        expect(call?.render(180)[0]).toContain(fixture.summary);
        expect(result?.render(180)).toHaveLength(1);
        expect(result?.render(180)[0]).toContain("✓ read");
      } else {
        expect(result?.render(180).join("\n")).toContain(fixture.summary);
        expect(result?.render(180)).toHaveLength(1);
      }
      expect(h.tools.some((tool) => tool.name === fixture.name)).toBe(false);
    }
  });

  test("each group gate passes next() through unchanged, independent of fallback", () => {
    for (const group of ["mcp", "codemode", "web"]) {
      const h = harness({ output: { [group]: { enabled: false } } });
      const upstream: ToolRenderers = { renderShell: "default" };
      for (const fixture of companionFixtures.filter(
        (item) => item.group === group,
      )) {
        let calls = 0;
        expect(
          h.resolve(fixture.name, () => {
            calls += 1;
            return upstream;
          }),
        ).toBe(upstream);
        expect(calls).toBe(1);
        expect(h.resolve(fixture.name, () => undefined)).toBeUndefined();
      }
    }
  });

  test("the MCP prefix is the only prefix rule; subagent remains runtime-owned", () => {
    const h = harness();
    const upstream: ToolRenderers = {
      renderCall: () => new Text("package", 0, 0),
      renderResult: () => new Text("package", 0, 0),
    };
    for (const name of [
      "mcpScript",
      "xmcp__a",
      "TaskSomething",
      "subagent",
      "renamed_web_search",
      "web_search_extra",
    ]) {
      const r = h.resolve(name, () => upstream);
      expect(r?.renderShell).toBeUndefined();
      expect(
        r
          ?.renderCall?.({}, plainTheme as never, {} as never)
          .render(80)
          .join("\n")
          .trimEnd(),
      ).toBe("package");
    }
    for (const name of ["mcp__", "mcp__server", "mcp__server__prompt"]) {
      expect(h.resolve(name, () => upstream)?.renderShell).toBe("self");
    }
  });

  test("shape drift uses the exact generic call/result paths instead of package renderers", () => {
    const h = harness({ output: { fallback: { enabled: false } } });
    for (const fixture of companionFixtures) {
      const renderer = h.resolve(fixture.name) as ToolRenderers;
      const args = { unfamiliar: ["shape"] };
      const context = { args, state: {}, invalidate() {} };
      expect(
        renderer
          .renderCall?.(args, plainTheme as never, context as never)
          ?.render(180),
      ).toEqual(
        renderGenericToolCall(fixture.name, args, plainTheme, context).render(
          180,
        ),
      );
      const result = {
        content: [{ type: "text", text: "unknown\nbody\u001b[31m" }],
        details: { unfamiliar: true },
      };
      expect(
        renderer
          .renderResult?.(
            result,
            { expanded: false },
            plainTheme as never,
            context as never,
          )
          ?.render(180),
      ).toEqual(
        renderGenericToolResult(
          fixture.name,
          result,
          { expanded: false },
          plainTheme,
          context,
          configModule.DEFAULT_TOOL_DISPLAY_CONFIG.output.fallback,
        ).render(180),
      );
    }
  });

  test("codemode missing calls falls back even with valid script args, while expansion reveals script and output", () => {
    const h = harness();
    const renderer = h.resolve("codemode") as ToolRenderers;
    const args = { code: "first();\n\nsecond();\nthird();" };
    const context = { args, state: {}, invalidate() {} };
    const call = renderer.renderCall?.(
      args,
      plainTheme as never,
      context as never,
    );
    const result = {
      content: [{ type: "text", text: "Script completed\nfull output" }],
      details: {},
    };
    expect(
      renderer
        .renderResult?.(
          result,
          { expanded: false },
          plainTheme as never,
          context as never,
        )
        ?.render(180),
    ).toEqual(
      renderGenericToolResult(
        "codemode",
        result,
        { expanded: false },
        plainTheme,
        context,
        configModule.DEFAULT_TOOL_DISPLAY_CONFIG.output.fallback,
      ).render(180),
    );
    const expanded = renderer
      .renderResult?.(
        { ...result, details: { calls: [] } },
        { expanded: true },
        plainTheme as never,
        context as never,
      )
      ?.render(180)
      .join("\n");
    expect(
      call?.render(180).map(stripVTControlCharacters).join("\n"),
    ).toContain("second();");
    expect(
      call?.render(180).map(stripVTControlCharacters).join("\n"),
    ).toContain("third();");
    expect(expanded).toContain("full output");
  });
});

describe("companion presentation groups", () => {
  test("icons and names use curated theme tokens", () => {
    const h = harness();
    for (const fixture of companionFixtures) {
      const tokens: Array<[string, string]> = [];
      const tokenTheme = {
        ...plainTheme,
        fg(token: string, text: string) {
          tokens.push([token, text]);
          return text;
        },
      };
      const renderer = h.resolve(fixture.name);
      renderer
        ?.renderCall?.(
          fixture.args,
          tokenTheme as never,
          { args: fixture.args, state: {}, invalidate() {} } as never,
        )
        ?.render(180);
      const color = {
        mcp: "accent",
        codemode: "thinkingXhigh",
        web: "accent",
      }[fixture.group];
      const icon = { mcp: "🔌", codemode: "🧩", web: "🌐" }[fixture.group];
      expect(tokens).toContainEqual([color, fixture.name]);
      expect(tokens).toContainEqual([color, icon]);
      expect(visibleWidth(icon)).toBe(2);
    }
  });

  test("partial snapshots retain pending rows; result settings refresh on existing renderers", async () => {
    const h = harness();
    const fixture = companionFixtures.find((item) => item.name === "codemode");
    if (!fixture) {
      throw new Error("missing fixture");
    }
    const renderer = h.resolve(fixture.name) as ToolRenderers;
    const context = { args: fixture.args, state: {}, invalidate() {} };
    const result = {
      content: [{ type: "text", text: "Script completed\nfull output" }],
      details: fixture.details,
    };
    const call = renderer.renderCall?.(
      fixture.args,
      plainTheme as never,
      context as never,
    );
    call?.render(180);
    expect(
      renderer
        .renderResult?.(
          { content: [], details: fixture.details },
          { expanded: false, isPartial: true },
          plainTheme as never,
          context as never,
        )
        ?.render(180),
    ).toHaveLength(1);
    expect(call?.render(180)[0]).toContain("1 tool call → running");
    expect(
      renderer
        .renderResult?.(
          result,
          { expanded: false },
          plainTheme as never,
          context as never,
        )
        ?.render(180),
    ).toHaveLength(1);
    await h.runCommand("preset verbose");
    expect(
      renderer
        .renderResult?.(
          result,
          { expanded: false },
          plainTheme as never,
          context as never,
        )
        ?.render(180)
        .join("\n"),
    ).toContain("full output");
    expect(
      call?.render(180).map(stripVTControlCharacters).join("\n"),
    ).toContain("console.log(x)");
    await h.runCommand("preset off");
    const upstream: ToolRenderers = { renderShell: "default" };
    for (const item of companionFixtures) {
      expect(h.resolve(item.name, () => upstream)).toBe(upstream);
    }
  });
});

test("companion call and result drift degrade independently", () => {
  const h = harness();
  const renderer = h.resolve("codemode") as ToolRenderers;
  const args = { code: ["legacy shape"] };
  const context = { args, state: {}, invalidate() {} };
  expect(
    renderer
      .renderCall?.(args, plainTheme as never, context as never)
      ?.render(180)
      .join("\n"),
  ).toContain("🔧");
  const result = {
    content: [{ type: "text", text: "Script completed" }],
    details: { calls: [] },
  };
  expect(
    renderer
      .renderResult?.(
        result,
        { expanded: false },
        plainTheme as never,
        context as never,
      )
      ?.render(180)
      .join("\n"),
  ).toContain("0 tool calls · 16 bytes");
});

test("companion fallback safely handles malformed reasoning and non-object stored args", () => {
  const h = harness();
  const renderer = h.resolve("codemode") as ToolRenderers;
  for (const args of [
    null,
    [],
    "legacy",
    { code: 123, reasoning: { legacy: true } },
  ]) {
    const context = { args, state: {}, invalidate() {} };
    expect(() =>
      renderer
        .renderCall?.(args as never, plainTheme as never, context as never)
        ?.render(100),
    ).not.toThrow();
    const result = {
      content: [{ type: "text", text: "Legacy output" }],
      details: {},
    };
    expect(() =>
      renderer
        .renderResult?.(
          result,
          { expanded: false },
          plainTheme as never,
          context as never,
        )
        ?.render(100),
    ).not.toThrow();
    expect(() =>
      renderer
        .renderResult?.(
          { ...result, details: { calls: [] } },
          { expanded: true },
          plainTheme as never,
          context as never,
        )
        ?.render(100),
    ).not.toThrow();
  }
});

describe("tool block background", () => {
  const ansiTheme = {
    bg: (_token: string, text: string) => `\u001b[48;5;22m${text}\u001b[49m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    fg: (_token: string, text: string) => `\u001b[38;5;245m${text}\u001b[39m`,
  };

  // Returns visible columns drawn without a background colour.
  function columnsWithoutBackground(line: string): number[] {
    let background = false;
    let column = 0;
    const missing: number[] = [];
    // oxlint-disable-next-line no-control-regex -- SGR codes start with the terminal escape character.
    for (const match of line.matchAll(/\u001b\[([0-9;]*)m|([^\u001b])/g)) {
      if (match[2] !== undefined) {
        if (!background) {
          missing.push(column);
        }
        column += 1;
        continue;
      }
      const codes = (match[1] || "0").split(";").map(Number);
      for (let index = 0; index < codes.length; index += 1) {
        const code = codes[index];
        if (code === 0 || code === 49) {
          background = false;
        } else if (code === 38 || code === 48) {
          background ||= code === 48;
          index += codes[index + 1] === 5 ? 2 : 4;
        } else if (code >= 40 && code <= 47) {
          background = true;
        }
      }
    }
    return missing;
  }

  function inHostShell(component: Component | undefined): string[] {
    const box = new Box(1, 0, (text) => ansiTheme.bg("toolSuccessBg", text));
    if (component) {
      box.addChild(component);
    }
    return box.render(100);
  }

  const truncatedHeader = () =>
    new Text(
      `ask ${ansiTheme.fg("dim", `(${truncateToWidth("label, ".repeat(10), 40)})`)}`,
      0,
      0,
    );

  test("keeps the background after resets in other tools' renderers", () => {
    const h = harness();
    const upstream: ToolRenderers = {
      renderCall: truncatedHeader,
      renderResult: truncatedHeader,
    };
    const context = { args: {}, state: {}, invalidate() {} };
    expect(
      inHostShell(
        upstream.renderCall?.({}, ansiTheme as never, context as never),
      ).flatMap(columnsWithoutBackground),
    ).not.toEqual([]);

    const resolved = h.resolve("ask", () => upstream);
    const call = resolved?.renderCall?.(
      {},
      ansiTheme as never,
      context as never,
    );
    const result = resolved?.renderResult?.(
      { content: [], details: {} },
      { expanded: false, isPartial: false },
      ansiTheme as never,
      context as never,
    );
    expect(inHostShell(call).flatMap(columnsWithoutBackground)).toEqual([]);
    expect(inHostShell(result).flatMap(columnsWithoutBackground)).toEqual([]);
    expect(stripVTControlCharacters(inHostShell(call).join(""))).toContain(
      "ask (label, label,",
    );
  });

  test("keeps the background after a tail-truncated self-drawn header", () => {
    const h = harness();
    const args = {
      reasoning: "Inspect current pane and read options",
      command: "herdr pane read --help 2>&1 | head -30",
    };
    const call = h.resolve("bash")?.renderCall?.(
      args,
      ansiTheme as never,
      {
        args,
        state: {},
        invalidate() {},
        argsComplete: true,
      } as never,
    );
    const lines = call?.render(30) ?? [];
    expect(stripVTControlCharacters(lines.join("\n"))).toContain("…");
    expect(lines.flatMap(columnsWithoutBackground)).toEqual([]);
  });

  test("passes the original component back to other tools' renderers", () => {
    const h = harness();
    const original = new Text("call", 0, 0);
    const seen: unknown[] = [];
    const resolved = h.resolve("ask", () => ({
      renderCall: (_args, _theme, context) => {
        seen.push(context.lastComponent);
        return original;
      },
      renderResult: () => new Text("result", 0, 0),
    }));
    const first = resolved?.renderCall?.(
      {},
      ansiTheme as never,
      {
        lastComponent: undefined,
      } as never,
    );
    const second = resolved?.renderCall?.(
      {},
      ansiTheme as never,
      {
        lastComponent: first,
      } as never,
    );
    expect(seen).toEqual([undefined, original]);
    expect(second).toBe(first);
    first?.invalidate();
  });
});

test("retired task tools and subagent preserve supplied renderers and fill missing historical renderers only", () => {
  const h = harness();
  const upstream: ToolRenderers = {
    renderShell: "default",
    renderCall: () => new Text("supplied call", 0, 0),
    renderResult: () => new Text("supplied result", 0, 0),
  };
  for (const name of [
    "TaskCreate",
    "TaskList",
    "TaskGet",
    "TaskUpdate",
    "TaskOutput",
    "TaskStop",
    "TaskExecute",
    "subagent",
  ]) {
    let nextCalls = 0;
    const renderer = h.resolve(name, () => {
      nextCalls += 1;
      return upstream;
    });
    expect(nextCalls).toBe(1);
    expect(renderer?.renderShell).toBe("default");
    const context = {
      args: { subject: "historic", description: "data" },
      state: {},
      invalidate() {},
    };
    expect(
      renderer
        ?.renderCall?.(context.args, plainTheme as never, context as never)
        ?.render(100)
        .join("\n")
        .trimEnd(),
    ).toBe("supplied call");
    expect(
      renderer
        ?.renderResult?.(
          { content: [{ type: "text", text: "historic output" }] },
          { expanded: false },
          plainTheme as never,
          context as never,
        )
        ?.render(100)
        .join("\n")
        .trimEnd(),
    ).toBe("supplied result");
    const fallback = h.resolve(name, () => undefined);
    expect(
      fallback
        ?.renderCall?.(context.args, plainTheme as never, context as never)
        ?.render(100)
        .join("\n"),
    ).toContain("🔧");
    expect(
      fallback
        ?.renderResult?.(
          { content: [{ type: "text", text: "historic output" }] },
          { expanded: false },
          plainTheme as never,
          context as never,
        )
        ?.render(100)
        .join("\n"),
    ).toContain("historic output");
    expect(
      harness({ output: { fallback: { enabled: false } } }).resolve(
        name,
        () => upstream,
      ),
    ).toBe(upstream);
  }
});
