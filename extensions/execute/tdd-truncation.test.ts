import { describe, expect, it } from "bun:test";

import { normalizeTddToolMetadata } from "./tdd-evidence";

function editMetadata(path: string, byteLength: number) {
  return normalizeTddToolMetadata("edit", {
    path,
    oldText: "o".repeat(byteLength),
    newText: "n".repeat(byteLength),
  });
}

const TEST_ONLY_EFFECTS = {
  hasTestTargets: true,
  hasProductionTargets: false,
  mutationAmbiguous: false,
};

const CONSERVATIVE_EFFECTS = {
  hasTestTargets: true,
  hasProductionTargets: true,
  mutationAmbiguous: true,
};

describe("truncated TDD edit metadata", () => {
  it("keeps long dedicated test-file edits test-only while bounding snippets", () => {
    for (const path of ["src/widget.test.ts", "tests/widget.ts"]) {
      const metadata = editMetadata(path, 2750);

      expect(metadata).toMatchObject({
        mutationTargets: [path],
        editDeltaTruncated: true,
        ...TEST_ONLY_EFFECTS,
      });
      expect(Buffer.byteLength(metadata.editOldSnippet ?? "")).toBe(2000);
      expect(Buffer.byteLength(metadata.editNewSnippet ?? "")).toBe(2000);
    }
  });

  it("keeps short dedicated test-file edits test-only", () => {
    for (const path of ["src/widget.test.ts", "tests/widget.ts"]) {
      const metadata = editMetadata(path, 55);

      expect(metadata).toMatchObject({
        mutationTargets: [path],
        editOldSnippet: "o".repeat(55),
        editNewSnippet: "n".repeat(55),
        ...TEST_ONLY_EFFECTS,
      });
      expect(metadata.editDeltaTruncated).toBeUndefined();
    }
  });

  it("classifies missing and unknown edit targets conservatively", () => {
    for (const rawArgs of [
      { oldText: "old", newText: "new" },
      { path: "/outside.ts", oldText: "old", newText: "new" },
    ]) {
      expect(normalizeTddToolMetadata("edit", rawArgs)).toMatchObject(
        CONSERVATIVE_EFFECTS
      );
    }
  });

  it("keeps truncated production and in-source edits conservative", () => {
    for (const path of ["src/service.ts", "src/lib.rs", "lib/config.json"]) {
      expect(editMetadata(path, 2750)).toMatchObject({
        mutationTargets: [path],
        editDeltaTruncated: true,
        ...CONSERVATIVE_EFFECTS,
      });
    }
  });

  it("does not classify mixed patch targets as all-test", () => {
    const metadata = normalizeTddToolMetadata("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: tests/widget.test.ts",
        "*** Update File: src/widget.ts",
        "*** End Patch",
      ].join("\n"),
    });

    expect(metadata).toMatchObject({
      mutationTargets: ["tests/widget.test.ts", "src/widget.ts"],
      hasTestTargets: true,
      hasProductionTargets: true,
      mutationAmbiguous: false,
    });
  });
});
