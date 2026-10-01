import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const WHITESPACE = /\s/;
export const MODEL_PATTERN = /^[^/\s]+\/[^\s]+$/;
export interface Values {
  model?: string;
  thinking?: ThinkingLevel;
}
export interface Profile {
  main?: Values;
  agents?: Record<string, Values>;
}
export interface Config {
  active?: string;
  // Main choices captured before a profile first changed them; `default` restores them.
  defaultMain?: Values;
  profiles: Record<string, Profile>;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseConfig(
  raw: unknown,
  path: string,
  validate?: (raw: Record<string, unknown>) => string[],
): Config {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    throw new Error(`${path}: config must be an object`);
  }
  function values(value: unknown, field: string): void {
    if (!isRecord(value)) {
      errors.push(`${field}: expected object`);
      return;
    }
    for (const key of Object.keys(value)) {
      if (key !== "model" && key !== "thinking") {
        errors.push(`${field}.${key}: unknown field`);
      }
    }
    if (
      "model" in value &&
      (typeof value.model !== "string" || !MODEL_PATTERN.test(value.model))
    ) {
      errors.push(`${field}.model: expected provider/id`);
    }
    if (
      "thinking" in value &&
      !THINKING_LEVELS.some((level) => level === value.thinking)
    ) {
      errors.push(`${field}.thinking: expected ${THINKING_LEVELS.join(", ")}`);
    }
  }
  if ("$schema" in raw && typeof raw.$schema !== "string") {
    errors.push("$schema: expected string");
  }
  if ("active" in raw && (typeof raw.active !== "string" || !raw.active)) {
    errors.push("active: expected profile name");
  }
  if ("defaultMain" in raw) {
    values(raw.defaultMain, "defaultMain");
  }
  if (isRecord(raw.profiles)) {
    for (const [name, profile] of Object.entries(raw.profiles)) {
      const field = `profiles.${name}`;
      if (name === "default" || !name || WHITESPACE.test(name)) {
        errors.push(`${field}: invalid or reserved profile name`);
      }
      if (!isRecord(profile)) {
        errors.push(`${field}: expected object`);
        continue;
      }
      for (const key of Object.keys(profile)) {
        if (key !== "main" && key !== "agents") {
          errors.push(`${field}.${key}: unknown field`);
        }
      }
      if ("main" in profile) {
        values(profile.main, `${field}.main`);
      }
      if ("agents" in profile) {
        if (isRecord(profile.agents)) {
          for (const [agent, overrides] of Object.entries(profile.agents)) {
            values(overrides, `${field}.agents.${agent}`);
          }
        } else {
          errors.push(`${field}.agents: expected object`);
        }
      }
    }
    if (
      typeof raw.active === "string" &&
      raw.active !== "default" &&
      !Object.hasOwn(raw.profiles, raw.active)
    ) {
      errors.push(`active: unknown profile ${raw.active}`);
    }
  } else {
    errors.push("profiles: expected object");
  }
  if (validate) {
    errors.push(...validate(raw));
  }
  if (errors.length) {
    throw new Error(`${path}:\n${errors.join("\n")}`);
  }
  return raw as Config;
}

export function loadConfig(
  path: string,
  validate?: (raw: Record<string, unknown>) => string[],
): Config | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw new Error(`${path}: ${String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${String(error)})`);
  }
  return parseConfig(raw, path, validate);
}

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function writeConfig(path: string, config: Config): void {
  parseConfig(config, path);
  atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
}
