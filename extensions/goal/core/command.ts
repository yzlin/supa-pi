import type { GoalCommandAction, GoalMode, Result } from "./types";

export interface GoalCommandInput {
  action: GoalCommandAction;
  mode: GoalMode;
  objective: string;
  normalizedObjective: string;
  resume: boolean;
  checkpoint: string | null;
  taskBudget: number | null;
  maxAttemptsPerTask: number;
  dryRun: boolean;
}

interface Token {
  value: string;
}

const WHITESPACE = /\s/;
const POSITIVE_INTEGER = /^\d+$/;
const OBJECTIVE_WHITESPACE = /\s+/g;
const DEFAULT_MAX_ATTEMPTS = 2;
const ACTIONS = new Set<GoalCommandAction>([
  "resume",
  "status",
  "pause",
  "clear",
  "statusbar",
]);

function tokenize(rawArgs: string): Result<Token[]> {
  const tokens: Token[] = [];
  let index = 0;

  while (index < rawArgs.length) {
    while (WHITESPACE.test(rawArgs[index] ?? "")) {
      index += 1;
    }
    if (index >= rawArgs.length) {
      break;
    }

    let value = "";
    let quote: "'" | '"' | null = null;

    while (index < rawArgs.length) {
      const char = rawArgs[index] ?? "";
      if (quote) {
        if (char === "\\" && rawArgs[index + 1] !== undefined) {
          value += rawArgs[index + 1];
          index += 2;
          continue;
        }
        if (char === quote) {
          quote = null;
          index += 1;
          continue;
        }
        value += char;
        index += 1;
        continue;
      }
      if (WHITESPACE.test(char)) {
        break;
      }
      if (char === "'" || char === '"') {
        quote = char;
        index += 1;
        continue;
      }
      if (char === "\\" && rawArgs[index + 1] !== undefined) {
        value += rawArgs[index + 1];
        index += 2;
        continue;
      }
      value += char;
      index += 1;
    }

    if (quote) {
      return { ok: false, error: "Unterminated quoted argument." };
    }
    tokens.push({ value });
  }

  return { ok: true, value: tokens };
}

function parsePositiveInteger(value: string, flag: string): Result<number> {
  if (!POSITIVE_INTEGER.test(value)) {
    return {
      ok: false,
      error: `Invalid ${flag} value: ${value}. Use a positive integer.`,
    };
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      error: `Invalid ${flag} value: ${value}. Use a positive integer.`,
    };
  }
  return { ok: true, value: parsed };
}

function normalizeObjective(objective: string): string {
  return objective.replace(OBJECTIVE_WHITESPACE, " ").trim();
}

export function parseGoalCommand(rawArgs: string): Result<GoalCommandInput> {
  const tokenized = tokenize(rawArgs);
  if (!tokenized.ok) {
    return tokenized;
  }

  const tokens = tokenized.value.map((token) => token.value);
  let action: GoalCommandAction = "start";
  let mode: GoalMode = "classic";
  let resume = false;
  let checkpoint: string | null = null;
  let taskBudget: number | null = null;
  let maxAttemptsPerTask = DEFAULT_MAX_ATTEMPTS;
  let dryRun = false;
  const objectiveParts: string[] = [];

  let index = 0;
  const first = tokens[0];
  if (first === "task") {
    mode = "task";
    index = 1;
  } else if (first && ACTIONS.has(first as GoalCommandAction)) {
    action = first as GoalCommandAction;
    resume = action === "resume";
    index = 1;
  }

  for (; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";

    if (token === "--resume") {
      action = "resume";
      resume = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--checkpoint") {
      const next = tokens[index + 1];
      if (!next) {
        return { ok: false, error: "--checkpoint requires a value." };
      }
      checkpoint = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--checkpoint=")) {
      checkpoint = token.slice("--checkpoint=".length);
      if (!checkpoint) {
        return { ok: false, error: "--checkpoint requires a value." };
      }
      continue;
    }
    if (token === "--tasks" || token === "--max-attempts-per-task") {
      const next = tokens[index + 1];
      if (!next) {
        return { ok: false, error: `${token} requires a value.` };
      }
      const parsed = parsePositiveInteger(next, token);
      if (!parsed.ok) {
        return parsed;
      }
      if (token === "--tasks") {
        taskBudget = parsed.value;
      } else {
        maxAttemptsPerTask = parsed.value;
      }
      index += 1;
      continue;
    }
    if (
      token.startsWith("--tasks=") ||
      token.startsWith("--max-attempts-per-task=")
    ) {
      const [flag = "", value = ""] = token.split("=", 2);
      const parsed = parsePositiveInteger(value, flag);
      if (!parsed.ok) {
        return parsed;
      }
      if (flag === "--tasks") {
        taskBudget = parsed.value;
      } else {
        maxAttemptsPerTask = parsed.value;
      }
      continue;
    }
    if (token === "--max-tasks" || token.startsWith("--max-tasks=")) {
      return { ok: false, error: "Use --tasks for /goal task budget." };
    }
    if (token.startsWith("--")) {
      return { ok: false, error: `Unknown flag: ${token}` };
    }
    objectiveParts.push(token);
  }

  const objective = objectiveParts.join(" ").trim();
  const normalizedObjective = normalizeObjective(objective);
  if (mode === "task" && action === "start" && taskBudget === null) {
    return { ok: false, error: "/goal task requires --tasks N." };
  }
  if (action === "start" && normalizedObjective.length === 0) {
    return { ok: false, error: "Goal objective is required." };
  }

  return {
    ok: true,
    value: {
      action,
      mode,
      objective,
      normalizedObjective,
      resume,
      checkpoint,
      taskBudget,
      maxAttemptsPerTask,
      dryRun,
    },
  };
}
