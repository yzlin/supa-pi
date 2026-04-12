import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export interface PaletteTheme {
  border: string;
  title: string;
  selected: string;
  selectedText: string;
  directory: string;
  checked: string;
  searchIcon: string;
  placeholder: string;
  hint: string;
}

const DEFAULT_THEME: PaletteTheme = {
  border: "2",
  title: "2",
  selected: "36",
  selectedText: "36",
  directory: "34",
  checked: "32",
  searchIcon: "2",
  placeholder: "2;3",
  hint: "2",
};

function loadTheme(): PaletteTheme {
  const themePath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "extensions",
    "file-picker",
    "theme.json"
  );
  try {
    if (fs.existsSync(themePath)) {
      const content = fs.readFileSync(themePath, "utf-8");
      const custom = JSON.parse(content) as Partial<PaletteTheme>;
      return { ...DEFAULT_THEME, ...custom };
    }
  } catch {
    // Ignore errors
  }
  return DEFAULT_THEME;
}

export function fg(code: string, text: string): string {
  if (!code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const paletteTheme = loadTheme();

export function padVisibleText(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function truncateVisibleText(text: string, maxWidth: number): string {
  return truncateToWidth(text, maxWidth, "…");
}

export function inferPreviewThemeMode(theme: unknown): "dark" | "light" {
  const name =
    typeof theme === "object" && theme !== null && "name" in theme
      ? String((theme as { name?: unknown }).name ?? "")
      : "";

  return name.toLowerCase().includes("light") ? "light" : "dark";
}
