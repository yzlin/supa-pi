import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { parseInitDeepArgs, type InitDeepCommandInput } from "./parse";

const PROMPT = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt.md"),
    "utf8"
  )
  .trim();

const FLAG_COMPLETIONS: AutocompleteItem[] = [
  {
    value: "--create-new",
    label: "--create-new",
    description: "Regenerate AGENTS.md files from scratch",
  },
  {
    value: "--max-depth ",
    label: "--max-depth",
    description: "Limit nested AGENTS.md generation depth",
  },
  {
    value: "--dry-run",
    label: "--dry-run",
    description: "Analyze and propose changes without writing",
  },
  {
    value: "--",
    label: "--",
    description: "Start freeform instruction text",
  },
];

const DEPTH_COMPLETIONS: AutocompleteItem[] = [1, 2, 3, 4, 5, 6].map(
  (value) => ({
    value: String(value),
    label: String(value),
    description: `max depth ${value}`,
  })
);

const VALUE_FLAGS = new Set(["--max-depth"]);

type CompletionState = {
  currentToken: string;
  precedingTokens: string[];
  hasInstructionSeparator: boolean;
  expectedValueFor: "--max-depth" | null;
  usedFlags: Set<string>;
  targetToken: string | null;
  targetCommitted: boolean;
};

function splitCompletionTokens(argumentPrefix: string): {
  currentToken: string;
  precedingTokens: string[];
} {
  const hasTrailingSpace = /\s$/.test(argumentPrefix);
  const trimmed = argumentPrefix.trim();
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

  let expectedValueFor: "--max-depth" | null = null;
  let targetToken: string | null = null;
  let targetCommitted = false;
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

    if (token.startsWith("--max-depth=")) {
      usedFlags.add("--max-depth");
      continue;
    }

    if (token.startsWith("--")) {
      usedFlags.add(token);
      continue;
    }

    if (!targetToken) {
      targetToken = token;
      targetCommitted = true;
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
    targetCommitted,
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

function completeDepthValues(currentToken: string): AutocompleteItem[] | null {
  const matches = DEPTH_COMPLETIONS.filter((item) =>
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

export function getInitDeepArgumentCompletions(
  argumentPrefix: string,
  cwd: string
): AutocompleteItem[] | null {
  const state = analyzeCompletionState(argumentPrefix);
  if (state.hasInstructionSeparator) {
    return null;
  }

  if (state.expectedValueFor === "--max-depth") {
    return completeDepthValues(state.currentToken);
  }

  if (state.currentToken.startsWith("--max-depth=")) {
    return completeDepthValues(state.currentToken.slice("--max-depth=".length));
  }

  if (state.currentToken.startsWith("--")) {
    return completeFlagPrefix(state.currentToken, state.usedFlags);
  }

  const pathItems = completeDirectories(state.currentToken, cwd) ?? [];

  if (state.targetCommitted && state.currentToken.length === 0) {
    const flagItems = getAvailableFlags(state.usedFlags);
    return flagItems.length > 0 ? flagItems : null;
  }

  if (state.targetCommitted && state.currentToken.length > 0) {
    return null;
  }

  const flagItems =
    state.currentToken.length === 0 ? getAvailableFlags(state.usedFlags) : [];
  const merged = [...flagItems, ...pathItems];

  return merged.length > 0 ? merged : null;
}

export function buildInitDeepMessage(input: InitDeepCommandInput): string {
  const instruction =
    input.instruction ??
    "default hierarchical AGENTS.md generation for the target codebase";
  const mode = input.createNew ? "create-new" : "update";

  return [
    "Generate hierarchical AGENTS.md files for the resolved target codebase.",
    "",
    "Resolved command input:",
    `- target root: ${input.targetRoot}`,
    `- target label: ${input.targetLabel}`,
    `- mode: ${mode}`,
    `- max depth: ${input.maxDepth}`,
    `- dry run: ${String(input.dryRun)}`,
    `- instruction: ${instruction}`,
    "",
    "Command rules:",
    "- The target root above is already resolved. Do not reinterpret it.",
    "- Keep reads, writes, edits, and deletes scoped to that target root.",
    "- The max depth above is a hard limit.",
    "- If create-new is true, read existing AGENTS.md files in scope first, then remove them with `trash` before regenerating.",
    "- If dry run is true, inspect and propose changes only. Do not write, edit, or delete files.",
    "- Use TaskCreate and TaskUpdate for phase tracking.",
    "",
    PROMPT,
  ].join("\n");
}

export default function initDeepExtension(pi: ExtensionAPI): void {
  pi.registerCommand("init-deep", {
    description:
      "Generate hierarchical AGENTS.md files for cwd or a target path",
    getArgumentCompletions(argumentPrefix) {
      return getInitDeepArgumentCompletions(argumentPrefix, process.cwd());
    },
    handler: async (args, ctx) => {
      const parsed = parseInitDeepArgs(args ?? "", process.cwd());
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }

      const message = buildInitDeepMessage(parsed.value);

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /init-deep as a follow-up", "info");
    },
  });
}
