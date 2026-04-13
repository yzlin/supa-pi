import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_RTK_CONFIG,
  getRtkConfigPath,
  loadRtkConfig,
  normalizeRtkConfig,
  saveRtkConfig,
} from "./config";

describe("rtk config", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "rtk-config-"));
    tempDirs.push(dir);
    return dir;
  }

  it("uses defaults when the config file is missing", () => {
    const cwd = createTempDir();

    expect(loadRtkConfig(cwd)).toEqual(DEFAULT_RTK_CONFIG);
  });

  it("enables output compaction by default", () => {
    expect(DEFAULT_RTK_CONFIG.outputCompaction).toMatchObject({
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
    writeFileSync(getRtkConfigPath(cwd), "{not-json", "utf8");

    expect(loadRtkConfig(cwd)).toEqual(DEFAULT_RTK_CONFIG);
  });

  it("normalizes invalid fields", () => {
    const normalized = normalizeRtkConfig({
      enabled: "yes",
      mode: "other",
      outputCompaction: {
        maxLines: -10,
        maxChars: "huge",
        compactRead: true,
      },
    });

    expect(normalized).toEqual({
      ...DEFAULT_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_RTK_CONFIG.outputCompaction,
        compactRead: true,
        maxLines: 1,
      },
    });
    expect(normalized.outputCompaction.maxChars).toBe(
      DEFAULT_RTK_CONFIG.outputCompaction.maxChars
    );
  });

  it("saves and loads a roundtrip config", () => {
    const cwd = createTempDir();
    const saved = saveRtkConfig(cwd, {
      ...DEFAULT_RTK_CONFIG,
      enabled: false,
      mode: "suggest",
      outputCompaction: {
        ...DEFAULT_RTK_CONFIG.outputCompaction,
        compactBash: true,
        maxLines: 120,
      },
    });

    expect(saved).toEqual({
      ...DEFAULT_RTK_CONFIG,
      enabled: false,
      mode: "suggest",
      outputCompaction: {
        ...DEFAULT_RTK_CONFIG.outputCompaction,
        compactBash: true,
        maxLines: 120,
      },
    });
    expect(loadRtkConfig(cwd)).toEqual(saved);
  });
});
