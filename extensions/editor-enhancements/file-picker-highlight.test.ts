import { afterEach, describe, expect, it } from "bun:test";

import { initTheme } from "@mariozechner/pi-coding-agent";

import {
  highlightPreviewLine,
  highlightPreviewLines,
  setNativeHighlightBindingLoaderForTests,
  warmPreviewHighlighter,
} from "./file-picker-highlight";

initTheme("dark");

afterEach(() => {
  setNativeHighlightBindingLoaderForTests(null);
});

describe("file picker native preview highlighting", () => {
  it("falls back to Pi highlighting when no native binding is available", () => {
    setNativeHighlightBindingLoaderForTests(() => null);

    const line = highlightPreviewLine(" 1 │ const answer = 42;", "example.ts");

    expect(line.startsWith(" 1 │ ")).toBe(true);
    expect(line).toContain("\x1b[");
  });

  it("uses the native binding for multi-line previews when available", () => {
    setNativeHighlightBindingLoaderForTests(() => ({
      highlightPreview(input) {
        expect(input.code).toBe("const answer = 42;\nreturn answer;");
        expect(input.filePath).toBe("example.ts");
        expect(input.themeMode).toBe("light");

        return {
          lines: ["<ansi const>", "<ansi return>"],
          language: "typescript",
          usedPlaintext: false,
        };
      },
    }));

    expect(
      highlightPreviewLines(
        [" 1 │ const answer = 42;", " 2 │ return answer;"],
        "example.ts",
        "light"
      )
    ).toEqual([" 1 │ <ansi const>", " 2 │ <ansi return>"]);
  });

  it("falls back when the native binding returns plain-text output", () => {
    setNativeHighlightBindingLoaderForTests(() => ({
      highlightPreview() {
        return {
          lines: ["const answer = 42;", "return answer;"],
          language: "Plain Text",
          usedPlaintext: true,
        };
      },
    }));

    const highlighted = highlightPreviewLines(
      [" 1 │ const answer = 42;", " 2 │ return answer;"],
      "example.ts"
    );

    expect(highlighted).toHaveLength(2);
    expect(highlighted[0]).toContain("\x1b[");
    expect(highlighted[1]).toContain("\x1b[");
  });

  it("keeps native highlighting when only the final preview line is empty", () => {
    setNativeHighlightBindingLoaderForTests(() => ({
      highlightPreview(input) {
        expect(input.code).toBe("---\nname: session-query\n");
        expect(input.filePath).toBe("@skills/session-query/SKILL.md");

        return {
          lines: ["<ansi frontmatter>", "<ansi name>"],
          language: "Markdown",
          usedPlaintext: false,
        };
      },
    }));

    expect(
      highlightPreviewLines(
        [
          " 1 │ ---",
          " 2 │ name: session-query",
          " 3 │ ",
        ],
        "@skills/session-query/SKILL.md"
      )
    ).toEqual([
      " 1 │ <ansi frontmatter>",
      " 2 │ <ansi name>",
      " 3 │ ",
    ]);
  });

  it("uses Pi built-in highlighting when configured", () => {
    setNativeHighlightBindingLoaderForTests(() => ({
      highlightPreview() {
        throw new Error("native highlighter should be bypassed");
      },
    }));

    const highlighted = highlightPreviewLine(
      " 1 │ const answer = 42;",
      "example.ts",
      "dark",
      "builtin"
    );

    expect(highlighted.startsWith(" 1 │ ")).toBe(true);
    expect(highlighted).toContain("\x1b[");
  });

  it("leaves non-code rows unchanged", () => {
    setNativeHighlightBindingLoaderForTests(() => ({
      highlightPreview() {
        throw new Error("should not be called");
      },
    }));

    expect(
      highlightPreviewLines(["… preview truncated"], "example.ts")
    ).toEqual(["… preview truncated"]);
  });

  it("warms the native binding once for both theme modes", () => {
    const calls: Array<{ themeMode?: "dark" | "light" | null; code: string }> =
      [];

    setNativeHighlightBindingLoaderForTests(() => ({
      highlightPreview(input) {
        calls.push({ code: input.code, themeMode: input.themeMode });
        return {
          lines: ["<ansi warmup>"],
          language: "typescript",
          usedPlaintext: false,
        };
      },
    }));

    warmPreviewHighlighter();
    warmPreviewHighlighter();

    expect(calls).toEqual([
      {
        code: "const __pi_picker_preview_warmup__ = 1;\n",
        themeMode: "dark",
      },
      {
        code: "const __pi_picker_preview_warmup__ = 1;\n",
        themeMode: "light",
      },
    ]);
  });

  it("skips native warmup when built-in highlighting is configured", () => {
    let calls = 0;

    setNativeHighlightBindingLoaderForTests(() => ({
      highlightPreview() {
        calls += 1;
        return {
          lines: ["<ansi warmup>"],
          language: "typescript",
          usedPlaintext: false,
        };
      },
    }));

    warmPreviewHighlighter("builtin");

    expect(calls).toBe(0);
  });
});
