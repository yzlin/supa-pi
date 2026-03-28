import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PI_RTK_CONFIG,
  getPiRtkConfigPath,
  loadPiRtkConfig,
  normalizePiRtkConfig,
  savePiRtkConfig,
} from "./config";

describe("pi-rtk config", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-rtk-config-"));
    tempDirs.push(dir);
    return dir;
  }

  it("uses defaults when the config file is missing", () => {
    const cwd = createTempDir();

    expect(loadPiRtkConfig(cwd)).toEqual(DEFAULT_PI_RTK_CONFIG);
  });

  it("enables output compaction by default", () => {
    expect(DEFAULT_PI_RTK_CONFIG.outputCompaction).toMatchObject({
      enabled: true,
      compactBash: true,
      compactGrep: true,
      compactRead: true,
      trackSavings: true,
    });
  });

  it("falls back safely on malformed JSON", () => {
    const cwd = createTempDir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(getPiRtkConfigPath(cwd), "{not-json", "utf8");

    expect(loadPiRtkConfig(cwd)).toEqual(DEFAULT_PI_RTK_CONFIG);
  });

  it("normalizes invalid fields", () => {
    const normalized = normalizePiRtkConfig({
      enabled: "yes",
      mode: "other",
      outputCompaction: {
        maxLines: -10,
        maxChars: "huge",
        compactRead: true,
      },
    });

    expect(normalized).toEqual({
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        compactRead: true,
        maxLines: 1,
      },
    });
    expect(normalized.outputCompaction.maxChars).toBe(
      DEFAULT_PI_RTK_CONFIG.outputCompaction.maxChars
    );
  });

  it("saves and loads a roundtrip config", () => {
    const cwd = createTempDir();
    const saved = savePiRtkConfig(cwd, {
      ...DEFAULT_PI_RTK_CONFIG,
      enabled: false,
      mode: "suggest",
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        compactBash: true,
        maxLines: 120,
      },
    });

    expect(saved).toEqual({
      ...DEFAULT_PI_RTK_CONFIG,
      enabled: false,
      mode: "suggest",
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        compactBash: true,
        maxLines: 120,
      },
    });
    expect(loadPiRtkConfig(cwd)).toEqual(saved);
  });
});
