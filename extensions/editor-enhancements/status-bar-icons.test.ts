import { afterEach, describe, expect, it } from "bun:test";

import { getIcons, hasNerdFonts } from "./status-bar-icons.js";

const originalNerdFonts = process.env.POWERLINE_NERD_FONTS;
const originalGhosttyResourcesDir = process.env.GHOSTTY_RESOURCES_DIR;
const originalTermProgram = process.env.TERM_PROGRAM;

afterEach(() => {
  if (originalNerdFonts === undefined) {
    delete process.env.POWERLINE_NERD_FONTS;
  } else {
    process.env.POWERLINE_NERD_FONTS = originalNerdFonts;
  }

  if (originalGhosttyResourcesDir === undefined) {
    delete process.env.GHOSTTY_RESOURCES_DIR;
  } else {
    process.env.GHOSTTY_RESOURCES_DIR = originalGhosttyResourcesDir;
  }

  if (originalTermProgram === undefined) {
    delete process.env.TERM_PROGRAM;
  } else {
    process.env.TERM_PROGRAM = originalTermProgram;
  }
});

describe("status bar icons", () => {
  it("defaults to nerd fonts when not explicitly disabled", () => {
    delete process.env.POWERLINE_NERD_FONTS;
    delete process.env.GHOSTTY_RESOURCES_DIR;
    process.env.TERM_PROGRAM = "unknown-terminal";

    expect(hasNerdFonts()).toBe(true);
    expect(getIcons().model).toBe("\u{f544}");
  });

  it("falls back to ascii icons when explicitly disabled", () => {
    process.env.POWERLINE_NERD_FONTS = "0";
    delete process.env.GHOSTTY_RESOURCES_DIR;
    process.env.TERM_PROGRAM = "ghostty";

    expect(hasNerdFonts()).toBe(false);
    expect(getIcons().model).toBe("✦");
  });
});
