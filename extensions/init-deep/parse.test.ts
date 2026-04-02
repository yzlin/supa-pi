import { describe, expect, it } from "bun:test";
import path from "node:path";

import { parseInitDeepArgs } from "./parse";

describe("parseInitDeepArgs", () => {
  const cwd = process.cwd();

  it("defaults to cwd when args are empty", () => {
    const result = parseInitDeepArgs("", cwd);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value).toEqual({
      targetRoot: cwd,
      targetLabel: ".",
      instruction: null,
      createNew: false,
      maxDepth: 3,
      dryRun: false,
    });
  });

  it("resolves a target path deterministically", () => {
    const result = parseInitDeepArgs("./extensions", cwd);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value.targetRoot).toBe(path.resolve(cwd, "./extensions"));
    expect(result.value.targetLabel).toBe("./extensions");
  });

  it("separates target and freeform instruction using --", () => {
    const result = parseInitDeepArgs(
      "./extensions -- focus on extension and command boundaries",
      cwd
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value.targetLabel).toBe("./extensions");
    expect(result.value.instruction).toBe(
      "focus on extension and command boundaries"
    );
  });

  it("parses flags and max depth values", () => {
    const result = parseInitDeepArgs(
      "./extensions --create-new --max-depth 5 --dry-run -- focus on command flow",
      cwd
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value.createNew).toBe(true);
    expect(result.value.maxDepth).toBe(5);
    expect(result.value.dryRun).toBe(true);
    expect(result.value.instruction).toBe("focus on command flow");
  });

  it("supports equals syntax for max depth", () => {
    const result = parseInitDeepArgs("--max-depth=4", cwd);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value.maxDepth).toBe(4);
  });

  it("rejects ambiguous extra positional arguments", () => {
    const result = parseInitDeepArgs("./extensions extra", cwd);

    expect(result).toEqual({
      ok: false,
      error:
        "Ambiguous arguments. Use '/init-deep <target> -- <instruction>' to pass freeform instructions.",
    });
  });

  it("rejects unknown flags", () => {
    const result = parseInitDeepArgs("--overview", cwd);

    expect(result).toEqual({
      ok: false,
      error: "Unknown flag: --overview",
    });
  });

  it("rejects missing target paths", () => {
    const result = parseInitDeepArgs("./definitely-missing", cwd);

    expect(result).toEqual({
      ok: false,
      error: "Target path does not exist: ./definitely-missing",
    });
  });

  it("rejects invalid max depth values", () => {
    const result = parseInitDeepArgs("--max-depth zero", cwd);

    expect(result).toEqual({
      ok: false,
      error: "Invalid --max-depth value: zero. Use a positive integer.",
    });
  });

  it("supports quoted target paths before --", () => {
    const result = parseInitDeepArgs(
      '"./extensions" -- focus on runtime boundaries',
      cwd
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value.targetLabel).toBe("./extensions");
    expect(result.value.instruction).toBe("focus on runtime boundaries");
  });

  it("rejects unterminated quoted input", () => {
    const result = parseInitDeepArgs('"./extensions', cwd);

    expect(result).toEqual({
      ok: false,
      error: "Unterminated quoted argument.",
    });
  });
});
