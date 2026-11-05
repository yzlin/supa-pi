import { describe, expect, it } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import worktreeGuard, { getWorktreeRemoveMessage } from "./worktree-guard";

type ToolCallHandler = (event: {
  toolName: string;
  input: Record<string, unknown>;
}) => { block: true; reason: string } | undefined;

const register = () => {
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
  worktreeGuard(pi);
  expect(handler).toBeDefined();
  return { handler: handler!, registeredTools };
};

describe("worktree guard", () => {
  it("hooks tool_call without overriding the bash tool", () => {
    expect(register().registeredTools).toEqual([]);
  });

  // Real agent calls from supa-pi sessions, 2026-10-24 and 2026-11-04.
  it.each([
    'cd /x; d=$(mktemp -d); git worktree add -q "$d" HEAD && bun test; git worktree remove --force "$d"',
    "git worktree remove --force /tmp/supa-pi-paired/new",
    "git worktree remove $W",
    "git -C /repo worktree remove /tmp/wt",
    "cd /x &&\ngit worktree   remove /tmp/wt",
  ])("blocks %p and names the fix", (command) => {
    const result = register().handler({ toolName: "bash", input: { command } });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("trash <worktree-dir>");
    expect(result?.reason).toContain("git worktree prune");
  });

  it.each([
    "git worktree add --detach /tmp/wt HEAD",
    "trash /tmp/wt; git worktree prune",
    "git worktree list",
    'grep -rn "worktree remove" docs',
    "git log -G'worktree remove'",
  ])("allows %p", (command) => {
    expect(getWorktreeRemoveMessage(command)).toBeNull();
  });

  it("ignores other tools", () => {
    const result = register().handler({
      toolName: "read",
      input: { command: "git worktree remove /tmp/wt" },
    });
    expect(result).toBeUndefined();
  });
});
