import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { childCommand, openBtwFloat, rexTarget } from "./rex";

const btw = {
  cwd: "/work",
  task: "@not-a-file; $(not-a-command)",
  provider: "test-provider",
  model: "test-model",
  thinkingLevel: "high",
  conversationContext: "[User]: hi",
};
const target = { session: "session:test", block: "block:parent" };

function fakeRex() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const pi = {
    exec: (program: string, args: string[]) => {
      expect(program).toBe("rex");
      expect(args.slice(0, 4)).toEqual(["api", "call", "-s", target.session]);
      const method = args[4] ?? "";
      calls.push({ method, payload: JSON.parse(args[5] ?? "{}") });
      const result =
        method === "session.view"
          ? {
              windows: [
                { window_id: "window:other", layers: [] },
                {
                  window_id: "window:parent",
                  layers: [{ blocks: [{ block_id: target.block }] }],
                },
              ],
            }
          : { layer_id: "layer:btw", block_ids: ["block:btw"] };
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify(result),
        stderr: "",
        killed: false,
        truncated: false,
      });
    },
  } as unknown as Pick<ExtensionAPI, "exec">;
  return { pi, calls };
}

describe("btw rex float", () => {
  it("detects Rex only when both session and block are set", () => {
    expect(rexTarget({ REX_SESSION: "s", REX_BLOCK: "b" })).toEqual({
      session: "s",
      block: "b",
    });
    expect(rexTarget({ REX_SESSION: "s" })).toBeUndefined();
  });

  it("opens a focused float in the parent's window running a child Pi", async () => {
    const { pi, calls } = fakeRex();
    await openBtwFloat(pi, target, btw);

    const layer = calls.find((c) => c.method === "session.new_layer");
    expect(layer?.payload).toMatchObject({
      window_id: "window:parent",
      focus: true,
      layout: { block: { options: { shell: "none", cwd: "/work" } } },
    });
    const layout = layer?.payload.layout as
      | { block: { options: { command: string[] } } }
      | undefined;
    const command = layout?.block.options.command ?? [];
    const snapshot = command[command.indexOf("--append-system-prompt") + 1];
    expect(readFileSync(snapshot ?? "", "utf8")).toContain("[User]: hi");
  });

  it("passes the task as a literal first prompt with the chosen model", () => {
    const command = childCommand(btw, "/tmp/snapshot.md");
    expect(command.slice(-2)).toEqual(["--", ` ${btw.task}`]);
    expect(command[command.indexOf("--model") + 1]).toBe("test-model");
    expect(command[command.indexOf("--provider") + 1]).toBe("test-provider");
    expect(command[command.indexOf("--thinking") + 1]).toBe("high");
  });

  it("fails when the parent block is not in the Rex session", async () => {
    const { pi } = fakeRex();
    expect(
      openBtwFloat(pi, { ...target, block: "block:gone" }, btw),
    ).rejects.toThrow("Rex could not find the parent terminal.");
  });
});
