import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AutoRenameConfig {
  enabled: boolean;
  prompt: string;
  maxQueryLength: number;
  maxNameLength: number;
  timeoutMs: number;
  debug: boolean;
}

export interface ValidAutoRenameConfigState {
  valid: true;
  source: "defaults" | "file";
  config: AutoRenameConfig;
}

export interface InvalidAutoRenameConfigState {
  valid: false;
  source: "invalid";
  config: AutoRenameConfig;
  error: string;
}

export type AutoRenameConfigState =
  | ValidAutoRenameConfigState
  | InvalidAutoRenameConfigState;

export const AUTO_RENAME_CONFIG_LIMITS = {
  prompt: { min: 1, max: 1000 },
  maxQueryLength: { min: 100, max: 20_000 },
  maxNameLength: { min: 12, max: 200 },
  timeoutMs: { min: 100, max: 60_000 },
} as const;

export const DEFAULT_AUTO_RENAME_CONFIG: Readonly<AutoRenameConfig> =
  Object.freeze({
    enabled: true,
    prompt:
      "Generate a concise 3–6 word plain Title Case session title for the user's request. Return only the title.",
    maxQueryLength: 2000,
    maxNameLength: 80,
    timeoutMs: 10_000,
    debug: false,
  });

const CONFIG_KEYS = new Set<keyof AutoRenameConfig>([
  "enabled",
  "prompt",
  "maxQueryLength",
  "maxNameLength",
  "timeoutMs",
  "debug",
]);

function invalidConfig(error: string): InvalidAutoRenameConfigState {
  return {
    valid: false,
    source: "invalid",
    config: { ...DEFAULT_AUTO_RENAME_CONFIG, enabled: false },
    error,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIntegerInRange(
  value: unknown,
  range: { readonly min: number; readonly max: number }
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

export function getAutoRenameConfigPath(
  homeDir = process.env.HOME ?? homedir()
): string {
  return join(homeDir, ".pi", "agent", "auto-rename.json");
}

export function validateAutoRenameConfig(
  input: unknown
): AutoRenameConfigState {
  if (!isPlainObject(input)) {
    return invalidConfig("Configuration must be a JSON object.");
  }

  const unknownKey = Object.keys(input).find(
    (key) => !CONFIG_KEYS.has(key as keyof AutoRenameConfig)
  );
  if (unknownKey !== undefined) {
    return invalidConfig(`Unknown configuration key: ${unknownKey}.`);
  }

  if ("enabled" in input && typeof input.enabled !== "boolean") {
    return invalidConfig("enabled must be a boolean.");
  }
  if (
    "prompt" in input &&
    (typeof input.prompt !== "string" ||
      input.prompt.trim().length < AUTO_RENAME_CONFIG_LIMITS.prompt.min ||
      input.prompt.length > AUTO_RENAME_CONFIG_LIMITS.prompt.max)
  ) {
    return invalidConfig(
      `prompt must be non-empty and at most ${AUTO_RENAME_CONFIG_LIMITS.prompt.max} characters.`
    );
  }
  if (
    "maxQueryLength" in input &&
    !isIntegerInRange(
      input.maxQueryLength,
      AUTO_RENAME_CONFIG_LIMITS.maxQueryLength
    )
  ) {
    return invalidConfig("maxQueryLength must be an integer within its range.");
  }
  if (
    "maxNameLength" in input &&
    !isIntegerInRange(
      input.maxNameLength,
      AUTO_RENAME_CONFIG_LIMITS.maxNameLength
    )
  ) {
    return invalidConfig("maxNameLength must be an integer within its range.");
  }
  if (
    "timeoutMs" in input &&
    !isIntegerInRange(input.timeoutMs, AUTO_RENAME_CONFIG_LIMITS.timeoutMs)
  ) {
    return invalidConfig("timeoutMs must be an integer within its range.");
  }
  if ("debug" in input && typeof input.debug !== "boolean") {
    return invalidConfig("debug must be a boolean.");
  }

  return {
    valid: true,
    source: "file",
    config: { ...DEFAULT_AUTO_RENAME_CONFIG, ...input } as AutoRenameConfig,
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}

export function loadAutoRenameConfig(
  homeDir = process.env.HOME ?? homedir()
): AutoRenameConfigState {
  const configPath = getAutoRenameConfigPath(homeDir);
  let contents: string;

  try {
    contents = readFileSync(configPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        valid: true,
        source: "defaults",
        config: { ...DEFAULT_AUTO_RENAME_CONFIG },
      };
    }
    return invalidConfig("Unable to read auto-rename configuration.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return invalidConfig("Auto-rename configuration contains malformed JSON.");
  }

  return validateAutoRenameConfig(parsed);
}
