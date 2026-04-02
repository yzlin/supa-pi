import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { parseSmartDocsArgs, type SmartDocsCommandInput } from "./parse";

const PROMPT = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt.md"),
    "utf8"
  )
  .trim();

const FLAG_COMPLETIONS: AutocompleteItem[] = [
  {
    value: "--out ",
    label: "--out",
    description: "Write docs to a custom output directory",
  },
  {
    value: "--update",
    label: "--update",
    description: "Prefer updating existing docs in place",
  },
  {
    value: "--overview-only",
    label: "--overview-only",
    description: "Generate overview docs only",
  },
  {
    value: "--deep-dive ",
    label: "--deep-dive",
    description: "Limit deep dives to comma-separated modules",
  },
  {
    value: "--dry-run",
    label: "--dry-run",
    description: "Analyze and propose docs without writing files",
  },
  {
    value: "--",
    label: "--",
    description: "Start freeform instruction text",
  },
];

const VALUE_FLAGS = new Set(["--out", "--deep-dive"]);

type CompletionState = {
  currentToken: string;
  precedingTokens: string[];
  hasInstructionSeparator: boolean;
  expectedValueFor: "--out" | "--deep-dive" | null;
  usedFlags: Set<string>;
  targetToken: string | null;
};

function splitCompletionTokens(argumentPrefix: string): {
  currentToken: string;
  precedingTokens: string[];
} {
  const hasTrailingSpace = /\s$/.test(argumentPrefix);
  const trimmed = argumentPrefix.trimStart();
  const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];

  if (hasTrailingSpace) {
    return { currentToken: "", precedingTokens: tokens };
  }

  return {
    currentToken: tokens.at(-1) ?? "",
    precedingTokens: tokens.slice(0, -1),
  };
}

function analyzeCompletionState(argumentPrefix: string): CompletionState {
  const { currentToken, precedingTokens } =
    splitCompletionTokens(argumentPrefix);
  const hasInstructionSeparator =
    precedingTokens.includes("--") || currentToken === "--";

  let expectedValueFor: "--out" | "--deep-dive" | null = null;
  let targetToken: string | null = null;
  const usedFlags = new Set<string>();

  for (const token of precedingTokens) {
    if (expectedValueFor) {
      expectedValueFor = null;
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      usedFlags.add(token);
      expectedValueFor = token;
      continue;
    }

    if (token.startsWith("--")) {
      usedFlags.add(token);
      continue;
    }

    if (!targetToken) {
      targetToken = token;
    }
  }

  if (!expectedValueFor && targetToken === null) {
    if (
      currentToken.length > 0 &&
      !currentToken.startsWith("--") &&
      currentToken !== "--"
    ) {
      targetToken = currentToken;
    }
  }

  return {
    currentToken,
    precedingTokens,
    hasInstructionSeparator,
    expectedValueFor,
    usedFlags,
    targetToken,
  };
}

function getAvailableFlags(usedFlags: Set<string>): AutocompleteItem[] {
  return FLAG_COMPLETIONS.filter((item) => {
    if (item.label === "--") return true;
    return !usedFlags.has(item.label);
  });
}

function completeFlagPrefix(
  currentToken: string,
  usedFlags: Set<string>
): AutocompleteItem[] | null {
  const matches = getAvailableFlags(usedFlags).filter((item) =>
    item.value.startsWith(currentToken)
  );
  return matches.length > 0 ? matches : null;
}

function resolvePathSearch(
  token: string,
  cwd: string
): {
  searchDir: string;
  valuePrefix: string;
  namePrefix: string;
} {
  if (token.length === 0) {
    return { searchDir: cwd, valuePrefix: "", namePrefix: "" };
  }

  const normalizedToken = token.replace(/\\/g, "/");
  const endsWithSlash = normalizedToken.endsWith("/");
  const lastSlashIndex = normalizedToken.lastIndexOf("/");

  const valuePrefix = endsWithSlash
    ? normalizedToken
    : lastSlashIndex >= 0
      ? normalizedToken.slice(0, lastSlashIndex + 1)
      : "";

  const namePrefix = endsWithSlash
    ? ""
    : lastSlashIndex >= 0
      ? normalizedToken.slice(lastSlashIndex + 1)
      : normalizedToken;

  const baseDir = valuePrefix.length > 0 ? valuePrefix : ".";
  const searchDir = path.resolve(cwd, baseDir);

  return { searchDir, valuePrefix, namePrefix };
}

function completeDirectories(
  token: string,
  cwd: string
): AutocompleteItem[] | null {
  const { searchDir, valuePrefix, namePrefix } = resolvePathSearch(token, cwd);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(searchDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const showHidden = namePrefix.startsWith(".") || valuePrefix.includes("/.");
  const items = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => (showHidden ? true : !entry.name.startsWith(".")))
    .filter((entry) => entry.name.startsWith(namePrefix))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 25)
    .map((entry) => {
      const value = `${valuePrefix}${entry.name}/`;
      return {
        value,
        label: value,
        description: "directory",
      } satisfies AutocompleteItem;
    });

  return items.length > 0 ? items : null;
}

export function getSmartDocsArgumentCompletions(
  argumentPrefix: string,
  cwd: string
): AutocompleteItem[] | null {
  const state = analyzeCompletionState(argumentPrefix);
  if (state.hasInstructionSeparator) {
    return null;
  }

  if (state.expectedValueFor === "--deep-dive") {
    return null;
  }

  if (state.expectedValueFor === "--out") {
    const parsedTarget = parseSmartDocsArgs(state.targetToken ?? "", cwd);
    const baseDir =
      parsedTarget.ok && state.targetToken
        ? parsedTarget.value.targetRoot
        : cwd;
    return completeDirectories(state.currentToken, baseDir);
  }

  if (state.currentToken.startsWith("--")) {
    return completeFlagPrefix(state.currentToken, state.usedFlags);
  }

  const pathItems = completeDirectories(state.currentToken, cwd) ?? [];

  if (state.targetToken && state.currentToken.length === 0) {
    const flagItems = getAvailableFlags(state.usedFlags);
    return flagItems.length > 0 ? flagItems : null;
  }

  if (state.targetToken && state.currentToken.length > 0) {
    return pathItems.length > 0 ? pathItems : null;
  }

  const flagItems =
    state.currentToken.length === 0 ? getAvailableFlags(state.usedFlags) : [];
  const merged = [...flagItems, ...pathItems];

  return merged.length > 0 ? merged : null;
}

export function buildSmartDocsMessage(input: SmartDocsCommandInput): string {
  const instruction =
    input.instruction ??
    "default comprehensive documentation for target codebase";
  const updateMode = input.update ? "update" : "auto";
  const deepDive =
    input.deepDive.length > 0
      ? input.deepDive.join(", ")
      : "all relevant modules";

  return [
    "Generate comprehensive codebase documentation.",
    "",
    "Resolved command input:",
    `- target root: ${input.targetRoot}`,
    `- target label: ${input.targetLabel}`,
    `- output dir: ${input.outputDir}`,
    `- instruction: ${instruction}`,
    `- update mode: ${updateMode}`,
    `- overview only: ${String(input.overviewOnly)}`,
    `- deep dive allowlist: ${deepDive}`,
    `- dry run: ${String(input.dryRun)}`,
    "",
    "Command rules:",
    "- The target root above is already resolved. Do not reinterpret it.",
    "- If dry run is true, inspect and propose docs to create or update, but do not write files.",
    "- If overview only is true, skip deep-dive docs unless the user explicitly asked for them.",
    "- If deep dive allowlist is present, limit deep-dive docs to those areas.",
    "- Prefer updating existing docs in place when update mode is update or when matching docs already exist.",
    "",
    PROMPT,
  ].join("\n");
}

export default function smartDocsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("smart-docs", {
    description: "Generate codebase docs for cwd or a target path",
    getArgumentCompletions(argumentPrefix) {
      return getSmartDocsArgumentCompletions(argumentPrefix, process.cwd());
    },
    handler: async (args, ctx) => {
      const parsed = parseSmartDocsArgs(args ?? "", process.cwd());
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }

      const message = buildSmartDocsMessage(parsed.value);

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /smart-docs as a follow-up", "info");
    },
  });
}
