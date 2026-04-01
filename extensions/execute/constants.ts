import { readFileSync } from "node:fs";

export const COMMAND_NAME = "execute-wave";
export const EXECUTE_COMMAND_NAME = "execute";
export const EXECUTE_AGENT = "execute-step";
export const EXECUTE_PROMPT = readFileSync(
  new URL("./prompt.md", import.meta.url),
  "utf8"
).trim();
export const TASK_TEMPLATE = [
  "Assigned atomic repo task:",
  "{item}",
  "",
  "Batch position: {index}/{total}.",
  "Complete only this assigned task.",
].join("\n");
export const MAX_WAVE_ITEMS = 25;
export const MAX_WAVES = 10;
export const DEFAULT_MAX_ATTEMPTS = 1;
export const READ_ONLY_CONCURRENCY = 2;
export const WRITE_HEAVY_CONCURRENCY = 1;
export const EXECUTE_TASK_RPC_TIMEOUT_MS = 1_000;
export const EXECUTE_TASK_SOURCE = "execute";
export const EXECUTE_ROOT_SUBJECT = "Execute plan";
export const EXECUTE_ROOT_ACTIVE_FORM = "Executing plan";
export const RISKY_STEP_PATTERN =
  /\b(add|change|create|delete|edit|fix|implement|migrate|move|refactor|remove|rename|replace|update|write)\b/i;
export const PLAN_REFERENCE_PREFIX = "@";
export const FILE_BACKED_PLAN_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
]);
export const EXECUTE_PROGRESS_WIDGET_HISTORY_LIMIT = 8;
export const EXECUTE_PROGRESS_DETAIL_PREVIEW_LENGTH = 96;
export const EXECUTE_PROGRESS_DETAIL_FULL_LENGTH = 4_000;

let executeWidgetCounter = 0;

export const nextExecuteWidgetKey = (): string => `execute-${++executeWidgetCounter}`;
