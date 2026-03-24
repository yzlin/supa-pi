import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  buildSessionContext,
  type ContextUsage,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";

export const CONTEXT_BUCKET_ORDER = [
  "instructions",
  "user_text",
  "assistant_text",
  "assistant_thinking",
  "tool_calls",
  "tool_results",
  "bash_output",
  "summaries_custom",
  "residual",
] as const;

export const CONTEXT_DISPLAY_CATEGORY_ORDER = [
  "system_prompt",
  "system_tools",
  "custom_agents",
  "memory_files",
  "skills",
  "messages",
  "residual",
] as const;

export type ContextBucket = (typeof CONTEXT_BUCKET_ORDER)[number];
export type ContextDisplayCategoryKey =
  (typeof CONTEXT_DISPLAY_CATEGORY_ORDER)[number];
export type ContextSeverity = "healthy" | "caution" | "critical";
export type ContextSeveritySource = "exact" | "estimate";

export interface ContextBucketBreakdown {
  key: ContextBucket;
  label: string;
  tokens: number | null;
  percent: number | null;
}

export interface ContextDisplayCategory {
  key: ContextDisplayCategoryKey;
  label: string;
  tokens: number | null;
  percent: number | null;
  estimated: boolean;
}

export interface ContextArtifact {
  bucket: Exclude<ContextBucket, "residual">;
  tokens: number;
  turn: number | null;
  source: string;
}

export interface ContextSuggestion {
  kind:
    | "unknown_total"
    | "critical"
    | "caution"
    | "bash"
    | "tool_results"
    | "conversation"
    | "carryover"
    | "overestimate";
  text: string;
}

export interface ContextSnapshot {
  modelLabel: string;
  contextWindow: number;
  exactTotalTokens: number | null;
  exactPercent: number | null;
  estimatedTotalTokens: number;
  estimatedPercent: number | null;
  displayUsedTokens: number;
  displayUsedPercent: number | null;
  severity: ContextSeverity;
  severitySource: ContextSeveritySource;
  residualTokens: number | null;
  overestimateTokens: number;
  freeSpaceTokens: number | null;
  freeSpacePercent: number | null;
  autoCompactBufferTokens: number;
  autoCompactBufferPercent: number | null;
  buckets: ContextBucketBreakdown[];
  displayCategories: ContextDisplayCategory[];
  topOffenders: ContextArtifact[];
  suggestions: ContextSuggestion[];
}

interface AnalyzeMessagesInput {
  messages: AgentMessage[];
  systemPrompt?: string;
  contextUsage?: ContextUsage;
  contextWindow?: number;
  modelLabel?: string;
  autoCompactBufferTokens?: number;
}

interface SystemPromptBreakdown {
  system_prompt: number;
  system_tools: number;
  custom_agents: number;
  memory_files: number;
  skills: number;
}

const BUCKET_LABELS: Record<ContextBucket, string> = {
  instructions: "instructions",
  user_text: "user text",
  assistant_text: "assistant text",
  assistant_thinking: "assistant thinking",
  tool_calls: "tool calls",
  tool_results: "tool results",
  bash_output: "bash output",
  summaries_custom: "summaries/custom",
  residual: "residual",
};

const DISPLAY_CATEGORY_LABELS: Record<ContextDisplayCategoryKey, string> = {
  system_prompt: "System prompt",
  system_tools: "System tools",
  custom_agents: "Custom agents",
  memory_files: "Memory files",
  skills: "Skills",
  messages: "Messages",
  residual: "Residual / overhead",
};

const EMPTY_ASSISTANT_METADATA = {
  api: "anthropic",
  provider: "anthropic",
  model: "context-estimator",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  stopReason: "stop",
  timestamp: 0,
} as const;

function createSyntheticUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: 0,
  } as AgentMessage;
}

function createSyntheticAssistantMessage(content: unknown[]): AgentMessage {
  return {
    role: "assistant",
    content,
    ...EMPTY_ASSISTANT_METADATA,
  } as AgentMessage;
}

function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  return estimateTokens(createSyntheticUserMessage(trimmed));
}

function roundPercent(tokens: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }

  return Number(((tokens / total) * 100).toFixed(1));
}

function getSeverity(percent: number | null): ContextSeverity {
  if (percent === null) {
    return "healthy";
  }

  if (percent >= 90) {
    return "critical";
  }

  if (percent >= 70) {
    return "caution";
  }

  return "healthy";
}

function describeTurn(turn: number | null): string {
  if (turn === null) {
    return "setup";
  }

  if (turn <= 0) {
    return "carryover";
  }

  return `t${turn}`;
}

function clip(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function textFromBlocks(
  content: string | Array<{ type: string; text?: string }>
): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join(" ");
}

function suggestion(
  kind: ContextSuggestion["kind"],
  text: string
): ContextSuggestion {
  return { kind, text };
}

function formatSuggestionTokens(count: number): string {
  if (count < 1000) {
    return `${count} tokens`;
  }

  if (count < 10000) {
    return `${(count / 1000).toFixed(1)}k tokens`;
  }

  if (count < 1_000_000) {
    return `${Math.round(count / 1000)}k tokens`;
  }

  return `${(count / 1_000_000).toFixed(1)}M tokens`;
}

function extractMatches(
  source: string,
  pattern: RegExp,
  limit = Number.POSITIVE_INFINITY
): { matches: string[]; remaining: string } {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const matches: string[] = [];
  let remaining = source;

  while (matches.length < limit) {
    const match = regex.exec(remaining);
    if (!match || match.index === undefined) {
      break;
    }

    const matchedText = match[0];
    matches.push(matchedText);
    remaining =
      remaining.slice(0, match.index) +
      remaining.slice(match.index + matchedText.length);
    regex.lastIndex = 0;
  }

  return { matches, remaining };
}

function analyzeSystemPrompt(systemPrompt?: string): SystemPromptBreakdown {
  const prompt = (systemPrompt ?? "").trim();
  if (!prompt) {
    return {
      system_prompt: 0,
      system_tools: 0,
      custom_agents: 0,
      memory_files: 0,
      skills: 0,
    };
  }

  let remaining = prompt;

  const skills = extractMatches(
    remaining,
    /<available_skills>[\s\S]*?<\/available_skills>/i,
    1
  );
  remaining = skills.remaining;

  const systemTools = extractMatches(
    remaining,
    /Available tools:[\s\S]*?(?=\n(?:In addition to the tools above|Available agent types:|Guidelines:|Pi documentation|# Project Context|<identity>|<intent>|$))/i,
    1
  );
  remaining = systemTools.remaining;

  const customAgents = extractMatches(
    remaining,
    /Available agent types:[\s\S]*?(?=\n(?:Guidelines:|MUST DO|MUST NOT DO|CONTEXT|#|<|$))/i,
    1
  );
  remaining = customAgents.remaining;

  const agentsFiles = extractMatches(
    remaining,
    /##\s+\/[^\n]+AGENTS\.md[\s\S]*?(?=\n##\s+\/|\n\nThe following skills provide|\n<available_skills>|\nCurrent date:|$)/,
    Number.POSITIVE_INFINITY
  );
  remaining = agentsFiles.remaining;

  const rules = extractMatches(remaining, /<rules>[\s\S]*?<\/rules>/i, 1);
  remaining = rules.remaining;

  const memoryText = [...agentsFiles.matches, ...rules.matches].join("\n\n");

  return {
    system_prompt: estimateTextTokens(remaining),
    system_tools: estimateTextTokens(systemTools.matches.join("\n\n")),
    custom_agents: estimateTextTokens(customAgents.matches.join("\n\n")),
    memory_files: estimateTextTokens(memoryText),
    skills: estimateTextTokens(skills.matches.join("\n\n")),
  };
}

export function formatArtifactLabel(artifact: ContextArtifact): string {
  return `${describeTurn(artifact.turn)} • ${artifact.source}`;
}

export function analyzeMessages({
  messages,
  systemPrompt,
  contextUsage,
  contextWindow,
  modelLabel,
  autoCompactBufferTokens,
}: AnalyzeMessagesInput): ContextSnapshot {
  const rawBuckets: Record<Exclude<ContextBucket, "residual">, number> = {
    instructions: 0,
    user_text: 0,
    assistant_text: 0,
    assistant_thinking: 0,
    tool_calls: 0,
    tool_results: 0,
    bash_output: 0,
    summaries_custom: 0,
  };

  const artifacts: ContextArtifact[] = [];
  const addArtifact = (
    bucket: Exclude<ContextBucket, "residual">,
    tokens: number,
    turn: number | null,
    source: string
  ) => {
    if (tokens <= 0) {
      return;
    }

    rawBuckets[bucket] += tokens;
    artifacts.push({ bucket, tokens, turn, source });
  };

  const instructionBreakdown = analyzeSystemPrompt(systemPrompt);
  const instructionTokens = Object.values(instructionBreakdown).reduce(
    (sum, value) => sum + value,
    0
  );

  if (instructionTokens > 0) {
    addArtifact("instructions", instructionTokens, null, "instructions");
  }

  let currentTurn = 0;

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        currentTurn += 1;
        addArtifact(
          "user_text",
          estimateTokens(message),
          currentTurn,
          `user: ${clip(textFromBlocks(message.content as any))}`
        );
        break;
      }
      case "assistant": {
        const textBlocks = message.content.filter(
          (block) => block.type === "text"
        );
        const thinkingBlocks = message.content.filter(
          (block) => block.type === "thinking"
        );
        const toolCalls = message.content.filter(
          (block) => block.type === "toolCall"
        );

        if (textBlocks.length > 0) {
          addArtifact(
            "assistant_text",
            estimateTokens(createSyntheticAssistantMessage(textBlocks)),
            currentTurn,
            `assistant text: ${clip(
              textBlocks
                .map((block) => ("text" in block ? block.text : ""))
                .join(" ")
            )}`
          );
        }

        if (thinkingBlocks.length > 0) {
          addArtifact(
            "assistant_thinking",
            estimateTokens(createSyntheticAssistantMessage(thinkingBlocks)),
            currentTurn,
            "assistant thinking"
          );
        }

        for (const toolCall of toolCalls) {
          addArtifact(
            "tool_calls",
            estimateTokens(createSyntheticAssistantMessage([toolCall])),
            currentTurn,
            `tool call: ${toolCall.name}`
          );
        }
        break;
      }
      case "toolResult": {
        const bucket =
          message.toolName === "bash" ? "bash_output" : "tool_results";
        addArtifact(
          bucket,
          estimateTokens(message),
          currentTurn,
          `${message.toolName === "bash" ? "bash result" : "tool result"}: ${message.toolName}`
        );
        break;
      }
      case "bashExecution": {
        currentTurn += 1;
        addArtifact(
          "bash_output",
          estimateTokens(message),
          currentTurn,
          `bash: ${clip(message.command)}`
        );
        break;
      }
      case "custom": {
        addArtifact(
          "summaries_custom",
          estimateTokens(message),
          currentTurn > 0 ? currentTurn : 0,
          `custom: ${message.customType}`
        );
        break;
      }
      case "branchSummary": {
        addArtifact(
          "summaries_custom",
          estimateTokens(message),
          currentTurn > 0 ? currentTurn : 0,
          "branch summary"
        );
        break;
      }
      case "compactionSummary": {
        addArtifact(
          "summaries_custom",
          estimateTokens(message),
          currentTurn > 0 ? currentTurn : 0,
          "compaction summary"
        );
        break;
      }
    }
  }

  const estimatedTotalTokens = Object.values(rawBuckets).reduce(
    (sum, value) => sum + value,
    0
  );
  const resolvedContextWindow =
    contextWindow ?? contextUsage?.contextWindow ?? 0;
  const exactTotalTokens = contextUsage?.tokens ?? null;
  const exactPercent = contextUsage?.percent ?? null;
  const estimatedPercent = roundPercent(
    estimatedTotalTokens,
    resolvedContextWindow
  );
  const residualTokens =
    exactTotalTokens === null
      ? null
      : Math.max(0, exactTotalTokens - estimatedTotalTokens);
  const overestimateTokens =
    exactTotalTokens === null
      ? 0
      : Math.max(0, estimatedTotalTokens - exactTotalTokens);

  const displayUsedTokens =
    exactTotalTokens === null
      ? estimatedTotalTokens
      : Math.max(exactTotalTokens, estimatedTotalTokens);
  const displayUsedPercent = roundPercent(
    displayUsedTokens,
    resolvedContextWindow
  );

  const severitySource: ContextSeveritySource =
    exactTotalTokens !== null ? "exact" : "estimate";
  const severity = getSeverity(exactPercent ?? estimatedPercent);

  const displayBuckets: Record<ContextBucket, number> = {
    ...rawBuckets,
    residual: residualTokens ?? 0,
  };
  const bucketPercentBase = Object.values(displayBuckets).reduce(
    (sum, value) => sum + value,
    0
  );

  const buckets: ContextBucketBreakdown[] = CONTEXT_BUCKET_ORDER.map((key) => ({
    key,
    label: BUCKET_LABELS[key],
    tokens:
      key === "residual" && residualTokens === null
        ? null
        : displayBuckets[key],
    percent:
      key === "residual" && residualTokens === null
        ? null
        : roundPercent(displayBuckets[key], bucketPercentBase),
  }));

  const messageTokens =
    rawBuckets.user_text +
    rawBuckets.assistant_text +
    rawBuckets.assistant_thinking +
    rawBuckets.tool_calls +
    rawBuckets.tool_results +
    rawBuckets.bash_output +
    rawBuckets.summaries_custom;

  const displayCategories: ContextDisplayCategory[] =
    CONTEXT_DISPLAY_CATEGORY_ORDER.map((key) => {
      const tokens =
        key === "system_prompt"
          ? instructionBreakdown.system_prompt
          : key === "system_tools"
            ? instructionBreakdown.system_tools
            : key === "custom_agents"
              ? instructionBreakdown.custom_agents
              : key === "memory_files"
                ? instructionBreakdown.memory_files
                : key === "skills"
                  ? instructionBreakdown.skills
                  : key === "messages"
                    ? messageTokens
                    : residualTokens;

      return {
        key,
        label: DISPLAY_CATEGORY_LABELS[key],
        tokens,
        percent:
          tokens === null ? null : roundPercent(tokens, resolvedContextWindow),
        estimated: key !== "residual",
      };
    });

  const freeSpaceTokens =
    resolvedContextWindow > 0
      ? Math.max(0, resolvedContextWindow - displayUsedTokens)
      : null;
  const freeSpacePercent =
    freeSpaceTokens === null
      ? null
      : roundPercent(freeSpaceTokens, resolvedContextWindow);
  const resolvedAutoCompactBuffer = Math.min(
    autoCompactBufferTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    resolvedContextWindow > 0
      ? resolvedContextWindow
      : (autoCompactBufferTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens)
  );
  const autoCompactBufferPercent = roundPercent(
    resolvedAutoCompactBuffer,
    resolvedContextWindow
  );

  const topOffenders = [...artifacts]
    .sort((a, b) => b.tokens - a.tokens || a.source.localeCompare(b.source))
    .slice(0, 5);

  const suggestions: ContextSuggestion[] = [];
  if (exactTotalTokens === null) {
    suggestions.push(
      suggestion(
        "unknown_total",
        "Exact total is unknown until the next model response. Category lines below are still estimated from active context."
      )
    );
  }

  if (overestimateTokens > 0) {
    suggestions.push(
      suggestion(
        "overestimate",
        `Estimated categories currently exceed the exact total by about ${formatSuggestionTokens(overestimateTokens)}.`
      )
    );
  }

  if (severity === "critical") {
    suggestions.push(
      suggestion(
        "critical",
        "Context is tight. Run /compact now. If the task changed, start /new instead."
      )
    );
  } else if (severity === "caution") {
    suggestions.push(
      suggestion(
        "caution",
        "Context is getting full. Plan a /compact before more tool-heavy turns."
      )
    );
  }

  const share = (value: number) =>
    estimatedTotalTokens > 0 ? value / estimatedTotalTokens : 0;
  const conversationTokens =
    rawBuckets.user_text +
    rawBuckets.assistant_text +
    rawBuckets.assistant_thinking;

  if (rawBuckets.bash_output >= 1500 && share(rawBuckets.bash_output) >= 0.2) {
    suggestions.push(
      suggestion(
        "bash",
        "Bash output is large. Prefer quieter or filtered commands. Use !!command when output does not need to enter context."
      )
    );
  }

  if (
    rawBuckets.tool_results >= 1500 &&
    share(rawBuckets.tool_results) >= 0.2
  ) {
    suggestions.push(
      suggestion(
        "tool_results",
        "Tool results are large. Narrow reads and searches, and avoid huge raw outputs."
      )
    );
  }

  if (conversationTokens >= 3000 && share(conversationTokens) >= 0.45) {
    suggestions.push(
      suggestion(
        "conversation",
        "Conversation text is the main driver. /compact will reclaim space with the least workflow change."
      )
    );
  }

  if (
    rawBuckets.summaries_custom >= 1500 &&
    share(rawBuckets.summaries_custom) >= 0.2
  ) {
    suggestions.push(
      suggestion(
        "carryover",
        "Carry-over summaries are large. If the task changed, start /new for a cleaner context."
      )
    );
  }

  return {
    modelLabel: modelLabel ?? "no-model",
    contextWindow: resolvedContextWindow,
    exactTotalTokens,
    exactPercent,
    estimatedTotalTokens,
    estimatedPercent,
    displayUsedTokens,
    displayUsedPercent,
    severity,
    severitySource,
    residualTokens,
    overestimateTokens,
    freeSpaceTokens,
    freeSpacePercent,
    autoCompactBufferTokens: resolvedAutoCompactBuffer,
    autoCompactBufferPercent,
    buckets,
    displayCategories,
    topOffenders,
    suggestions,
  };
}

export function analyzeSessionContext(input: {
  entries: SessionEntry[];
  leafId?: string | null;
  systemPrompt?: string;
  contextUsage?: ContextUsage;
  contextWindow?: number;
  modelLabel?: string;
  autoCompactBufferTokens?: number;
}): ContextSnapshot {
  const sessionContext = buildSessionContext(input.entries, input.leafId);

  return analyzeMessages({
    messages: sessionContext.messages,
    systemPrompt: input.systemPrompt,
    contextUsage: input.contextUsage,
    contextWindow: input.contextWindow,
    modelLabel: input.modelLabel,
    autoCompactBufferTokens: input.autoCompactBufferTokens,
  });
}
