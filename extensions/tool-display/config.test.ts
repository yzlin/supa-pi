import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TOOL_DISPLAY_CONFIG,
  getGlobalToolDisplayConfigPath,
  getProjectToolDisplayConfigPath,
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
        tools: {
          read: { enabled: false, fullRead: { enabled: false } },
          search: { enabled: true },
          edit: { enabled: "yes" },
        },
        output: {
          read: { mode: "expanded", collapsed: false, previewLines: 40 },
          search: { mode: "loud", collapsed: "no" },
          bash: { rtkHints: false },
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
      })
    ).toEqual({
      tools: {
        read: { enabled: false, fullRead: { enabled: false } },
        search: { enabled: true },
      },
      output: {
        read: { mode: "expanded", collapsed: false, previewLines: 40 },
        bash: { rtkHints: false },
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

    const config = loadToolDisplayConfig(cwd, homeDir);
    expect(config.tools.read.enabled).toBe(false);
    expect(
      config.tools.read.fullRead.targets.find(
        (target) => target.name === "skills"
      )?.enabled
    ).toBe(false);
    expect(config.tools.search.enabled).toBe(true);
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
      })
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
      }
    );

    expect(
      config.tools.read.fullRead.targets
        .map((target) => target.name)
        .slice(0, 2)
    ).toEqual(["custom", "skills"]);
    expect(
      config.tools.read.fullRead.targets.find(
        (target) => target.name === "skills"
      )
    ).toMatchObject({
      enabled: false,
      provenance: "global",
    });
    expect(
      config.tools.read.fullRead.targets.find(
        (target) => target.name === "custom"
      )
    ).toMatchObject({
      maxBytes: 2048,
      provenance: "project",
      warnings: ["target custom: invalid source ignored"],
    });
    expect(config.tools.read.fullRead.warnings).not.toContain(
      "target custom: invalid source ignored"
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
      "utf8"
    );

    const result = saveProjectToolDisplayConfig(
      cwd,
      {
        tools: { read: { enabled: false }, write: { enabled: true } },
        diff: { indicatorMode: "none" },
      },
      homeDir
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
