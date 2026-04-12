import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

import type { ColorScheme, ColorValue, SemanticColor } from "./types.js";

const DEFAULT_COLORS: Required<ColorScheme> = {
  pi: "accent",
  model: "#d787af",
  path: "#00afaf",
  gitDirty: "warning",
  gitClean: "success",
  thinking: "muted",
  context: "dim",
  contextWarn: "warning",
  contextError: "error",
  cost: "text",
  tokens: "muted",
  separator: "borderMuted",
};

const RAINBOW_COLORS = [
  "#b281d6",
  "#d787af",
  "#febc38",
  "#e4c00f",
  "#89d281",
  "#00afaf",
  "#178fb9",
  "#b281d6",
];

const warnedInvalidThemeColors = new Set<string>();

export function getDefaultColors(): Required<ColorScheme> {
  return { ...DEFAULT_COLORS };
}

export function resolveColor(
  semantic: SemanticColor,
  presetColors?: ColorScheme
): ColorValue {
  return presetColors?.[semantic] ?? DEFAULT_COLORS[semantic];
}

function isHexColor(color: ColorValue): color is `#${string}` {
  return /^#[0-9a-fA-F]{6}$/.test(color);
}

function hexToAnsi(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function applyColor(
  theme: Theme,
  color: ColorValue,
  text: string
): string {
  if (isHexColor(color)) {
    return `${hexToAnsi(color)}${text}\x1b[0m`;
  }

  try {
    return theme.fg(color as ThemeColor, text);
  } catch (error) {
    const key = String(color);
    if (!warnedInvalidThemeColors.has(key)) {
      warnedInvalidThemeColors.add(key);
      if (warnedInvalidThemeColors.size > 200) {
        warnedInvalidThemeColors.clear();
      }
      console.debug(
        `[pieditor/status-bar] Invalid theme color "${key}"; falling back to "text".`,
        error
      );
    }
    return theme.fg("text", text);
  }
}

export function fg(
  theme: Theme,
  semantic: SemanticColor,
  text: string,
  presetColors?: ColorScheme
): string {
  return applyColor(theme, resolveColor(semantic, presetColors), text);
}

export function rainbow(text: string): string {
  let result = "";
  let colorIndex = 0;
  for (const char of text) {
    if (char === " " || char === ":") {
      result += char;
      continue;
    }
    result += `${hexToAnsi(RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]!)}${char}`;
    colorIndex++;
  }
  return result + "\x1b[0m";
}
