import { createRequire } from "node:module";

import {
  getLanguageFromPath,
  highlightCode,
} from "@mariozechner/pi-coding-agent";

import type { PreviewHighlightMode } from "./types.js";

export interface NativeHighlightPreviewInput {
  code: string;
  filePath?: string | null;
  themeMode?: "dark" | "light" | null;
}

export interface NativeHighlightPreviewResult {
  lines: string[];
  language?: string | null;
  usedPlaintext: boolean;
}

interface NativeHighlightBinding {
  highlightPreview(
    input: NativeHighlightPreviewInput
  ): NativeHighlightPreviewResult;
}

interface ParsedPreviewLine {
  code: string;
  original: string;
  prefix: string;
}

// Matches bat's Monokai Extended gutterSettings foreground/divider colors.
const BAT_LINE_NUMBER_RGB = [131, 148, 150] as const;
const BAT_DIVIDER_RGB = [88, 110, 117] as const;

function isParsedPreviewLine(
  line: ParsedPreviewLine | null
): line is ParsedPreviewLine {
  return line !== null;
}

let nativeBindingLoader: (() => NativeHighlightBinding | null) | null = null;
let nativeBindingCache: NativeHighlightBinding | null | undefined;
let nativeWarmupAttempted = false;

function parsePreviewLine(line: string): ParsedPreviewLine | null {
  const match = line.match(/^(\s*\d+\s│ )(.*)$/u);
  if (!match) return null;

  const [, prefix, code] = match;
  return {
    code,
    original: line,
    prefix,
  };
}

function getNativeBindingModuleSpecifier(): string {
  return "../native/syntect-picker-preview/index.js";
}

function defaultLoadNativeBinding(): NativeHighlightBinding | null {
  if (nativeBindingCache !== undefined) {
    return nativeBindingCache;
  }

  try {
    const require = createRequire(import.meta.url);
    const nativeModule = require(getNativeBindingModuleSpecifier()) as {
      getNativeBinding?: () => NativeHighlightBinding;
    };
    nativeBindingCache = nativeModule.getNativeBinding?.() ?? null;
  } catch {
    nativeBindingCache = null;
  }

  return nativeBindingCache;
}

function loadNativeBinding(): NativeHighlightBinding | null {
  if (nativeBindingLoader) {
    return nativeBindingLoader();
  }
  return defaultLoadNativeBinding();
}

function foregroundRgb(
  text: string,
  [red, green, blue]: readonly [number, number, number]
): string {
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

function stylePreviewPrefix(prefix: string): string {
  const match = prefix.match(/^(\s*\d+\s)(│\s)$/u);
  if (!match) {
    return prefix;
  }

  const [, lineNumberPart, dividerPart] = match;
  return `${foregroundRgb(lineNumberPart, BAT_LINE_NUMBER_RGB)}${foregroundRgb(dividerPart, BAT_DIVIDER_RGB)}`;
}

function fallbackHighlightLines(
  parsedLines: ParsedPreviewLine[],
  filePath: string | undefined
): string[] {
  const language = filePath ? getLanguageFromPath(filePath) : undefined;

  return parsedLines.map(({ code, prefix, original }) => {
    try {
      const [highlighted = code] = highlightCode(code, language);
      return `${prefix}${highlighted}`;
    } catch {
      return original;
    }
  });
}

export function highlightPreviewLines(
  lines: string[],
  filePath?: string,
  themeMode: "dark" | "light" = "dark",
  highlightMode: PreviewHighlightMode = "native"
): string[] {
  if (lines.length === 0) return lines;

  const parsedLines = lines.map((line) => parsePreviewLine(line));
  const codeLines = parsedLines.filter(isParsedPreviewLine);
  if (codeLines.length === 0) {
    return lines;
  }

  const highlightedCodeLines = highlightCodeLines(
    codeLines,
    filePath,
    themeMode,
    highlightMode
  );
  let codeIndex = 0;

  return parsedLines.map((parsedLine, lineIndex) => {
    if (!parsedLine) {
      return lines[lineIndex] ?? "";
    }

    const highlightedLine =
      highlightedCodeLines[codeIndex] ?? parsedLine.original;
    codeIndex += 1;
    return highlightedLine;
  });
}

function highlightCodeLines(
  codeLines: ParsedPreviewLine[],
  filePath?: string,
  themeMode: "dark" | "light" = "dark",
  highlightMode: PreviewHighlightMode = "native"
): string[] {
  const fallbackToBuiltinHighlight = (): string[] =>
    fallbackHighlightLines(codeLines, filePath);

  if (highlightMode === "builtin") {
    return fallbackToBuiltinHighlight();
  }

  const nativeBinding = loadNativeBinding();
  if (!nativeBinding) {
    return fallbackToBuiltinHighlight();
  }

  try {
    const result = nativeBinding.highlightPreview({
      code: codeLines.map((line) => line.code).join("\n"),
      filePath,
      themeMode,
    });

    if (result.usedPlaintext) {
      return fallbackToBuiltinHighlight();
    }

    const highlightedLines = normalizeNativePreviewLines(
      result.lines,
      codeLines
    );
    if (!highlightedLines) {
      return fallbackToBuiltinHighlight();
    }

    return codeLines.map(
      (line, index) =>
        `${stylePreviewPrefix(line.prefix)}${highlightedLines[index] ?? line.code}`
    );
  } catch {
    return fallbackToBuiltinHighlight();
  }
}

function normalizeNativePreviewLines(
  highlightedLines: string[],
  codeLines: ParsedPreviewLine[]
): string[] | null {
  if (highlightedLines.length === codeLines.length) {
    return highlightedLines;
  }

  const lastCodeLine = codeLines[codeLines.length - 1];
  if (
    highlightedLines.length + 1 === codeLines.length &&
    lastCodeLine?.code === ""
  ) {
    return [...highlightedLines, ""];
  }

  return null;
}

export function highlightPreviewLine(
  line: string,
  filePath?: string,
  themeMode: "dark" | "light" = "dark",
  highlightMode: PreviewHighlightMode = "native"
): string {
  const [highlighted = line] = highlightPreviewLines(
    [line],
    filePath,
    themeMode,
    highlightMode
  );
  return highlighted;
}

export function warmPreviewHighlighter(
  highlightMode: PreviewHighlightMode = "native"
): void {
  if (highlightMode === "builtin" || nativeWarmupAttempted) {
    return;
  }

  nativeWarmupAttempted = true;
  const nativeBinding = loadNativeBinding();
  if (!nativeBinding) {
    return;
  }

  for (const themeMode of ["dark", "light"] as const) {
    try {
      nativeBinding.highlightPreview({
        code: "const __pi_picker_preview_warmup__ = 1;\n",
        filePath: "warmup.ts",
        themeMode,
      });
    } catch {
      return;
    }
  }
}

export function resolveNativeHighlightBindingPathForTests(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve(getNativeBindingModuleSpecifier());
  } catch {
    return null;
  }
}

export function setNativeHighlightBindingLoaderForTests(
  loader: (() => NativeHighlightBinding | null) | null
): void {
  nativeBindingLoader = loader;
  nativeBindingCache = undefined;
  nativeWarmupAttempted = false;
}
