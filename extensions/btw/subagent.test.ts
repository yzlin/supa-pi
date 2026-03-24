import { describe, expect, it } from "bun:test";

import { appendFinalOutput, resolveExitCode } from "./subagent";

describe("appendFinalOutput", () => {
  it("keeps the first text chunk unchanged", () => {
    expect(appendFinalOutput("", "first chunk")).toBe("first chunk");
  });

  it("appends later text chunks with newlines", () => {
    expect(appendFinalOutput("first chunk", "second chunk")).toBe(
      "first chunk\nsecond chunk"
    );
  });
});

describe("resolveExitCode", () => {
  it("returns success for completed runs", () => {
    expect(resolveExitCode(undefined, false)).toBe(0);
  });

  it("returns failure for explicit error stop reasons", () => {
    expect(resolveExitCode("error", false)).toBe(1);
  });

  it("returns failure for aborted stop reasons", () => {
    expect(resolveExitCode("aborted", false)).toBe(1);
  });

  it("returns failure for aborted signals even without a stop reason", () => {
    expect(resolveExitCode(undefined, true)).toBe(1);
  });
});
