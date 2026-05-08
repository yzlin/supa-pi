import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TOOL_DISPLAY_CONFIG,
  getGlobalToolDisplayConfigPath,
  getProjectToolDisplayConfigPath,
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveProjectToolDisplayConfig,
} from "./config";

describe("tool-display config", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("uses grouped defaults when config files are missing", () => {
    expect(
      loadToolDisplayConfig(
        createTempDir("tool-display-cwd-"),
        createTempDir("tool-display-home-")
      )
    ).toEqual(DEFAULT_TOOL_DISPLAY_CONFIG);
  });

  it("normalizes grouped tool config fields", () => {
    expect(
      normalizeToolDisplayConfig({
        readPatch: { enabled: true },
        tools: {
          read: { enabled: false, fullSkillRead: false },
          search: { enabled: true },
          edit: { enabled: "yes" },
        },
        output: {
          read: { mode: "expanded", collapsed: false, previewLines: 40 },
          search: { mode: "loud", collapsed: "no" },
          bash: { rtkHints: false },
        },
        diff: { enabled: false, previewLines: 120 },
      })
    ).toEqual({
      tools: {
        read: { enabled: false, fullSkillRead: false },
        search: { enabled: true },
      },
      output: {
        read: { mode: "expanded", collapsed: false, previewLines: 40 },
        bash: { rtkHints: false },
      },
      diff: { enabled: false, previewLines: 120 },
    });
  });

  it("loads defaults, then global, then project config precedence", () => {
    const cwd = createTempDir("tool-display-cwd-");
    const homeDir = createTempDir("tool-display-home-");
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });

    writeFileSync(
      getGlobalToolDisplayConfigPath(homeDir),
      JSON.stringify({
        tools: {
          read: { fullSkillRead: false },
          search: { enabled: true },
        },
      }),
      "utf8"
    );
    writeFileSync(
      getProjectToolDisplayConfigPath(cwd),
      JSON.stringify({
        tools: {
          read: { enabled: false },
        },
      }),
      "utf8"
    );

    expect(loadToolDisplayConfig(cwd, homeDir)).toEqual({
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      tools: {
        read: { enabled: false, fullSkillRead: false },
        search: { enabled: true },
        edit: { enabled: true },
        write: { enabled: true },
      },
    });
  });

  it("saves normalized project config without overwriting unrelated keys", () => {
    const cwd = createTempDir("tool-display-cwd-");
    const homeDir = createTempDir("tool-display-home-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      getProjectToolDisplayConfigPath(cwd),
      JSON.stringify({
        unrelated: true,
        tools: { search: { enabled: true } },
      }),
      "utf8"
    );

    const result = saveProjectToolDisplayConfig(
      cwd,
      { tools: { read: { enabled: false }, write: { enabled: true } } },
      homeDir
    );

    expect(result).toMatchObject({ ok: true });
    expect(loadToolDisplayConfig(cwd, homeDir).tools).toMatchObject({
      read: { enabled: false, fullSkillRead: true },
      search: { enabled: true },
      write: { enabled: true },
    });
  });
});
