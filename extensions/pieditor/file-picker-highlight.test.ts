import { afterEach, describe, expect, it } from "bun:test";

import { initTheme } from "@mariozechner/pi-coding-agent";

import {
  highlightPreviewLine,
  highlightPreviewLines,
  resolveNativeHighlightBindingPathForTests,
  setNativeHighlightBindingLoaderForTests,
  warmPreviewHighlighter,
} from "./file-picker-highlight";

initTheme("dark");

const BAT_LINE_NUMBER_COLOR = "\x1b[38;2;131;148;150m";
const BAT_DIVIDER_COLOR = "\x1b[38;2;88;110;117m";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

afterEach(() => {
  setNativeHighlightBindingLoaderForTests(null);
});

describe("file picker native preview highlighting", () => {
  it("keeps gutter colors when falling back to Pi highlighting", () => {
    setNativeHighlightBindingLoaderForTests(() => null);

    const line = highlightPreviewLine(" 1 │ const answer = 42;", "example.ts");

    expect(stripAnsi(line)).toBe(" 1 │ const answer = 42;");
    expect(line).toContain(BAT_LINE_NUMBER_COLOR);
    expect(line).toContain(BAT_DIVIDER_COLOR);
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

    const highlighted = highlightPreviewLines(
      [" 1 │ const answer = 42;", " 2 │ return answer;"],
      "example.ts",
      "light"
    );

    expect(highlighted.map(stripAnsi)).toEqual([
      " 1 │ <ansi const>",
      " 2 │ <ansi return>",
    ]);
    expect(highlighted[0]).toContain(BAT_LINE_NUMBER_COLOR);
    expect(highlighted[0]).toContain(BAT_DIVIDER_COLOR);
  });

  it("keeps gutter colors when the native binding falls back to plain text", () => {
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
    expect(highlighted[0]).toContain(BAT_LINE_NUMBER_COLOR);
    expect(highlighted[0]).toContain(BAT_DIVIDER_COLOR);
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

    const highlighted = highlightPreviewLines(
      [" 1 │ ---", " 2 │ name: session-query", " 3 │ "],
      "@skills/session-query/SKILL.md"
    );

    expect(highlighted.map(stripAnsi)).toEqual([
      " 1 │ <ansi frontmatter>",
      " 2 │ <ansi name>",
      " 3 │ ",
    ]);
  });

  it("uses Pi built-in highlighting with colored gutter when configured", () => {
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

    expect(stripAnsi(highlighted)).toBe(" 1 │ const answer = 42;");
    expect(highlighted).toContain(BAT_LINE_NUMBER_COLOR);
    expect(highlighted).toContain(BAT_DIVIDER_COLOR);
    expect(highlighted).toContain("\x1b[");
  });

  it("keeps gutter colors for unrecognized file types", () => {
    setNativeHighlightBindingLoaderForTests(() => null);

    const highlighted = highlightPreviewLine(
      " 1 │ just some text",
      "notes.unknownext"
    );

    expect(stripAnsi(highlighted)).toBe(" 1 │ just some text");
    expect(highlighted).toContain(BAT_LINE_NUMBER_COLOR);
    expect(highlighted).toContain(BAT_DIVIDER_COLOR);
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

  it("resolves the native binding module from the moved file-picker folder", () => {
    const resolvedPath = resolveNativeHighlightBindingPathForTests();

    expect(resolvedPath).not.toBeNull();
    expect(
      resolvedPath?.endsWith(
        "extensions/pieditor/native/syntect-picker-preview/index.js"
      )
    ).toBe(true);
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
