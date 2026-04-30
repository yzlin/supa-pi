import fs from "node:fs";
import path from "node:path";

export type ContextDocsCommand =
  | "context-setup"
  | "context-note"
  | "adr"
  | "context-review"
  | "context-grill";

export type ContextDocsWorkflow = "setup" | "note" | "adr" | "review" | "grill";

export interface ContextDocsCommandInput {
  command: ContextDocsCommand;
  workflow: ContextDocsWorkflow;
  targetRoot: string;
  targetLabel: string;
  instruction: string | null;
  options: {
    dryRun?: boolean;
    force?: boolean;
    title?: string;
    tags?: string[];
    status?: string;
    scope?: string;
    topic?: string;
    depth?: string;
  };
}

export type ContextDocsParseResult =
  | { ok: true; value: ContextDocsCommandInput }
  | { ok: false; error: string };

interface Token {
  value: string;
  start: number;
  end: number;
}

const WORKFLOWS: Record<ContextDocsCommand, ContextDocsWorkflow> = {
  "context-setup": "setup",
  "context-note": "note",
  adr: "adr",
  "context-review": "review",
  "context-grill": "grill",
};

const ALLOWED_FLAGS: Record<ContextDocsCommand, Set<string>> = {
  "context-setup": new Set(["--dry-run", "--force"]),
  "context-note": new Set(["--title", "--tags"]),
  adr: new Set(["--title", "--status"]),
  "context-review": new Set(["--dry-run", "--scope"]),
  "context-grill": new Set(["--topic", "--depth"]),
};

const VALUE_FLAGS = new Set([
  "--title",
  "--tags",
  "--status",
  "--scope",
  "--topic",
  "--depth",
]);

const ADR_STATUSES = new Set([
  "proposed",
  "accepted",
  "superseded",
  "deprecated",
  "rejected",
]);
const REVIEW_SCOPES = new Set(["current", "all"]);
const GRILL_DEPTHS = new Set(["light", "standard", "deep"]);

function tokenizeArgs(
  rawArgs: string
): { ok: true; tokens: Token[] } | { ok: false; error: string } {
  const tokens: Token[] = [];
  let index = 0;

  while (index < rawArgs.length) {
    while (index < rawArgs.length && /\s/.test(rawArgs[index] ?? "")) {
      index += 1;
    }

    if (index >= rawArgs.length) break;

    const start = index;
    let value = "";
    let quote: '"' | "'" | null = null;

    while (index < rawArgs.length) {
      const char = rawArgs[index] ?? "";

      if (quote) {
        if (char === "\\") {
          const next = rawArgs[index + 1];
          if (next !== undefined) {
            value += next;
            index += 2;
            continue;
          }
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

      if (/\s/.test(char)) break;

      if (char === '"' || char === "'") {
        quote = char;
        index += 1;
        continue;
      }

      if (char === "\\") {
        const next = rawArgs[index + 1];
        if (next !== undefined) {
          value += next;
          index += 2;
          continue;
        }
      }

      value += char;
      index += 1;
    }

    if (quote) {
      return { ok: false, error: "Unterminated quoted argument." };
    }

    tokens.push({ value, start, end: index });
  }

  return { ok: true, tokens };
}

function splitInstruction(
  rawArgs: string,
  tokens: Token[]
): {
  beforeTokens: Token[];
  instruction: string | null;
} {
  const separator = tokens.find((token) => token.value === "--");
  if (!separator) {
    return { beforeTokens: tokens, instruction: null };
  }

  const beforeTokens = tokens.filter((token) => token.start < separator.start);
  const instruction = rawArgs.slice(separator.end).trim();

  return {
    beforeTokens,
    instruction: instruction.length > 0 ? instruction : null,
  };
}

function requireAllowedFlag(
  command: ContextDocsCommand,
  flag: string
): { ok: true } | { ok: false; error: string } {
  if (!ALLOWED_FLAGS[command].has(flag)) {
    return { ok: false, error: `Unknown flag for /${command}: ${flag}` };
  }

  return { ok: true };
}

function assignOption(
  input: ContextDocsCommandInput,
  flag: string,
  value: string | true
): { ok: true } | { ok: false; error: string } {
  switch (flag) {
    case "--dry-run":
      input.options.dryRun = true;
      return { ok: true };
    case "--force":
      input.options.force = true;
      return { ok: true };
  }

  if (value === true) {
    return { ok: false, error: `${flag} requires a value.` };
  }

  switch (flag) {
    case "--title":
      input.options.title = value;
      return { ok: true };
    case "--tags": {
      const tags = value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      if (tags.length === 0) {
        return { ok: false, error: "--tags requires comma-separated names." };
      }
      input.options.tags = tags;
      return { ok: true };
    }
    case "--status":
      if (!ADR_STATUSES.has(value)) {
        return {
          ok: false,
          error:
            "--status must be one of: proposed, accepted, superseded, deprecated, rejected.",
        };
      }
      input.options.status = value;
      return { ok: true };
    case "--scope":
      if (!REVIEW_SCOPES.has(value)) {
        return { ok: false, error: "--scope must be one of: current, all." };
      }
      input.options.scope = value;
      return { ok: true };
    case "--topic":
      input.options.topic = value;
      return { ok: true };
    case "--depth":
      if (!GRILL_DEPTHS.has(value)) {
        return {
          ok: false,
          error: "--depth must be one of: light, standard, deep.",
        };
      }
      input.options.depth = value;
      return { ok: true };
    default:
      return { ok: false, error: `Unknown flag: ${flag}` };
  }
}

function requiresInstruction(command: ContextDocsCommand): boolean {
  return command === "context-note" || command === "adr";
}

export function parseContextDocsArgs(
  command: ContextDocsCommand,
  rawArgs: string,
  cwd: string
): ContextDocsParseResult {
  const tokenized = tokenizeArgs(rawArgs);
  if (!tokenized.ok) {
    return tokenized;
  }

  const { beforeTokens, instruction } = splitInstruction(
    rawArgs,
    tokenized.tokens
  );

  let targetLabel: string | null = null;
  const input: ContextDocsCommandInput = {
    command,
    workflow: WORKFLOWS[command],
    targetRoot: cwd,
    targetLabel: ".",
    instruction,
    options: {},
  };

  for (let index = 0; index < beforeTokens.length; index += 1) {
    const token = beforeTokens[index]?.value ?? "";

    if (!token.startsWith("--")) {
      if (targetLabel) {
        return {
          ok: false,
          error: `Ambiguous arguments. Use '/${command} <target> -- <instruction>' for freeform text.`,
        };
      }
      targetLabel = token;
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : null;

    const allowed = requireAllowedFlag(command, flag);
    if (!allowed.ok) {
      return allowed;
    }

    if (VALUE_FLAGS.has(flag)) {
      const value = inlineValue ?? beforeTokens[index + 1]?.value;
      if (!value) {
        return { ok: false, error: `${flag} requires a value.` };
      }

      const assigned = assignOption(input, flag, value);
      if (!assigned.ok) {
        return assigned;
      }

      if (inlineValue === null) {
        index += 1;
      }
      continue;
    }

    if (inlineValue !== null) {
      return { ok: false, error: `${flag} does not accept a value.` };
    }

    const assigned = assignOption(input, flag, true);
    if (!assigned.ok) {
      return assigned;
    }
  }

  if (requiresInstruction(command) && !instruction) {
    return {
      ok: false,
      error: `/${command} requires note text after '--'.`,
    };
  }

  const resolvedTargetLabel = targetLabel ?? ".";
  const targetRoot = path.resolve(cwd, resolvedTargetLabel);

  if (!fs.existsSync(targetRoot)) {
    return {
      ok: false,
      error: `Target path does not exist: ${resolvedTargetLabel}`,
    };
  }

  try {
    if (!fs.statSync(targetRoot).isDirectory()) {
      return {
        ok: false,
        error: `Target path is not a directory: ${resolvedTargetLabel}`,
      };
    }

    const cwdRoot = fs.realpathSync(cwd);
    const realTargetRoot = fs.realpathSync(targetRoot);
    const insideCwd =
      realTargetRoot === cwdRoot ||
      realTargetRoot.startsWith(`${cwdRoot}${path.sep}`);

    if (!insideCwd) {
      return {
        ok: false,
        error: `Target path must stay inside current project: ${resolvedTargetLabel}`,
      };
    }

    return {
      ok: true,
      value: {
        ...input,
        targetRoot: realTargetRoot,
        targetLabel: resolvedTargetLabel,
      },
    };
  } catch {
    return {
      ok: false,
      error: `Unable to inspect target path: ${resolvedTargetLabel}`,
    };
  }
}
