import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { PiRtkConfig, PiRtkMode } from "./types";

const DEFAULT_OUTPUT_MAX_LINES = 400;
const DEFAULT_OUTPUT_MAX_CHARS = 12_000;

export const DEFAULT_PI_RTK_CONFIG: PiRtkConfig = {
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

function cloneConfig(config: PiRtkConfig): PiRtkConfig {
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

function normalizeMode(value: unknown, fallback: PiRtkMode): PiRtkMode {
  return value === "rewrite" || value === "suggest" ? value : fallback;
}

export function getPiRtkConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".pi", "rtk.json");
}

export function normalizePiRtkConfig(input: unknown): PiRtkConfig {
  const config = asRecord(input);
  const outputCompaction = asRecord(config.outputCompaction);

  return {
    enabled: normalizeBoolean(config.enabled, DEFAULT_PI_RTK_CONFIG.enabled),
    mode: normalizeMode(config.mode, DEFAULT_PI_RTK_CONFIG.mode),
    guardWhenRtkMissing: normalizeBoolean(
      config.guardWhenRtkMissing,
      DEFAULT_PI_RTK_CONFIG.guardWhenRtkMissing
    ),
    showRewriteNotifications: normalizeBoolean(
      config.showRewriteNotifications,
      DEFAULT_PI_RTK_CONFIG.showRewriteNotifications
    ),
    outputCompaction: {
      enabled: normalizeBoolean(
        outputCompaction.enabled,
        DEFAULT_PI_RTK_CONFIG.outputCompaction.enabled
      ),
      compactBash: normalizeBoolean(
        outputCompaction.compactBash,
        DEFAULT_PI_RTK_CONFIG.outputCompaction.compactBash
      ),
      compactGrep: normalizeBoolean(
        outputCompaction.compactGrep,
        DEFAULT_PI_RTK_CONFIG.outputCompaction.compactGrep
      ),
      compactRead: normalizeBoolean(
        outputCompaction.compactRead,
        DEFAULT_PI_RTK_CONFIG.outputCompaction.compactRead
      ),
      readSourceFilteringEnabled: normalizeBoolean(
        outputCompaction.readSourceFilteringEnabled,
        DEFAULT_PI_RTK_CONFIG.outputCompaction.readSourceFilteringEnabled
      ),
      maxLines: normalizeInteger(
        outputCompaction.maxLines,
        DEFAULT_PI_RTK_CONFIG.outputCompaction.maxLines,
        1
      ),
      maxChars: normalizeInteger(
        outputCompaction.maxChars,
        DEFAULT_PI_RTK_CONFIG.outputCompaction.maxChars,
        1
      ),
      trackSavings: normalizeBoolean(
        outputCompaction.trackSavings,
        DEFAULT_PI_RTK_CONFIG.outputCompaction.trackSavings
      ),
    },
  };
}

export function loadPiRtkConfig(cwd = process.cwd()): PiRtkConfig {
  const configPath = getPiRtkConfigPath(cwd);
  if (!existsSync(configPath)) {
    return cloneConfig(DEFAULT_PI_RTK_CONFIG);
  }

  try {
    const text = readFileSync(configPath, "utf8");
    return normalizePiRtkConfig(JSON.parse(text));
  } catch {
    return cloneConfig(DEFAULT_PI_RTK_CONFIG);
  }
}

export function savePiRtkConfig(cwd: string, config: PiRtkConfig): PiRtkConfig {
  const configPath = getPiRtkConfigPath(cwd);
  const normalized = normalizePiRtkConfig(config);
  const tempPath = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  renameSync(tempPath, configPath);

  return normalized;
}

export function resetPiRtkConfig(cwd: string): PiRtkConfig {
  return savePiRtkConfig(cwd, cloneConfig(DEFAULT_PI_RTK_CONFIG));
}
