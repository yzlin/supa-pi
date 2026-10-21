import { describe, expect, it } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import handoffExtension from "./handoff";

interface HandoffTool {
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: unknown;
  }>;
}

function registerHandoff() {
  let tool: HandoffTool | undefined;
  let agentEnd: ((event: unknown, ctx: unknown) => void) | undefined;
  handoffExtension({
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "agent_end") {
        agentEnd = handler;
      }
    },
    registerCommand() {
      // Command path is outside this regression.
    },
    registerTool(registeredTool: HandoffTool) {
      tool = registeredTool;
    },
  } as unknown as ExtensionAPI);
  if (!(tool && agentEnd)) {
    throw new Error("Expected handoff tool and agent_end handler");
  }
  return { tool, agentEnd };
}

describe("handoff tool", () => {
  it.each([null, undefined])(
    "treats a %p loader result as cancelled",
    async (customResult) => {
      const { tool, agentEnd } = registerHandoff();
      let newSessionCalls = 0;

      const result = await tool.execute(
        "call-1",
        { goal: "continue" },
        undefined,
        undefined,
        {
          hasUI: true,
          model: { provider: "test", id: "model" },
          sessionManager: {
            getBranch() {
              return [
                { type: "message", message: { role: "user", content: "Old" } },
              ];
            },
            getSessionFile() {
              // Unsaved session: no parent session file.
            },
          },
          ui: {
            custom() {
              return Promise.resolve(customResult);
            },
          },
        },
      );

      expect(result.content[0]?.text).toBe("Handoff cancelled.");
      expect(result.details).toEqual({ error: true });

      agentEnd(
        {},
        {
          hasUI: true,
          sessionManager: {
            newSession() {
              newSessionCalls++;
            },
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(newSessionCalls).toBe(0);
    },
  );
});
