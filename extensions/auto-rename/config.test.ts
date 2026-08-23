import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_RENAME_CONFIG_LIMITS,
  DEFAULT_AUTO_RENAME_CONFIG,
  getAutoRenameConfigPath,
  loadAutoRenameConfig,
  validateAutoRenameConfig,
} from "./config";

const CONFIG_KEYS = [
  "enabled",
  "prompt",
  "maxQueryLength",
  "maxNameLength",
  "timeoutMs",
  "debug",
] as const;

describe("auto-rename config", () => {
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function useTempHome(): string {
    const homeDir = mkdtempSync(join(tmpdir(), "auto-rename-config-"));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    return homeDir;
  }

  function writeConfig(homeDir: string, contents: string): void {
    const configPath = getAutoRenameConfigPath(homeDir);
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(configPath, contents, "utf8");
  }

  function expectInvalid(value: unknown): void {
    const result = validateAutoRenameConfig(value);

    expect(result.valid).toBe(false);
    expect(result.config.enabled).toBe(false);
    if (result.valid === false) {
      expect(result.error).toBeString();
    }
  }

  it("uses locked defaults when the global config file is missing", () => {
    const homeDir = useTempHome();

    expect(getAutoRenameConfigPath()).toBe(
      join(homeDir, ".pi", "agent", "auto-rename.json")
    );
    expect(loadAutoRenameConfig()).toEqual({
      valid: true,
      source: "defaults",
      config: DEFAULT_AUTO_RENAME_CONFIG,
    });
    expect(DEFAULT_AUTO_RENAME_CONFIG).toEqual({
      enabled: true,
      prompt:
        "Generate a concise 3–6 word plain Title Case session title for the user's request. Return only the title.",
      maxQueryLength: 2000,
      maxNameLength: 80,
      timeoutMs: 10_000,
      debug: false,
    });
    expect(DEFAULT_AUTO_RENAME_CONFIG.prompt.trim().length).toBeGreaterThan(0);
  });

  it("reads only ~/.pi/agent/auto-rename.json", () => {
    const homeDir = useTempHome();
    mkdirSync(join(homeDir, ".pi"), { recursive: true });
    writeFileSync(
      join(homeDir, ".pi", "auto-rename.json"),
      JSON.stringify({ enabled: false }),
      "utf8"
    );
    writeFileSync(
      join(homeDir, "auto-rename.json"),
      JSON.stringify({ enabled: false }),
      "utf8"
    );

    expect(loadAutoRenameConfig()).toEqual({
      valid: true,
      source: "defaults",
      config: DEFAULT_AUTO_RENAME_CONFIG,
    });
  });

  it("merges a valid bounded partial config onto defaults", () => {
    const homeDir = useTempHome();
    writeConfig(
      homeDir,
      JSON.stringify({
        enabled: false,
        prompt: "Create a short project task title.",
        maxQueryLength: 500,
        maxNameLength: 60,
        timeoutMs: 2500,
        debug: true,
      })
    );

    expect(loadAutoRenameConfig()).toEqual({
      valid: true,
      source: "file",
      config: {
        enabled: false,
        prompt: "Create a short project task title.",
        maxQueryLength: 500,
        maxNameLength: 60,
        timeoutMs: 2500,
        debug: true,
      },
    });

    expect(validateAutoRenameConfig({ debug: true })).toEqual({
      valid: true,
      source: "file",
      config: { ...DEFAULT_AUTO_RENAME_CONFIG, debug: true },
    });
  });

  it("disables naming for malformed JSON instead of using enabled defaults", () => {
    const homeDir = useTempHome();
    writeConfig(homeDir, "{not-json");

    const result = loadAutoRenameConfig();
    expect(result.valid).toBe(false);
    expect(result.source).toBe("invalid");
    expect(result.config.enabled).toBe(false);
    if (result.valid === false) {
      expect(result.error).toBeString();
    }
  });

  it("rejects non-object roots", () => {
    for (const value of [null, [], "config", 1, true]) {
      expectInvalid(value);
    }
  });

  it("rejects unknown keys", () => {
    expectInvalid({ enabled: true, extra: true });
    expect(Object.keys(DEFAULT_AUTO_RENAME_CONFIG)).toEqual([...CONFIG_KEYS]);
  });

  it("rejects wrong field types", () => {
    for (const value of [
      { enabled: "true" },
      { prompt: 42 },
      { maxQueryLength: "2000" },
      { maxNameLength: false },
      { timeoutMs: "10000" },
      { debug: 0 },
    ]) {
      expectInvalid(value);
    }
  });

  it("rejects empty and oversized prompts", () => {
    expectInvalid({ prompt: "" });
    expectInvalid({ prompt: "  \n\t" });
    expectInvalid({
      prompt: "x".repeat(AUTO_RENAME_CONFIG_LIMITS.prompt.max + 1),
    });
  });

  it("accepts inclusive numeric boundaries", () => {
    const result = validateAutoRenameConfig({
      maxQueryLength: AUTO_RENAME_CONFIG_LIMITS.maxQueryLength.min,
      maxNameLength: AUTO_RENAME_CONFIG_LIMITS.maxNameLength.max,
      timeoutMs: AUTO_RENAME_CONFIG_LIMITS.timeoutMs.min,
    });

    expect(result.valid).toBe(true);
  });

  it("rejects non-integer and out-of-range numeric values", () => {
    for (const value of [
      { maxQueryLength: 1.5 },
      {
        maxQueryLength: AUTO_RENAME_CONFIG_LIMITS.maxQueryLength.min - 1,
      },
      {
        maxQueryLength: AUTO_RENAME_CONFIG_LIMITS.maxQueryLength.max + 1,
      },
      { maxNameLength: Number.NaN },
      { maxNameLength: AUTO_RENAME_CONFIG_LIMITS.maxNameLength.min - 1 },
      { maxNameLength: AUTO_RENAME_CONFIG_LIMITS.maxNameLength.max + 1 },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { timeoutMs: AUTO_RENAME_CONFIG_LIMITS.timeoutMs.min - 1 },
      { timeoutMs: AUTO_RENAME_CONFIG_LIMITS.timeoutMs.max + 1 },
    ]) {
      expectInvalid(value);
    }
  });
});
