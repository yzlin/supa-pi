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

  it("hooks tool_call and reads the session branch", () => {
    let handler:
      | ((
          event: Record<string, unknown>,
          ctx: unknown,
        ) => { block: true; reason: string } | undefined)
      | undefined;
    const tools: unknown[] = [];
    tierGuard({
      on(event: string, cb: typeof handler) {
        if (event === "tool_call") {
          handler = cb;
        }
      },
      registerTool(tool: unknown) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI);
    expect(tools).toEqual([]);
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
