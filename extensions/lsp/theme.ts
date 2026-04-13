import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { visibleWidth } from "@mariozechner/pi-tui";

interface LspPaletteTheme {
  border: string;
  title: string;
}

const DEFAULT_THEME: LspPaletteTheme = {
  border: "2",
  title: "2",
};

function loadTheme(): LspPaletteTheme {
  const themePath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "extensions",
    "file-picker",
    "theme.json"
  );

  try {
    if (!fs.existsSync(themePath)) {
      return DEFAULT_THEME;
    }

    const content = fs.readFileSync(themePath, "utf-8");
    const custom = JSON.parse(content) as Partial<LspPaletteTheme>;
    return { ...DEFAULT_THEME, ...custom };
  } catch {
    return DEFAULT_THEME;
  }
}

export function fg(code: string, text: string): string {
  return code ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const paletteTheme = loadTheme();

export function padVisibleText(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
