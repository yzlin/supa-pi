import { describe, expect, test } from "bun:test";

import { Value } from "typebox/value";

import { editTool, PATCH_EXAMPLE, ROW_EXAMPLE } from "./edit-tool";
import { prepareUnifiedEditArguments } from "./unified-edit-migration";
import { parsePatch, parseRowScript } from "./unified-edit-parser";
import { buildUnifiedEditPlan } from "./unified-edit-planner";
import { unifiedEditSchema } from "./unified-edit-schema";

const reader = (files: Record<string, string>) => async (path: string) =>
  files[path] ?? null;

describe("local unified-edit schema and argument preparation", () => {
  test("public schema is strict text-only with no reasoning", () => {
    expect(Value.Check(unifiedEditSchema, { text: "[a]\n@APPEND\n+x" })).toBe(
      true
    );
    expect(
      Value.Check(unifiedEditSchema, { text: "x", reasoning: "why" })
    ).toBe(false);
    expect(Value.Check(unifiedEditSchema, { patch: "x" })).toBe(false);
  });

  test("accepts upstream raw and single-alias arguments", () => {
    expect(editTool.prepareArguments("script")).toEqual({ text: "script" });
    for (const key of ["text", "patch", "input", "content"]) {
      expect(editTool.prepareArguments({ [key]: "script" })).toEqual({
        text: "script",
      });
    }
  });

  test("rejects ambiguous, retired local, and unknown argument shapes", () => {
    const invalid = [
      { text: "one", patch: "two" },
      { text: "one", path: "a.txt", oldText: "old", newText: "new" },
      { content: "one", multi: [] },
      { path: "a.txt", oldText: "old" },
      { path: "a.txt", newText: "new" },
      { path: "a.txt", multi: [], edits: [] },
      { text: "one", extra: true },
      { path: "a.txt", oldText: "old", newText: "new", extra: true },
      {
        multi: [{ path: "a.txt", oldText: "old", newText: "new", extra: true }],
      },
    ];
    for (const args of invalid) {
      expect(() => prepareUnifiedEditArguments(args)).toThrow();
    }
  });
});

describe("local unified-edit parser and planner", () => {
  test("description examples parse in their documented dialects", () => {
    expect(parseRowScript(ROW_EXAMPLE)).toHaveLength(2);
    expect(
      parsePatch(PATCH_EXAMPLE).map((operation) => operation.kind)
    ).toEqual(["add", "update", "delete"]);
  });

  test("parses full row grammar, aliases, ordering variants, context and hunks", () => {
    for (const alias of ["2-3", "2.3", "2..3", "2.=3", "2..=3", "2 ..= 3"]) {
      expect(parseRowScript(`[a.txt]\n@DEL ${alias}`)[0].ops[0]).toMatchObject({
        kind: "delete",
        startLine: 2,
        endLine: 3,
      });
    }
    const scripts = parseRowScript(`[a.txt]
@INS.PRE 1
+pre
@INS.POST 1
+post
@INS.BEFORE
+before
-anchor
@INS.AFTER
-anchor
+after
@REPLACE
+new
-old
@@
 context
-old2
+new2
@DEL 2..=3
@DEL 1.=1
@APPEND
+tail`);
    expect(scripts[0].ops.map((op) => op.kind)).toEqual([
      "insertBefore",
      "insertAfter",
      "insertBeforeAnchor",
      "insertAfterAnchor",
      "replace",
      "delete",
      "delete",
      "append",
    ]);
  });

  test("preserves marked empty context rows in replacement hunks", async () => {
    const text = "[a.txt]\n@REPLACE\n before\n \n-old\n+new\n after";
    expect(parseRowScript(text)[0].ops[0]).toMatchObject({
      kind: "replace",
      groups: [
        { marker: " ", lines: ["before", ""] },
        { marker: "-", lines: ["old"] },
        { marker: "+", lines: ["new"] },
        { marker: " ", lines: ["after"] },
      ],
    });
    const plan = await buildUnifiedEditPlan(
      text,
      "/tmp",
      reader({ "a.txt": "before\n\nold\nafter\n" })
    );
    expect(plan.changes[0].newText).toBe("before\n\nnew\nafter\n");
  });

  test("plans rows with fuzzy whole-line matching, uniqueness, BOM and CRLF", async () => {
    const text = "[a.txt]\n@REPLACE\n-Hello - “world”\n+changed";
    const plan = await buildUnifiedEditPlan(
      text,
      "/tmp",
      reader({ "a.txt": "\uFEFFHello — “world”  \r\nkeep\r\n" })
    );
    expect(plan.changes[0].newText).toBe("\uFEFFchanged\r\nkeep\r\n");
    await expect(
      buildUnifiedEditPlan(
        "[a.txt]\n@REPLACE\n-same\n+x",
        "/tmp",
        reader({ "a.txt": "same\nsame\n" })
      )
    ).rejects.toThrow("must be unique");
  });

  test("deletion-only replacements require a unique row anchor", async () => {
    for (const content of ["same\nsame\n", "same\nsame"]) {
      await expect(
        buildUnifiedEditPlan(
          "[a.txt]\n@REPLACE\n-same",
          "/tmp",
          reader({ "a.txt": content })
        )
      ).rejects.toThrow("must be unique");
    }

    const cases = [
      ["remove\nkeep\n", "keep\n"],
      ["keep\nremove\ntail\n", "keep\ntail\n"],
      ["keep\nremove", "keep\n"],
      ["remove", ""],
    ];
    for (const [content, expected] of cases) {
      const plan = await buildUnifiedEditPlan(
        "[a.txt]\n@REPLACE\n-remove",
        "/tmp",
        reader({ "a.txt": content })
      );
      expect(plan.changes[0].newText).toBe(expected);
    }
  });

  test("parses and plans Codex Add Update Delete, rejecting Move", async () => {
    const patch = `*** Begin Patch
*** Add File: add.txt
+added
*** Update File: old.txt
@@
-old
+new
*** Delete File: gone.txt
*** End Patch`;
    expect(parsePatch(patch).map((op) => op.kind)).toEqual([
      "add",
      "update",
      "delete",
    ]);
    const plan = await buildUnifiedEditPlan(
      patch,
      "/tmp",
      reader({ "old.txt": "old\n", "gone.txt": "gone\n" })
    );
    expect(plan.changes.map((change) => change.kind)).toEqual([
      "add",
      "update",
      "delete",
    ]);
    expect(() =>
      parsePatch(
        "*** Begin Patch\n*** Update File: a\n*** Move to: b\n*** End Patch"
      )
    ).toThrow("move operations");
  });

  test("enforces global input, operation, target, and matcher ceilings", async () => {
    await expect(
      buildUnifiedEditPlan(
        `[a.txt]\n${"\n".repeat(20_000)}`,
        "/tmp",
        reader({
          "a.txt": "x\n",
        })
      )
    ).rejects.toThrow("input exceeds limit");

    const operations = Array.from({ length: 1001 }, () => "@APPEND\n+x").join(
      "\n"
    );
    await expect(
      buildUnifiedEditPlan(
        `[a.txt]\n${operations}`,
        "/tmp",
        reader({
          "a.txt": "base\n",
        })
      )
    ).rejects.toThrow("1000 operations");

    await expect(
      buildUnifiedEditPlan(
        "[a.txt]\n@REPLACE\n-missing\n+x",
        "/tmp",
        reader({
          "a.txt": `${"a".repeat(200_001)}\n`,
        })
      )
    ).rejects.toThrow("Matcher comparison limit");
  });

  test("rejects contextless insertion-only patch hunks", async () => {
    await expect(
      buildUnifiedEditPlan(
        `*** Begin Patch
*** Update File: a.txt
+inserted
*** End Patch`,
        "/tmp",
        reader({ "a.txt": "first\nsecond\n" })
      )
    ).rejects.toThrow("needs locating context");

    await expect(
      buildUnifiedEditPlan(
        `*** Begin Patch
*** Update File: a.txt
+first insert
@@
+second insert
*** End Patch`,
        "/tmp",
        reader({ "a.txt": "first\nsecond\n" })
      )
    ).rejects.toThrow("needs locating context");
  });

  test("keeps insertion-only patch hunks with a unique change context", async () => {
    const plan = await buildUnifiedEditPlan(
      `*** Begin Patch
*** Update File: a.txt
@@ anchor
+inserted
*** End Patch`,
      "/tmp",
      reader({ "a.txt": "anchor\ntail\n" })
    );

    expect(plan.changes[0].newText).toBe("anchor\ninserted\ntail\n");
  });

  test("preserves original whitespace in fuzzy and exact patch context", async () => {
    const patch = `*** Begin Patch
*** Update File: a.txt
@@
 before
-old
+new
 after
*** End Patch`;
    const fuzzy = await buildUnifiedEditPlan(
      patch,
      "/tmp",
      reader({ "a.txt": "before  \nold\nafter\t\n" })
    );
    expect(fuzzy.changes[0].newText).toBe("before  \nnew\nafter\t\n");

    const exact = await buildUnifiedEditPlan(
      patch,
      "/tmp",
      reader({ "a.txt": "before\nold\nafter\n" })
    );
    expect(exact.changes[0].newText).toBe("before\nnew\nafter\n");
  });

  test("does not choose ambiguous patch hunks", async () => {
    await expect(
      buildUnifiedEditPlan(
        `*** Begin Patch
*** Update File: a.txt
@@
-same
+new
*** End Patch`,
        "/tmp",
        reader({ "a.txt": "same\nkeep\nsame\n" })
      )
    ).rejects.toThrow("multiple locations");
  });
});
