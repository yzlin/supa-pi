import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import tierGuard, { flatten, tierRefusal } from "./tier-guard";

const TRIAGE = "/wt/skills/supapi-mode/playbooks/triage.md";

let seq = 0;
const user = () => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "do it" }] },
});
const said = (text: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const call = (
  name: string,
  args: Record<string, unknown>,
  id = `c${++seq}`,
) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  },
});
const result = (id: string, isError = false) => ({
  type: "message",
  message: { role: "toolResult", toolCallId: id, isError, content: [] },
});
const readTriage = () => call("read", { path: TRIAGE });
const tierCall = (tier: unknown, reason: unknown = "signals named") =>
  call("tier", { tier, reason });

/** Append the work call and ask the guard about it. */
function refuse(
  entries: unknown[],
  name = "edit",
  input: Record<string, unknown> = { path: "src/report.ts" },
) {
  const work = call(name, input, "work");
  return tierRefusal(flatten([...entries, work]), "work", name, input, "/ws");
}

describe("tier guard", () => {
  it("allows work when triage was not read this turn", () => {
    expect(refuse([user()])).toBeNull();
    expect(refuse([user(), readTriage(), user()])).toBeNull();
  });

  it("refuses an edit, write, or executor call before a Tier line", () => {
    const entries = [
      user(),
      readTriage(),
      said("Goal: rename. Kind: feature."),
    ];
    expect(refuse(entries)).toContain("no Tier line yet");
    expect(refuse(entries, "write", { path: "a.ts" })).toContain(
      "no Tier line",
    );
    expect(refuse(entries, "subagent", { agent: "executor" })).toContain(
      "no Tier line",
    );
  });

  it("allows a Tier line written as text in the same message as the call", () => {
    const input = { path: "src/report.ts" };
    const message = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Tier: T1 — one unit, tested" },
          { type: "toolCall", id: "work", name: "edit", arguments: input },
        ],
      },
    };
    expect(
      tierRefusal(
        flatten([user(), readTriage(), message]),
        "work",
        "edit",
        input,
        "/ws",
      ),
    ).toBeNull();
  });

  it("a tier call counts as the Tier line", () => {
    expect(refuse([user(), readTriage(), tierCall(1)])).toBeNull();
    expect(refuse([user(), readTriage(), tierCall(0, "one line")])).toBeNull();
  });

  it("a tier T2 call gates work until accept", () => {
    const base = [user(), readTriage(), tierCall(2, "two subsystems")];
    expect(refuse(base, "write", { path: ".pi/specs/x.md" })).toBeNull();
    expect(refuse(base)).toContain("no accepted Spec");
    expect(
      refuse([
        ...base,
        call("spec_log", { action: "accept" }, "a"),
        result("a"),
      ]),
    ).toBeNull();
    expect(
      refuse([
        user(),
        readTriage(),
        tierCall(1),
        call("spec_log", { action: "accept" }, "old"),
        result("old"),
        tierCall(2, "hit a public contract"),
      ]),
    ).toContain("no accepted Spec");
  });

  it("a tier call before the triage read does not count", () => {
    expect(refuse([user(), tierCall(1), readTriage()])).toContain(
      "no Tier line",
    );
  });

  it("an invalid tier call does not count", () => {
    for (const bad of [
      tierCall(4),
      tierCall(1.5),
      tierCall("2"),
      tierCall(1, "  "),
    ]) {
      expect(refuse([user(), readTriage(), bad])).toContain("no Tier line");
    }
  });

  it("a tier call in the same message as the work call counts", () => {
    const input = { path: "src/report.ts" };
    const message = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t",
            name: "tier",
            arguments: { tier: 1, reason: "one unit" },
          },
          { type: "toolCall", id: "work", name: "edit", arguments: input },
        ],
      },
    };
    expect(
      tierRefusal(
        flatten([user(), readTriage(), message]),
        "work",
        "edit",
        input,
        "/ws",
      ),
    ).toBeNull();
  });

  it("narration-only Tier prose still refuses, then a tier call clears it", () => {
    // Shape of session 01a1ca94: Opus 5.5 returned the Tier prose as a
    // server-summarized narration thinking block, so the guard never saw it.
    const narration = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Tier T2 is set: five outcomes." },
        ],
      },
    };
    const spec = { path: ".pi/specs/x.md" };
    const entries = [
      user(),
      readTriage(),
      narration,
      call("write", spec, "w1"),
      result("w1", true),
    ];
    expect(refuse(entries, "write", spec)).toContain("no Tier line");
    expect(refuse([...entries, tierCall(2)], "write", spec)).toBeNull();
  });

  it("allows non-work tools before a Tier line", () => {
    const entries = [user(), readTriage()];
    expect(refuse(entries, "read", { path: "src/report.ts" })).toBeNull();
    expect(refuse(entries, "bash", { command: "bun test" })).toBeNull();
    expect(refuse(entries, "subagent", { agent: "spec-reviewer" })).toBeNull();
  });

  it("does not count a Tier line written before triage or mid-line", () => {
    expect(refuse([user(), said("Tier: T1 — early"), readTriage()])).toContain(
      "no Tier line",
    );
    expect(refuse([user(), readTriage(), said("Not Tier: T1 — x")])).toContain(
      "no Tier line",
    );
  });

  it("allows T1 work after the Tier line", () => {
    expect(
      refuse([user(), readTriage(), said("Tier: T1 — one unit, tested")]),
    ).toBeNull();
  });

  it("at T2 allows Spec writes but refuses other work until accept", () => {
    const entries = [user(), readTriage(), said("Tier: T2 — one-way door")];
    expect(refuse(entries, "write", { path: ".pi/specs/x.md" })).toBeNull();
    expect(refuse(entries, "edit", { path: "/ws/.pi/specs/x.md" })).toBeNull();
    expect(
      refuse(entries, "edit", { path: ".pi/specs/../../src/report.ts" }),
    ).toContain("no accepted Spec");
    expect(refuse(entries)).toContain("no accepted Spec");
    expect(refuse(entries, "subagent", { agent: "executor" })).toContain(
      "no accepted Spec",
    );
  });

  it("at T2 allows work after a successful accept, not a failed one", () => {
    const base = [user(), readTriage(), said("Tier: T2 — one-way door")];
    expect(
      refuse([
        ...base,
        call("spec_log", { action: "accept" }, "a"),
        result("a"),
      ]),
    ).toBeNull();
    expect(
      refuse([
        ...base,
        call("spec_log", { action: "accept" }, "a"),
        result("a", true),
      ]),
    ).toContain("no accepted Spec");
    expect(
      refuse([...base, call("spec_log", { action: "lint" }, "l"), result("l")]),
    ).toContain("no accepted Spec");
  });

  it("an accept before the T2 line does not count (escalation)", () => {
    const entries = [
      user(),
      readTriage(),
      said("Tier: T1 — light"),
      call("spec_log", { action: "accept" }, "old"),
      result("old"),
      said("Tier: T2 — hit a public contract"),
    ];
    expect(refuse(entries)).toContain("no accepted Spec");
  });

  it("turns off after a non-build Playbook is read", () => {
    const entries = [
      user(),
      readTriage(),
      call("read", {
        path: "/wt/skills/supapi-mode/playbooks/investigation.md",
      }),
    ];
    expect(refuse(entries)).toBeNull();
  });

  it("arms only on a read of triage.md, not a grep or edit of it", () => {
    expect(
      refuse([user(), call("bash", { command: `rg Tier ${TRIAGE}` })]),
    ).toBeNull();
    expect(refuse([user(), call("edit", { path: TRIAGE })])).toBeNull();
  });

  it("reading execute.md opens nothing; the execute kind needs its T2 line", () => {
    const EXECUTE = "/wt/skills/supapi-mode/playbooks/execute.md";
    // Replay of the failing live re-run: execute.md read, no Tier line.
    const base = [user(), readTriage(), call("read", { path: EXECUTE })];
    expect(refuse(base)).toContain("no Tier line");
    expect(refuse(base, "write", { path: ".pi/specs/x.md" })).toContain(
      "no Tier line",
    );
    expect(
      refuse([
        ...base,
        call("spec_log", { action: "accept" }, "a"),
        result("a"),
      ]),
    ).toContain("no Tier line");
    const t2 = [
      user(),
      readTriage(),
      said("Tier: T2 — execute kind, Spec-backed"),
      call("read", { path: EXECUTE }),
    ];
    expect(refuse(t2, "write", { path: ".pi/specs/x.md" })).toBeNull();
    expect(refuse(t2)).toContain("no accepted Spec");
  });

  it("at T2 refuses a Spec-dir path that symlinks outside", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tier-guard-")));
    mkdirSync(join(root, ".pi/specs"), { recursive: true });
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, ".pi/specs/linked"));
    const entries = [user(), readTriage(), said("Tier: T2 — one-way door")];
    const ask = (path: string) =>
      tierRefusal(
        flatten([...entries, call("write", { path }, "w")]),
        "w",
        "write",
        { path },
        root,
      );
    expect(ask(".pi/specs/linked/report.ts")).toContain("no accepted Spec");
    expect(ask(".pi/specs/new-spec.md")).toBeNull();
    rmSync(root, { recursive: true });
  });

  it("hooks tool_call and reads the session branch", async () => {
    let handler:
      | ((
          event: Record<string, unknown>,
          ctx: unknown,
        ) => { block: true; reason: string } | undefined)
      | undefined;
    const tools: {
      name: string;
      description: string;
      parameters: {
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: { type: string; text: string }[] }>;
    }[] = [];
    tierGuard({
      on(event: string, cb: typeof handler) {
        if (event === "tool_call") {
          handler = cb;
        }
      },
      registerTool(tool: (typeof tools)[number]) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI);
    expect(tools.map((t) => t.name)).toEqual(["tier"]);
    const tier = tools[0];
    // Live 2026-11-12: a direct-path run declared T0 for a key with a known reader.
    expect(tier?.description).toContain(
      "T0 only when a search finds no other reader of the changed line; a change other code reads is T1 or higher.",
    );
    expect(tier?.parameters.properties.tier).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 3,
    });
    expect(tier?.parameters.properties.reason).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(tier?.parameters.required?.toSorted()).toEqual(["reason", "tier"]);
    const echoed = await tier?.execute("t", { tier: 2, reason: "x" });
    expect(echoed?.content[0]?.text).toBe("Tier: T2 — x");
    const branch = [user(), readTriage(), call("edit", { path: "a" }, "e")];
    const ctx = { cwd: "/ws", sessionManager: { getBranch: () => branch } };
    expect(
      handler?.(
        { toolName: "edit", toolCallId: "e", input: { path: "a" } },
        ctx,
      )?.block,
    ).toBe(true);
    branch.splice(2, 0, said("Tier: T1 — tiny"));
    expect(
      handler?.(
        { toolName: "edit", toolCallId: "e", input: { path: "a" } },
        ctx,
      ),
    ).toBeUndefined();
  });
});
