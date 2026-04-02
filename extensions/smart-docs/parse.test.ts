import { describe, expect, it } from "bun:test";
import path from "node:path";

import { parseSmartDocsArgs } from "./parse";

describe("parseSmartDocsArgs", () => {
  const cwd = process.cwd();

  it("defaults to cwd and docs output when args are empty", () => {
    const result = parseSmartDocsArgs("", cwd);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value).toEqual({
      targetRoot: cwd,
      targetLabel: ".",
      outputDir: path.join(cwd, "docs"),
      instruction: null,
      update: null,
      overviewOnly: false,
      deepDive: [],
      dryRun: false,
    });
  });

  it("resolves a target path deterministically", () => {
    const result = parseSmartDocsArgs("./extensions", cwd);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value.targetRoot).toBe(path.resolve(cwd, "./extensions"));
    expect(result.value.targetLabel).toBe("./extensions");
    expect(result.value.outputDir).toBe(
      path.resolve(cwd, "./extensions", "docs")
    );
  });

  it("separates target and freeform instruction using --", () => {
    const result = parseSmartDocsArgs(
      "./extensions -- focus on command architecture",
      cwd
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value.targetLabel).toBe("./extensions");
    expect(result.value.instruction).toBe("focus on command architecture");
  });

  it("parses flags and custom output paths", () => {
    const result = parseSmartDocsArgs(
      "./extensions --out generated-docs --overview-only --deep-dive context,execute --dry-run -- focus on the command layer",
      cwd
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value.outputDir).toBe(
      path.resolve(cwd, "./extensions", "generated-docs")
    );
    expect(result.value.overviewOnly).toBe(true);
    expect(result.value.deepDive).toEqual(["context", "execute"]);
    expect(result.value.dryRun).toBe(true);
    expect(result.value.instruction).toBe("focus on the command layer");
  });

  it("rejects ambiguous extra positional arguments", () => {
    const result = parseSmartDocsArgs("./extensions extra", cwd);

    expect(result).toEqual({
      ok: false,
      error:
        "Ambiguous arguments. Use '/smart-docs <target> -- <instruction>' to pass freeform instructions.",
    });
  });

  it("rejects unknown flags", () => {
    const result = parseSmartDocsArgs("--overview", cwd);

    expect(result).toEqual({
      ok: false,
      error: "Unknown flag: --overview",
    });
  });

  it("rejects missing target paths", () => {
    const result = parseSmartDocsArgs("./definitely-missing", cwd);

    expect(result).toEqual({
      ok: false,
      error: "Target path does not exist: ./definitely-missing",
    });
  });

  it("rejects empty deep-dive entries", () => {
    const result = parseSmartDocsArgs("--deep-dive auth,,db", cwd);

    expect(result).toEqual({
      ok: false,
      error: "Invalid --deep-dive value. Use comma-separated non-empty names.",
    });
  });

  it("supports quoted target paths before --", () => {
    const result = parseSmartDocsArgs(
      '"./extensions" -- architecture only',
      cwd
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value.targetLabel).toBe("./extensions");
    expect(result.value.instruction).toBe("architecture only");
  });

  it("rejects unterminated quoted input", () => {
    const result = parseSmartDocsArgs('"./extensions', cwd);

    expect(result).toEqual({
      ok: false,
      error: "Unterminated quoted argument.",
    });
  });
});
