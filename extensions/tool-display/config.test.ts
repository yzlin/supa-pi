import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TOOL_DISPLAY_CONFIG,
  getGlobalToolDisplayConfigPath,
  getProjectToolDisplayConfigPath,
  getToolDisplayPresetConfig,
  loadToolDisplayConfig,
  loadToolDisplayConfigFromLayers,
  normalizeToolDisplayConfig,
  saveProjectToolDisplayConfig,
  TOOL_DISPLAY_FULL_READ_MAX_BYTES,
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

  it("normalizes and merges independent drawing gates with validated fallback previews", () => {
    const config = loadToolDisplayConfigFromLayers(
      {
        output: {
          read: { enabled: false },
          search: { enabled: false },
          fallback: { enabled: false, previewLines: 3 },
        },
      },
      {
        output: {
          read: { enabled: true },
          search: { enabled: "yes" },
          fallback: {
            enabled: true,
            collapsed: false,
            mode: "expanded",
            previewLines: -1,
          },
        },
      },
    );
    expect(config.output.read.enabled).toBe(true);
    expect(config.output.search.enabled).toBe(false);
    expect(config.output.fallback).toEqual({
      enabled: true,
      mode: "expanded",
      collapsed: false,
      previewLines: 3,
    });
    expect(config.tools.search.enabled).toBe(true);
    expect(
      normalizeToolDisplayConfig({
        output: {
          fallback: {
            enabled: "no",
            mode: "bad",
            collapsed: "no",
            previewLines: 0,
          },
        },
      }),
    ).toEqual({});
    for (const preset of ["compact", "verbose", "off"] as const) {
      const value = getToolDisplayPresetConfig(preset);
      for (const section of Object.values(value.output)) {
        expect(section.enabled).toBe(preset !== "off");
      }
      expect(value.diff.enabled).toBe(preset !== "off");
    }
  });

  it("uses grouped defaults when config files are missing", () => {
    expect(
      loadToolDisplayConfig(
        createTempDir("tool-display-cwd-"),
        createTempDir("tool-display-home-"),
      ),
    ).toEqual(DEFAULT_TOOL_DISPLAY_CONFIG);
  });

  it("keeps the candidate edit override disabled by default", () => {
    expect(DEFAULT_TOOL_DISPLAY_CONFIG.tools.edit).toEqual({
      enabled: false,
      allowPermanentDelete: false,
    });
    expect(getToolDisplayPresetConfig("compact").tools.edit.enabled).toBe(
      false,
    );
    expect(getToolDisplayPresetConfig("verbose").tools.edit.enabled).toBe(
      false,
    );
  });

  it("keeps permanent delete disabled in the off preset", () => {
    expect(getToolDisplayPresetConfig("off").tools.edit).toEqual({
      enabled: false,
      allowPermanentDelete: false,
    });
  });

  it("normalizes grouped tool config fields", () => {
    expect(
      normalizeToolDisplayConfig({
        tools: {
          read: { enabled: false, fullRead: { enabled: false } },
          search: { enabled: true },
          edit: { enabled: "yes", allowPermanentDelete: true },
        },
        output: {
          read: { mode: "expanded", collapsed: false, previewLines: 40 },
          search: { mode: "loud", collapsed: "no" },
          bash: { enabled: false, rtkHints: false },
        },
        diff: {
          enabled: false,
          collapsed: false,
          previewLines: 120,
          viewMode: "split",
          splitMinWidth: 140,
          wordWrap: false,
          indicatorMode: "classic",
        },
      }),
    ).toEqual({
      tools: {
        read: { enabled: false, fullRead: { enabled: false } },
        search: { enabled: true },
        edit: { allowPermanentDelete: true },
      },
      output: {
        read: { mode: "expanded", collapsed: false, previewLines: 40 },
        bash: { enabled: false, rtkHints: false },
      },
      diff: {
        enabled: false,
        collapsed: false,
        previewLines: 120,
        viewMode: "split",
        splitMinWidth: 140,
        wordWrap: false,
        indicatorMode: "classic",
      },
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
          read: { fullRead: { targets: [{ name: "skills", enabled: false }] } },
          search: { enabled: true },
          edit: { allowPermanentDelete: true },
        },
      }),
      "utf8",
    );
    writeFileSync(
      getProjectToolDisplayConfigPath(cwd),
      JSON.stringify({
        tools: {
          read: { enabled: false },
          edit: { allowPermanentDelete: false },
        },
      }),
      "utf8",
    );

    const config = loadToolDisplayConfig(cwd, homeDir);
    expect(config.tools.read.enabled).toBe(false);
    expect(
      config.tools.read.fullRead.targets.find(
        (target) => target.name === "skills",
      )?.enabled,
    ).toBe(false);
    expect(config.tools.search.enabled).toBe(true);
    expect(config.tools.edit.allowPermanentDelete).toBe(false);
    expect(config.output.bash.enabled).toBe(true);
  });

  it("normalizes fullRead targets", () => {
    expect(
      normalizeToolDisplayConfig({
        tools: {
          read: {
            fullRead: {
              order: ["project-rules", "skills"],
              targets: [
                {
                  name: "custom",
                  enabled: false,
                  source: "patterns",
                  maxBytes: TOOL_DISPLAY_FULL_READ_MAX_BYTES + 1,
                  ignorePagination: false,
                  baseDir: "docs",
                  include: ["**/*.md"],
                  exclude: ["drafts/**"],
                },
                { name: "bad", source: "nope" },
                { enabled: true },
              ],
            },
          },
        },
      }),
    ).toEqual({
      tools: {
        read: {
          fullRead: {
            order: ["project-rules", "skills"],
            targets: [
              {
                name: "custom",
                enabled: false,
                source: "patterns",
                maxBytes: TOOL_DISPLAY_FULL_READ_MAX_BYTES,
                ignorePagination: false,
                baseDir: "docs",
                include: ["**/*.md"],
                exclude: ["drafts/**"],
                warnings: [
                  `target custom: maxBytes clamped to ${TOOL_DISPLAY_FULL_READ_MAX_BYTES}`,
                ],
              },
              { name: "bad", warnings: ["target bad: invalid source ignored"] },
            ],
            warnings: ["target at index 2: missing name ignored"],
          },
        },
      },
    });
  });

  it("merges fullRead targets by name, disables by name, orders names first, and keeps provenance/warnings", () => {
    const config = loadToolDisplayConfigFromLayers(
      {
        tools: {
          read: {
            fullRead: {
              targets: [
                { name: "skills", enabled: false },
                {
                  name: "custom",
                  source: "patterns",
                  baseDir: "docs",
                  include: ["**/*.md"],
                },
              ],
            },
          },
        },
      },
      {
        tools: {
          read: {
            fullRead: {
              order: ["custom", "skills"],
              targets: [{ name: "custom", maxBytes: 2048, source: "bad" }],
            },
          },
        },
      },
    );

    expect(
      config.tools.read.fullRead.targets
        .map((target) => target.name)
        .slice(0, 2),
    ).toEqual(["custom", "skills"]);
    expect(
      config.tools.read.fullRead.targets.find(
        (target) => target.name === "skills",
      ),
    ).toMatchObject({
      enabled: false,
      provenance: "global",
    });
    expect(
      config.tools.read.fullRead.targets.find(
        (target) => target.name === "custom",
      ),
    ).toMatchObject({
      maxBytes: 2048,
      provenance: "project",
      warnings: ["target custom: invalid source ignored"],
    });
    expect(config.tools.read.fullRead.warnings).not.toContain(
      "target custom: invalid source ignored",
    );
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
        diff: { viewMode: "unified" },
      }),
      "utf8",
    );

    const result = saveProjectToolDisplayConfig(
      cwd,
      {
        tools: { read: { enabled: false }, write: { enabled: true } },
        diff: { indicatorMode: "none" },
      },
      homeDir,
    );

    expect(result).toMatchObject({ ok: true });
    expect(loadToolDisplayConfig(cwd, homeDir).tools).toMatchObject({
      read: { enabled: false, fullRead: { enabled: true } },
      search: { enabled: true },
      write: { enabled: true },
    });
    expect(loadToolDisplayConfig(cwd, homeDir).diff).toMatchObject({
      viewMode: "unified",
      indicatorMode: "none",
    });
  });
});

describe("companion output gates", () => {
  it("normalizes and merges every companion group and enables/disables presets", () => {
    for (const group of ["tasks", "mcp", "web"] as const) {
      const config = loadToolDisplayConfigFromLayers(
        {
          output: {
            [group]: { enabled: false, collapsed: false, previewLines: 4 },
          },
        },
        {
          output: {
            [group]: { enabled: true, collapsed: "invalid", previewLines: 2 },
          },
        },
      );
      expect(config.output[group]).toEqual({
        enabled: true,
        mode: "compact",
        collapsed: false,
        previewLines: 2,
      });
      expect(
        normalizeToolDisplayConfig({
          output: {
            [group]: { enabled: "yes", collapsed: 1, previewLines: 0 },
          },
        }),
      ).toEqual({});
      for (const preset of ["compact", "verbose", "off"] as const) {
        expect(getToolDisplayPresetConfig(preset).output[group].enabled).toBe(
          preset !== "off",
        );
      }
    }
  });
});
