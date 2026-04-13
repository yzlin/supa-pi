import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { RtkConfig, RtkMode } from "./types";

const DEFAULT_OUTPUT_MAX_LINES = 400;
const DEFAULT_OUTPUT_MAX_CHARS = 12_000;

export const DEFAULT_RTK_CONFIG: RtkConfig = {
  enabled: true,
  mode: "rewrite",
  guardWhenRtkMissing: true,
  showRewriteNotifications: false,
  outputCompaction: {
    enabled: true,
    compactBash: true,
    compactGrep: true,
    compactRead: true,
    readSourceFilteringEnabled: false,
    maxLines: DEFAULT_OUTPUT_MAX_LINES,
    maxChars: DEFAULT_OUTPUT_MAX_CHARS,
    trackSavings: true,
  },
};

function cloneConfig(config: RtkConfig): RtkConfig {
  return structuredClone(config);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  minimum = 0
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(minimum, Math.trunc(value));
}

function normalizeMode(value: unknown, fallback: RtkMode): RtkMode {
  return value === "rewrite" || value === "suggest" ? value : fallback;
}

export function getRtkConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".pi", "rtk.json");
}

export function normalizeRtkConfig(input: unknown): RtkConfig {
  const config = asRecord(input);
  const outputCompaction = asRecord(config.outputCompaction);

  return {
    enabled: normalizeBoolean(config.enabled, DEFAULT_RTK_CONFIG.enabled),
    mode: normalizeMode(config.mode, DEFAULT_RTK_CONFIG.mode),
    guardWhenRtkMissing: normalizeBoolean(
      config.guardWhenRtkMissing,
      DEFAULT_RTK_CONFIG.guardWhenRtkMissing
    ),
    showRewriteNotifications: normalizeBoolean(
      config.showRewriteNotifications,
      DEFAULT_RTK_CONFIG.showRewriteNotifications
    ),
    outputCompaction: {
      enabled: normalizeBoolean(
        outputCompaction.enabled,
        DEFAULT_RTK_CONFIG.outputCompaction.enabled
      ),
      compactBash: normalizeBoolean(
        outputCompaction.compactBash,
        DEFAULT_RTK_CONFIG.outputCompaction.compactBash
      ),
      compactGrep: normalizeBoolean(
        outputCompaction.compactGrep,
        DEFAULT_RTK_CONFIG.outputCompaction.compactGrep
      ),
      compactRead: normalizeBoolean(
        outputCompaction.compactRead,
        DEFAULT_RTK_CONFIG.outputCompaction.compactRead
      ),
      readSourceFilteringEnabled: normalizeBoolean(
        outputCompaction.readSourceFilteringEnabled,
        DEFAULT_RTK_CONFIG.outputCompaction.readSourceFilteringEnabled
      ),
      maxLines: normalizeInteger(
        outputCompaction.maxLines,
        DEFAULT_RTK_CONFIG.outputCompaction.maxLines,
        1
      ),
      maxChars: normalizeInteger(
        outputCompaction.maxChars,
        DEFAULT_RTK_CONFIG.outputCompaction.maxChars,
        1
      ),
      trackSavings: normalizeBoolean(
        outputCompaction.trackSavings,
        DEFAULT_RTK_CONFIG.outputCompaction.trackSavings
      ),
    },
  };
}

export function loadRtkConfig(cwd = process.cwd()): RtkConfig {
  const configPath = getRtkConfigPath(cwd);
  if (!existsSync(configPath)) {
    return cloneConfig(DEFAULT_RTK_CONFIG);
  }

  try {
    const text = readFileSync(configPath, "utf8");
    return normalizeRtkConfig(JSON.parse(text));
  } catch {
    return cloneConfig(DEFAULT_RTK_CONFIG);
  }
}

export function saveRtkConfig(cwd: string, config: RtkConfig): RtkConfig {
  const configPath = getRtkConfigPath(cwd);
  const normalized = normalizeRtkConfig(config);
  const tempPath = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  renameSync(tempPath, configPath);

  return normalized;
}

export function resetRtkConfig(cwd: string): RtkConfig {
  return saveRtkConfig(cwd, cloneConfig(DEFAULT_RTK_CONFIG));
}
