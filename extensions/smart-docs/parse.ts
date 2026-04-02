import fs from "node:fs";
import path from "node:path";

export interface SmartDocsCommandInput {
  targetRoot: string;
  targetLabel: string;
  outputDir: string;
  instruction: string | null;
  update: boolean | null;
  overviewOnly: boolean;
  deepDive: string[];
  dryRun: boolean;
}

export type SmartDocsParseResult =
  | { ok: true; value: SmartDocsCommandInput }
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

export function parseSmartDocsArgs(
  rawArgs: string,
  cwd: string
): SmartDocsParseResult {
  const tokenized = tokenizeArgs(rawArgs);
  if (!tokenized.ok) {
    return tokenized;
  }

  const { beforeTokens, instruction } = splitInstruction(
    rawArgs,
    tokenized.tokens
  );

  let targetLabel: string | null = null;
  let outputArg: string | null = null;
  let update: boolean | null = null;
  let overviewOnly = false;
  let dryRun = false;
  let deepDive: string[] = [];

  for (let index = 0; index < beforeTokens.length; index += 1) {
    const token = beforeTokens[index]?.value ?? "";

    if (!token.startsWith("--")) {
      if (targetLabel) {
        return {
          ok: false,
          error:
            "Ambiguous arguments. Use '/smart-docs <target> -- <instruction>' to pass freeform instructions.",
        };
      }

      targetLabel = token;
      continue;
    }

    if (token === "--update") {
      update = true;
      continue;
    }

    if (token === "--overview-only") {
      overviewOnly = true;
      continue;
    }

    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (token === "--out" || token === "--deep-dive") {
      const nextToken = beforeTokens[index + 1]?.value;
      if (!nextToken) {
        return {
          ok: false,
          error: `${token} requires a value.`,
        };
      }

      if (token === "--out") {
        outputArg = nextToken;
      } else {
        const rawEntries = nextToken.split(",").map((value) => value.trim());
        if (rawEntries.some((value) => value.length === 0)) {
          return {
            ok: false,
            error:
              "Invalid --deep-dive value. Use comma-separated non-empty names.",
          };
        }

        deepDive = rawEntries.filter(Boolean);
        if (deepDive.length === 0) {
          return {
            ok: false,
            error:
              "Invalid --deep-dive value. Use comma-separated non-empty names.",
          };
        }
      }

      index += 1;
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

  const outputDir = outputArg
    ? path.isAbsolute(outputArg)
      ? path.normalize(outputArg)
      : path.resolve(targetRoot, outputArg)
    : path.join(targetRoot, "docs");

  return {
    ok: true,
    value: {
      targetRoot,
      targetLabel: resolvedTargetLabel,
      outputDir,
      instruction,
      update,
      overviewOnly,
      deepDive,
      dryRun,
    },
  };
}
