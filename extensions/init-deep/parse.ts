import fs from "node:fs";
import path from "node:path";

export interface InitDeepCommandInput {
  targetRoot: string;
  targetLabel: string;
  instruction: string | null;
  createNew: boolean;
  maxDepth: number;
  dryRun: boolean;
}

export type InitDeepParseResult =
  | { ok: true; value: InitDeepCommandInput }
  | { ok: false; error: string };

interface Token {
  value: string;
  start: number;
  end: number;
}

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

function parsePositiveInteger(
  value: string,
  flagName: string
): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d+$/.test(value)) {
    return {
      ok: false,
      error: `Invalid ${flagName} value: ${value}. Use a positive integer.`,
    };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      error: `Invalid ${flagName} value: ${value}. Use a positive integer.`,
    };
  }

  return { ok: true, value: parsed };
}

export function parseInitDeepArgs(
  rawArgs: string,
  cwd: string
): InitDeepParseResult {
  const tokenized = tokenizeArgs(rawArgs);
  if (!tokenized.ok) {
    return tokenized;
  }

  const { beforeTokens, instruction } = splitInstruction(
    rawArgs,
    tokenized.tokens
  );

  let targetLabel: string | null = null;
  let createNew = false;
  let maxDepth = 3;
  let dryRun = false;

  for (let index = 0; index < beforeTokens.length; index += 1) {
    const token = beforeTokens[index]?.value ?? "";

    if (!token.startsWith("--")) {
      if (targetLabel) {
        return {
          ok: false,
          error:
            "Ambiguous arguments. Use '/init-deep <target> -- <instruction>' to pass freeform instructions.",
        };
      }

      targetLabel = token;
      continue;
    }

    if (token === "--create-new") {
      createNew = true;
      continue;
    }

    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (token === "--max-depth") {
      const nextToken = beforeTokens[index + 1]?.value;
      if (!nextToken) {
        return {
          ok: false,
          error: "--max-depth requires a value.",
        };
      }

      const parsedDepth = parsePositiveInteger(nextToken, "--max-depth");
      if (!parsedDepth.ok) {
        return parsedDepth;
      }

      maxDepth = parsedDepth.value;
      index += 1;
      continue;
    }

    if (token.startsWith("--max-depth=")) {
      const rawValue = token.slice("--max-depth=".length);
      const parsedDepth = parsePositiveInteger(rawValue, "--max-depth");
      if (!parsedDepth.ok) {
        return parsedDepth;
      }

      maxDepth = parsedDepth.value;
      continue;
    }

    return {
      ok: false,
      error: `Unknown flag: ${token}`,
    };
  }

  const resolvedTargetLabel = targetLabel ?? ".";
  const targetRoot = path.resolve(cwd, targetLabel ?? ".");

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
  } catch {
    return {
      ok: false,
      error: `Unable to inspect target path: ${resolvedTargetLabel}`,
    };
  }

  return {
    ok: true,
    value: {
      targetRoot,
      targetLabel: resolvedTargetLabel,
      instruction,
      createNew,
      maxDepth,
      dryRun,
    },
  };
}
