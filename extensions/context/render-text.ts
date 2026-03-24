import {
  type ContextArtifact,
  type ContextDisplayCategory,
  type ContextDisplayCategoryKey,
  type ContextSnapshot,
  formatArtifactLabel,
} from "./analyze";

function formatTokens(count: number | null): string {
  if (count === null) {
    return "unknown";
  }

  if (count < 1000) {
    return `${count}`;
  }

  if (count < 10000) {
    return `${(count / 1000).toFixed(1)}k`;
  }

  if (count < 1_000_000) {
    return `${Math.round(count / 1000)}k`;
  }

  return `${(count / 1_000_000).toFixed(1)}M`;
}

const CATEGORY_SYMBOLS: Record<ContextDisplayCategoryKey, string> = {
  system_prompt: "◉",
  system_tools: "◉",
  custom_agents: "◉",
  memory_files: "◉",
  skills: "◉",
  messages: "◉",
  residual: "◉",
};

function formatPercent(percent: number | null): string {
  return percent === null ? "unknown" : `${percent.toFixed(1)}%`;
}

function renderCategory(category: ContextDisplayCategory): string {
  const symbol = CATEGORY_SYMBOLS[category.key];
  return `${symbol} ${category.label}: ${formatTokens(category.tokens)} tokens (${formatPercent(category.percent)})`;
}

function renderOffender(artifact: ContextArtifact): string {
  return `${formatTokens(artifact.tokens)}  ${formatArtifactLabel(artifact)}`;
}

export function renderContextText(snapshot: ContextSnapshot): string {
  const header = `${snapshot.modelLabel} · ${formatTokens(snapshot.displayUsedTokens)}/${formatTokens(snapshot.contextWindow)} tokens`;
  const lines = [
    "/context",
    header,
    `(${formatPercent(snapshot.displayUsedPercent)})`,
    ...(snapshot.exactTotalTokens === null
      ? [
          `Exact total: unknown (${formatPercent(snapshot.estimatedPercent)} estimated)`,
        ]
      : snapshot.exactTotalTokens < snapshot.displayUsedTokens
        ? [
            `Exact total: ${formatTokens(snapshot.exactTotalTokens)} (${formatPercent(snapshot.exactPercent)})`,
          ]
        : []),
    "Estimated usage by category",
    ...snapshot.displayCategories
      .filter(
        (category) => category.key === "residual" || (category.tokens ?? 0) > 0
      )
      .map(renderCategory),
    `⛶ Free space: ${formatTokens(snapshot.freeSpaceTokens)} (${formatPercent(snapshot.freeSpacePercent)})`,
    `⛝ Autocompact buffer: ${formatTokens(snapshot.autoCompactBufferTokens)} tokens (${formatPercent(snapshot.autoCompactBufferPercent)})`,
  ];

  if (snapshot.topOffenders.length > 0) {
    lines.push(
      "",
      "Top offenders",
      ...snapshot.topOffenders.map(renderOffender)
    );
  }

  if (snapshot.suggestions.length > 0) {
    lines.push(
      "",
      "Notes",
      ...snapshot.suggestions.map((item) => `- ${item.text}`)
    );
  }

  return lines.join("\n");
}

export { formatPercent, formatTokens };
