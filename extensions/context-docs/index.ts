import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import {
  type ContextDocsCommand,
  type ContextDocsCommandInput,
  parseContextDocsArgs,
} from "./parse";
import { detectSecret } from "./secrets";

const PROMPT = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt.md"),
    "utf8"
  )
  .trim();

const COMMANDS: Array<{
  name: ContextDocsCommand;
  description: string;
}> = [
  {
    name: "context-setup",
    description: "Create or update durable project context docs",
  },
  {
    name: "context-note",
    description: "Capture an implementation note in project context docs",
  },
  {
    name: "adr",
    description: "Create an Architecture Decision Record",
  },
  {
    name: "context-review",
    description: "Review context docs for gaps, drift, and stale decisions",
  },
  {
    name: "context-grill",
    description: "Stress-test and clarify project context through questions",
  },
];

const FLAG_COMPLETIONS: Record<ContextDocsCommand, AutocompleteItem[]> = {
  "context-setup": [
    { value: "--dry-run", label: "--dry-run", description: "Plan only" },
    {
      value: "--force",
      label: "--force",
      description: "Allow broader scaffold updates",
    },
    { value: "--", label: "--", description: "Start instruction text" },
  ],
  "context-note": [
    { value: "--title ", label: "--title", description: "Set note title" },
    {
      value: "--tags ",
      label: "--tags",
      description: "Comma-separated note tags",
    },
    { value: "--", label: "--", description: "Start note text" },
  ],
  adr: [
    { value: "--title ", label: "--title", description: "Set ADR title" },
    {
      value: "--status ",
      label: "--status",
      description: "Set ADR status",
    },
    { value: "--", label: "--", description: "Start decision text" },
  ],
  "context-review": [
    {
      value: "--dry-run",
      label: "--dry-run",
      description: "Do not write fixes",
    },
    {
      value: "--scope ",
      label: "--scope",
      description: "Review current docs or all docs",
    },
    { value: "--", label: "--", description: "Start review focus" },
  ],
  "context-grill": [
    {
      value: "--topic ",
      label: "--topic",
      description: "Topic to stress-test",
    },
    {
      value: "--depth ",
      label: "--depth",
      description: "Questioning depth",
    },
    { value: "--", label: "--", description: "Start goal text" },
  ],
};

const VALUE_COMPLETIONS: Record<string, AutocompleteItem[]> = {
  "--status": [
    "proposed",
    "accepted",
    "superseded",
    "deprecated",
    "rejected",
  ].map((value) => ({ value, label: value })),
  "--scope": ["current", "all"].map((value) => ({ value, label: value })),
  "--depth": ["light", "standard", "deep"].map((value) => ({
    value,
    label: value,
  })),
};

const VALUE_FLAGS = new Set([
  "--title",
  "--tags",
  "--status",
  "--scope",
  "--topic",
  "--depth",
]);

const DEFAULT_INSTRUCTIONS: Record<ContextDocsCommand, string> = {
  "context-setup": "set up or refresh the project context documentation",
  "context-note": "capture the provided note in project context documentation",
  adr: "record the provided architectural decision",
  "context-review": "review the project context documentation",
  "context-grill": "ask focused questions until project context is clear",
};

type NaturalLanguageMatch = {
  command: ContextDocsCommand;
  instruction: string;
};

const CONTEXT_DOCS_REMINDER =
  "Context-docs: keep durable docs scoped; CONTEXT.md domain/product only; AGENTS.md agent conventions; ADRs tradeoff decisions; CONTEXT-MAP real boundaries; no pi-tasks.";
const NATURAL_LANGUAGE_ARGS = "-- __context_docs_instruction__";

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

function nonEmptyCompletions(
  items: AutocompleteItem[]
): AutocompleteItem[] | null {
  return items.length > 0 ? items : null;
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

  return nonEmptyCompletions(items);
}

function getUsedFlags(tokens: string[]): Set<string> {
  const usedFlags = new Set<string>();

  for (const token of tokens) {
    if (!token.startsWith("--") || token === "--") continue;
    const flag = token.includes("=")
      ? token.slice(0, token.indexOf("="))
      : token;
    usedFlags.add(flag);
  }

  return usedFlags;
}

function getExpectedValueFlag(tokens: string[]): string | null {
  let expected: string | null = null;

  for (const token of tokens) {
    if (expected) {
      expected = null;
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      expected = token;
    }
  }

  return expected;
}

function getAvailableFlags(
  command: ContextDocsCommand,
  usedFlags: Set<string>
): AutocompleteItem[] {
  return FLAG_COMPLETIONS[command].filter((item) => {
    if (item.label === "--") return true;
    return !usedFlags.has(item.label);
  });
}

export function getContextDocsArgumentCompletions(
  command: ContextDocsCommand,
  argumentPrefix: string,
  cwd: string
): AutocompleteItem[] | null {
  const { currentToken, precedingTokens } =
    splitCompletionTokens(argumentPrefix);
  if (precedingTokens.includes("--") || currentToken === "--") {
    return null;
  }

  const expectedValueFlag = getExpectedValueFlag(precedingTokens);
  if (expectedValueFlag) {
    const values = VALUE_COMPLETIONS[expectedValueFlag] ?? null;
    if (!values) return null;
    const matches = values.filter((item) =>
      item.value.startsWith(currentToken)
    );
    return nonEmptyCompletions(matches);
  }

  const usedFlags = getUsedFlags(precedingTokens);
  if (currentToken.startsWith("--")) {
    const matches = getAvailableFlags(command, usedFlags).filter((item) =>
      item.value.startsWith(currentToken)
    );
    return nonEmptyCompletions(matches);
  }

  const hasTarget = precedingTokens.some(
    (token) => !token.startsWith("--") && token !== "--"
  );

  if (hasTarget && currentToken.length === 0) {
    const flagItems = getAvailableFlags(command, usedFlags);
    return nonEmptyCompletions(flagItems);
  }

  if (hasTarget) return null;

  const pathItems = completeDirectories(currentToken, cwd) ?? [];
  const flagItems =
    currentToken.length === 0 ? getAvailableFlags(command, usedFlags) : [];
  const merged = [...flagItems, ...pathItems];

  return nonEmptyCompletions(merged);
}

function formatOptions(options: ContextDocsCommandInput["options"]): string {
  const entries = Object.entries(options).map(([key, value]) => {
    const rendered = Array.isArray(value) ? value.join(", ") : String(value);
    return `- ${key}: ${rendered}`;
  });

  return entries.length > 0 ? entries.join("\n") : "- none";
}

export function buildContextDocsMessage(
  input: ContextDocsCommandInput
): string {
  const instruction =
    input.instruction ?? DEFAULT_INSTRUCTIONS[input.command] ?? "run workflow";

  return [
    "Run the context-docs workflow.",
    "",
    "Resolved command input:",
    `- command: /${input.command}`,
    `- workflow: ${input.workflow}`,
    `- target root: ${input.targetRoot}`,
    `- target label: ${input.targetLabel}`,
    `- instruction: ${instruction}`,
    "- options:",
    formatOptions(input.options),
    "",
    "Command rules:",
    "- The resolved command input above is authoritative. Do not reinterpret command flags or target path.",
    "- Keep all reads, writes, edits, and deletes scoped to the resolved target root unless the user explicitly says otherwise.",
    "- Do not create, modify, schedule, or manage pi-tasks.",
    "- Prefer small, durable Markdown docs over chat-only context.",
    "- Ask focused questions only when missing information materially changes the result.",
    "",
    PROMPT,
  ].join("\n");
}

export function matchNaturalLanguageInput(
  text: string
): NaturalLanguageMatch | null {
  if (text.trimStart().startsWith("/")) return null;

  const patterns: Array<[RegExp, ContextDocsCommand]> = [
    [/^context\s+setup\s*:\s*(\S[\s\S]*)$/i, "context-setup"],
    [/^context\s+note\s*:\s*(\S[\s\S]*)$/i, "context-note"],
    [/^take\s+note\s+that\s+(\S[\s\S]*)$/i, "context-note"],
    [/^remember\s+that\s+(\S[\s\S]*)$/i, "context-note"],
    [/^record\s+that\s+(\S[\s\S]*)$/i, "context-note"],
    [/^adr\s*:\s*(\S[\s\S]*)$/i, "adr"],
    [/^context\s+review\s*:\s*(\S[\s\S]*)$/i, "context-review"],
    [/^context\s+grill\s*:\s*(\S[\s\S]*)$/i, "context-grill"],
  ];

  for (const [pattern, command] of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return { command, instruction: match[1].trim() };
    }
  }

  return null;
}

function hasContextDocs(targetRoot: string): boolean {
  return ["CONTEXT.md", "CONTEXT-MAP.md", "docs/adr", "docs/context"].some(
    (entry) => fs.existsSync(path.join(targetRoot, entry))
  );
}

function promptLooksLikeContextDocsWork(prompt: string): boolean {
  return /\b(context[- ]?docs?|context[- ]setup|context[- ]note|context[- ]review|context[- ]grill|adr|CONTEXT\.md|CONTEXT-MAP\.md)\b/i.test(
    prompt
  );
}

function promptLooksLikeProjectWork(prompt: string): boolean {
  return /\b(implement|implementation|plan|planning|review|debug|debugging|fix|build|refactor|test|context[- ]?docs?|context[- ]setup|context[- ]note|context[- ]review|context[- ]grill|adr|CONTEXT\.md|CONTEXT-MAP\.md)\b/i.test(
    prompt
  );
}

export function shouldInjectContextDocsReminder(
  prompt: string,
  targetRoot: string
): boolean {
  const relevant =
    hasContextDocs(targetRoot) || promptLooksLikeContextDocsWork(prompt);
  return relevant && promptLooksLikeProjectWork(prompt);
}

function detectCommandSecret(
  input: Pick<ContextDocsCommandInput, "instruction" | "options">
): string | null {
  const secret = detectSecret(
    JSON.stringify({ instruction: input.instruction, options: input.options })
  );

  return secret.hasSecret ? (secret.reason ?? "secret") : null;
}

function buildNaturalLanguageInput(
  command: ContextDocsCommand,
  instruction: string,
  cwd: string
): ContextDocsCommandInput | null {
  const parsed = parseContextDocsArgs(command, NATURAL_LANGUAGE_ARGS, cwd);

  if (!parsed.ok) return null;

  return {
    ...parsed.value,
    instruction,
  };
}

function notifySecretRefusal(ctx: ExtensionContext, reason: string): void {
  ctx.ui.notify(`Refusing context-docs prompt: possible ${reason}.`, "warning");
}

async function dispatchContextDocsCommand(
  command: ContextDocsCommand,
  args: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  const parsed = parseContextDocsArgs(command, args ?? "", ctx.cwd);
  if (!parsed.ok) {
    ctx.ui.notify(parsed.error, "warning");
    return;
  }

  const secretReason = detectCommandSecret(parsed.value);
  if (secretReason) {
    notifySecretRefusal(ctx, secretReason);
    return;
  }

  const message = buildContextDocsMessage(parsed.value);

  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
    return;
  }

  pi.sendUserMessage(message, { deliverAs: "followUp" });
  ctx.ui.notify(`Queued /${command} as a follow-up`, "info");
}

export default function contextDocsExtension(pi: ExtensionAPI): void {
  for (const command of COMMANDS) {
    pi.registerCommand(command.name, {
      description: command.description,
      getArgumentCompletions(argumentPrefix) {
        return getContextDocsArgumentCompletions(
          command.name,
          argumentPrefix,
          process.cwd()
        );
      },
      handler: async (args, ctx) => {
        await dispatchContextDocsCommand(command.name, args, ctx, pi);
      },
    });
  }

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || !ctx.hasUI || event.images?.length) {
      return undefined;
    }

    const matched = matchNaturalLanguageInput(event.text);
    if (!matched) {
      return undefined;
    }

    const input = buildNaturalLanguageInput(
      matched.command,
      matched.instruction,
      ctx.cwd
    );
    if (!input) {
      ctx.ui.notify("Unable to parse context-docs input.", "warning");
      return { action: "continue" as const };
    }

    const secretReason = detectCommandSecret(input);
    if (secretReason) {
      notifySecretRefusal(ctx, secretReason);
      return { action: "handled" as const };
    }

    const commandText = `/${matched.command} -- ${matched.instruction}`;
    const confirmed = await ctx.ui.confirm(
      "Run context-docs command?",
      `Interpret this input as ${commandText}`
    );

    if (!confirmed) {
      return { action: "continue" as const };
    }

    return {
      action: "transform" as const,
      text: buildContextDocsMessage(input),
    };
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!shouldInjectContextDocsReminder(event.prompt ?? "", ctx.cwd)) {
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${CONTEXT_DOCS_REMINDER}`,
    };
  });
}

export {
  buildContextDocsBlockMarkers,
  planMarkedBlockUpdate,
} from "./blocks";
export {
  classifyContextDocNote,
  reachesContextMapThreshold,
} from "./classification";
export { buildContextDocsPrompt } from "./prompts";
export { detectSecret } from "./secrets";
export { buildSessionEvidencePacket } from "./session";
