import { describe, expect, it } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import uvExtension, { getBlockedCommandMessage } from "./uv";

type ToolCallHandler = (event: {
  toolName: string;
  input: Record<string, unknown>;
}) => { block: true; reason: string } | undefined;

const registerToolCall = () => {
  let handler: ToolCallHandler | undefined;
  const registeredTools: unknown[] = [];
  const pi = {
    on(event: string, callback: ToolCallHandler) {
      if (event === "tool_call") {
        handler = callback;
      }
    },
    registerTool(tool: unknown) {
      registeredTools.push(tool);
    },
  } as unknown as ExtensionAPI;

  uvExtension(pi);
  expect(handler).toBeDefined();
  return { handler: handler!, registeredTools };
};

describe("uv extension", () => {
  it("hooks tool_call without overriding the bash tool", () => {
    const { registeredTools } = registerToolCall();

    expect(registeredTools).toEqual([]);
  });

  it("blocks disallowed bash commands with uv guidance", () => {
    const { handler } = registerToolCall();

    const result = handler({
      toolName: "bash",
      input: { command: "ls && .venv/bin/python3.12 -m pip install x" },
    });

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("'python -m pip' is disabled");
  });

  it("allows uv commands and ignores other tools", () => {
    const { handler } = registerToolCall();

    expect(
      handler({ toolName: "bash", input: { command: "uv pip install x" } }),
    ).toBeUndefined();
    expect(
      handler({ toolName: "read", input: { command: "pip install x" } }),
    ).toBeUndefined();
  });

  it("matches each blocked tool at shell segment starts", () => {
    for (const [command, expected] of [
      ["pip install x", "pip is disabled"],
      ["cd a; pip3 install x", "pip3 is disabled"],
      ["poetry add x", "poetry is disabled"],
      ["python -m venv .venv", "'python -m venv' is disabled"],
      ["python3 -m py_compile a.py", "'python -m py_compile' is disabled"],
    ]) {
      expect(getBlockedCommandMessage(command)).toContain(expected);
    }
    expect(getBlockedCommandMessage("python script.py")).toBeNull();
  });
});
