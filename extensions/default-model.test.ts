import { describe, expect, it } from "bun:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import defaultModelExtension, {
  defaultModelToRestore,
  type RestoreInput,
} from "./default-model";

const base: RestoreInput = {
  reason: "startup",
  argv: ["bun", "pi"],
  defaultProvider: "claude-code",
  defaultModel: "claude-opus-5-5",
  current: { provider: "radius", id: "balanced" },
  scopedModelCount: 0,
  hasMessages: false,
};

describe("defaultModelToRestore", () => {
  it("restores the default after a startup fallback", () => {
    expect(defaultModelToRestore(base)).toEqual({
      provider: "claude-code",
      id: "claude-opus-5-5",
    });
  });

  it.each([
    [
      "already on default",
      { current: { provider: "claude-code", id: "claude-opus-5-5" } },
    ],
    ["non-startup reason", { reason: "new" }],
    ["resumed session with messages", { hasMessages: true }],
    ["scoped models", { scopedModelCount: 2 }],
    ["--model flag", { argv: ["pi", "--model", "x"] }],
    ["--provider=flag", { argv: ["pi", "--provider=radius"] }],
    ["no default configured", { defaultModel: undefined }],
  ] as const)("keeps Pi's choice: %s", (_name, override) => {
    expect(defaultModelToRestore({ ...base, ...override })).toBeUndefined();
  });
});

function harness(options: { find: boolean; setModelOk: boolean }) {
  let handler:
    | ((event: unknown, ctx: ExtensionContext) => Promise<void>)
    | undefined;
  const calls: string[] = [];
  const notes: string[] = [];
  const model = { provider: "claude-code", id: "claude-opus-5-5" };
  const pi = {
    on: (name: string, fn: typeof handler) => {
      if (name === "session_start") {
        handler = fn;
      }
    },
    getSettings: () => ({
      defaultProvider: "claude-code",
      defaultModel: "claude-opus-5-5",
    }),
    setModel: async (m: typeof model) => {
      calls.push(`setModel ${m.provider}/${m.id}`);
      return options.setModelOk;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    model: { provider: "radius", id: "balanced" },
    scopedModels: [],
    sessionManager: { getEntries: () => [{ type: "model_change" }] },
    modelRegistry: {
      refresh: async (o: { providers: string[] }) => {
        calls.push(`refresh ${o.providers.join(",")}`);
      },
      find: () => (options.find ? model : undefined),
    },
    ui: { notify: (text: string) => notes.push(text) },
  } as unknown as ExtensionContext;
  defaultModelExtension(pi);
  return {
    run: () => handler?.({ type: "session_start", reason: "startup" }, ctx),
    calls,
    notes,
  };
}

describe("session_start handler", () => {
  it("re-checks only the default provider, then switches back", async () => {
    const h = harness({ find: true, setModelOk: true });
    await h.run();
    expect(h.calls).toEqual([
      "refresh claude-code",
      "setModel claude-code/claude-opus-5-5",
    ]);
    expect(h.notes[0]).toContain(
      "Restored default model claude-code/claude-opus-5-5",
    );
  });

  it("warns and keeps the fallback when the default still lacks auth", async () => {
    const h = harness({ find: true, setModelOk: false });
    await h.run();
    expect(h.notes[0]).toContain("unavailable; using radius/balanced");
  });
});
