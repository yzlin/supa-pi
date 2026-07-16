import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  createEditToolDefinition,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import toolDisplayExtension from "./index";

const plainTheme = {
  bg: (_token: string, text: string) => text.trimEnd(),
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
};

const tempDirs: string[] = [];
afterEach(() => {
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
    JSON.stringify({ tools: { edit: { enabled: editEnabled } } })
  );
  return cwd;
}

describe("tool-display registration", () => {
  test("leaves built-in edit available while candidate gate is pending", () => {
    const tools: Array<{
      description?: string;
      name: string;
      parameters: { properties: Record<string, unknown>; required?: string[] };
      promptGuidelines?: string[];
      promptSnippet?: string;
      renderShell?: string;
    }> = [];
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const pi = Object.create(null) as ExtensionAPI;
    Object.assign(pi, {
      on(event: string, handler: (...args: never[]) => unknown) {
        handlers.set(event, handler);
      },
      registerCommand() {
        return;
      },
      registerTool(tool: (typeof tools)[number]) {
        tools.push(tool);
      },
    });

    toolDisplayExtension(pi);

    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
    ]);
    for (const tool of tools.filter((candidate) => candidate.name !== "edit")) {
      expect(tool.renderShell).toBe("self");
      expect(Object.keys(tool.parameters.properties)[0]).toBe("reasoning");
      expect(tool.parameters.required?.[0]).toBe("reasoning");
    }
    const edit = tools.find((tool) => tool.name === "edit") as
      | ReturnType<typeof createEditToolDefinition>
      | undefined;
    expect(Object.keys(edit?.parameters.properties ?? {})).toEqual([
      "path",
      "edits",
    ]);
    expect(edit?.renderShell).toBe("self");
    expect(edit?.renderCall).toBeFunction();
    expect(edit?.renderResult).toBeFunction();

    const args = {
      path: "a.ts",
      edits: [{ oldText: "old", newText: "new" }],
    };
    const state = {};
    const context = {
      args,
      argsComplete: true,
      cwd: process.cwd(),
      invalidate() {
        return;
      },
      state,
    };
    const call = edit?.renderCall?.(
      args,
      plainTheme as never,
      context as never
    );
    const result = {
      content: [{ type: "text" as const, text: "Successfully replaced." }],
      details: {
        diff: "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new",
        patch: "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new",
      },
    };
    const compact = edit?.renderResult?.(
      result,
      { expanded: false, isPartial: false },
      plainTheme as never,
      context as never
    );
    expect(call?.render(100).join("\n")).toContain(
      "✏️ edit Apply row edit · 1 file · a.ts"
    );
    expect(compact?.render(100).join("\n")).toContain("a.ts → applied in");
    expect(compact?.render(100).join("\n")).not.toContain("-old");

    const expanded = edit?.renderResult?.(
      result,
      { expanded: true, isPartial: false },
      plainTheme as never,
      context as never
    );
    expect(expanded?.render(100).join("\n")).toContain("old");
    expect(expanded?.render(100).join("\n")).toContain("new");
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  test("refreshes edit ownership for enabled and disabled sessions", () => {
    const handlers = new Map<
      string,
      Array<(event: unknown, ctx: { cwd: string }) => void>
    >();
    const registry = new Map<string, { parameters: { properties: object } }>();
    const pi = Object.create(null) as ExtensionAPI;
    Object.assign(pi, {
      on(
        event: string,
        handler: (event: unknown, ctx: { cwd: string }) => void
      ) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand() {
        return;
      },
      registerTool(tool: { name: string; parameters: { properties: object } }) {
        registry.set(tool.name, tool);
      },
    });
    const parameterNames = () =>
      Object.keys(registry.get("edit")?.parameters.properties ?? {});
    const disabled = projectConfig(false);
    const enabled = projectConfig(true);

    toolDisplayExtension(pi);
    for (const handler of handlers.get("session_start") ?? []) {
      handler({ type: "session_start" }, { cwd: enabled });
    }
    expect(parameterNames()).toEqual(["text"]);

    for (const handler of handlers.get("session_switch") ?? []) {
      handler({ type: "session_switch" }, { cwd: disabled });
    }
    expect(parameterNames()).toEqual(["path", "edits"]);

    for (const handler of handlers.get("session_switch") ?? []) {
      handler({ type: "session_switch" }, { cwd: enabled });
    }
    expect(parameterNames()).toEqual(["text"]);
  });
});
