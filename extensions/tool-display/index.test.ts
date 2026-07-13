import { describe, expect, test } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import toolDisplayExtension from "./index";

describe("tool-display registration", () => {
  test("owns six file tools with self-rendered reasoned schemas", () => {
    const tools: Array<{
      name: string;
      parameters: { properties: Record<string, unknown>; required?: string[] };
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
    for (const tool of tools) {
      expect(tool.renderShell).toBe("self");
      expect(Object.keys(tool.parameters.properties)[0]).toBe("reasoning");
      expect(tool.parameters.required?.[0]).toBe("reasoning");
    }
    const edit = tools.find((tool) => tool.name === "edit");
    expect(edit?.parameters.properties.patch).toBeDefined();
    expect(handlers.has("session_shutdown")).toBe(true);
  });
});
