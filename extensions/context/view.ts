import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

import {
  CONTEXT_DISPLAY_CATEGORY_ORDER,
  type ContextDisplayCategory,
  type ContextDisplayCategoryKey,
  type ContextSnapshot,
  formatArtifactLabel,
} from "./analyze";
import { formatPercent, formatTokens, renderContextText } from "./render-text";

const TEXT_FALLBACK_WIDTH = 56;
const BAR_COLUMNS = 20;
const BAR_ROWS = 10;
const BAR_CELLS = BAR_COLUMNS * BAR_ROWS;
const HELP = "esc/q/enter close";

const CATEGORY_ICON = "◉";
const FREE_ICON = "⛶";
const BUFFER_ICON = "⛝";

const CATEGORY_STYLE: Record<
  ContextDisplayCategoryKey,
  { color: string; symbol: string }
> = {
  system_prompt: { color: "muted", symbol: CATEGORY_ICON },
  system_tools: { color: "muted", symbol: CATEGORY_ICON },
  custom_agents: { color: "accent", symbol: CATEGORY_ICON },
  memory_files: { color: "warning", symbol: CATEGORY_ICON },
  skills: { color: "toolTitle", symbol: CATEGORY_ICON },
  messages: { color: "customMessageLabel", symbol: CATEGORY_ICON },
  residual: { color: "dim", symbol: CATEGORY_ICON },
};

const FREE_STYLE = { color: "dim", symbol: FREE_ICON };
const BUFFER_STYLE = { color: "dim", symbol: BUFFER_ICON };

function allocateCounts(
  items: Array<{ key: string; tokens: number }>,
  totalCells: number,
  order: string[]
): Record<string, number> {
  const counts = Object.fromEntries(order.map((key) => [key, 0]));
  const totalTokens = items.reduce((sum, item) => sum + item.tokens, 0);

  if (totalCells <= 0 || totalTokens <= 0) {
    return counts;
  }

  const weighted = items.map((item) => {
    const exact = (item.tokens / totalTokens) * totalCells;
    const base = Math.floor(exact);
    return {
      key: item.key,
      base,
      remainder: exact - base,
    };
  });

  let used = 0;
  for (const item of weighted) {
    counts[item.key] = item.base;
    used += item.base;
  }

  weighted
    .sort(
      (a, b) =>
        b.remainder - a.remainder || order.indexOf(a.key) - order.indexOf(b.key)
    )
    .slice(0, Math.max(0, totalCells - used))
    .forEach((item) => {
      counts[item.key] += 1;
    });

  return counts;
}

function buildBarCells(
  snapshot: ContextSnapshot
): Array<{ color: string; symbol: string }> {
  const usedCells = Math.max(
    snapshot.displayUsedPercent && snapshot.displayUsedPercent > 0 ? 1 : 0,
    Math.min(
      BAR_CELLS,
      Math.round(((snapshot.displayUsedPercent ?? 0) / 100) * BAR_CELLS)
    )
  );
  const bufferCells = Math.min(
    BAR_CELLS - usedCells,
    Math.round(((snapshot.autoCompactBufferPercent ?? 0) / 100) * BAR_CELLS)
  );
  const freeCells = Math.max(0, BAR_CELLS - usedCells - bufferCells);

  const categoryCounts = allocateCounts(
    snapshot.displayCategories
      .filter((category) => (category.tokens ?? 0) > 0)
      .map((category) => ({ key: category.key, tokens: category.tokens ?? 0 })),
    usedCells,
    [...CONTEXT_DISPLAY_CATEGORY_ORDER]
  );

  const cells: Array<{ color: string; symbol: string }> = [];
  for (const key of CONTEXT_DISPLAY_CATEGORY_ORDER) {
    for (let index = 0; index < (categoryCounts[key] ?? 0); index += 1) {
      cells.push(CATEGORY_STYLE[key]);
    }
  }

  for (let index = 0; index < freeCells; index += 1) {
    cells.push(FREE_STYLE);
  }

  for (let index = 0; index < bufferCells; index += 1) {
    cells.push(BUFFER_STYLE);
  }

  while (cells.length < BAR_CELLS) {
    cells.push(FREE_STYLE);
  }

  return cells.slice(0, BAR_CELLS);
}

function renderGrid(snapshot: ContextSnapshot, theme: any): string[] {
  const cells = buildBarCells(snapshot);
  const lines: string[] = [];

  for (let row = 0; row < BAR_ROWS; row += 1) {
    const rowCells = cells.slice(row * BAR_COLUMNS, (row + 1) * BAR_COLUMNS);
    lines.push(
      rowCells.map((cell) => theme.fg(cell.color, cell.symbol)).join(" ")
    );
  }

  return lines;
}

function renderCategoryLine(
  category: ContextDisplayCategory,
  theme: any
): string {
  const style = CATEGORY_STYLE[category.key];
  return `${theme.fg(style.color, style.symbol)} ${theme.bold(category.label)}: ${formatTokens(
    category.tokens
  )} tokens (${formatPercent(category.percent)})`;
}

function renderRightPanel(snapshot: ContextSnapshot, theme: any): string[] {
  const lines = [
    theme.fg(
      "muted",
      `${snapshot.modelLabel} · ${formatTokens(snapshot.displayUsedTokens)}/${formatTokens(snapshot.contextWindow)} tokens`
    ),
    theme.fg("muted", `(${formatPercent(snapshot.displayUsedPercent)})`),
    theme.italic(theme.fg("muted", "Estimated usage by category")),
    ...snapshot.displayCategories
      .filter(
        (category) => category.key === "residual" || (category.tokens ?? 0) > 0
      )
      .map((category) => renderCategoryLine(category, theme)),
    `${theme.fg(FREE_STYLE.color, FREE_STYLE.symbol)} ${theme.bold("Free space")}: ${formatTokens(
      snapshot.freeSpaceTokens
    )} (${formatPercent(snapshot.freeSpacePercent)})`,
    `${theme.fg(BUFFER_STYLE.color, BUFFER_STYLE.symbol)} ${theme.bold("Autocompact buffer")}: ${formatTokens(
      snapshot.autoCompactBufferTokens
    )} tokens (${formatPercent(snapshot.autoCompactBufferPercent)})`,
  ];

  if (snapshot.exactTotalTokens === null) {
    lines.splice(
      2,
      0,
      theme.fg(
        "dim",
        `Exact total unknown · ${formatPercent(snapshot.estimatedPercent)} estimated`
      )
    );
  } else if (snapshot.exactTotalTokens < snapshot.displayUsedTokens) {
    lines.splice(
      2,
      0,
      theme.fg(
        "dim",
        `Exact total ${formatTokens(snapshot.exactTotalTokens)} (${formatPercent(snapshot.exactPercent)})`
      )
    );
  }

  if (snapshot.topOffenders.length > 0) {
    lines.push(
      "",
      theme.fg("muted", "Top offenders"),
      ...snapshot.topOffenders
        .slice(0, 3)
        .map((artifact) =>
          theme.fg(
            "dim",
            `${formatTokens(artifact.tokens)}  ${formatArtifactLabel(artifact)}`
          )
        )
    );
  }

  if (snapshot.suggestions.length > 0) {
    lines.push(
      "",
      ...snapshot.suggestions.map((item) => theme.fg("dim", `- ${item.text}`))
    );
  }

  lines.push("", theme.fg("dim", HELP));
  return lines;
}

function renderGridLayout(
  snapshot: ContextSnapshot,
  theme: any,
  width: number
): string[] {
  const left = renderGrid(snapshot, theme);
  const leftWidth = visibleWidth(left[0] ?? "");
  const gap = width >= leftWidth + 32 ? 3 : 2;
  const rightWidth = Math.max(16, width - leftWidth - gap);
  const right = renderRightPanel(snapshot, theme).flatMap((line) =>
    wrapTextWithAnsi(line, rightWidth)
  );
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];

  for (let index = 0; index < rows; index += 1) {
    const leftLine = left[index] ?? "";
    const rightLine = right[index] ?? "";
    const paddedLeft = `${leftLine}${" ".repeat(
      Math.max(0, leftWidth - visibleWidth(leftLine) + gap)
    )}`;
    lines.push(
      truncateToWidth(
        `${paddedLeft}${truncateToWidth(rightLine, rightWidth)}`,
        width
      )
    );
  }

  return lines;
}

export async function showContextView(
  ctx: ExtensionCommandContext,
  snapshot: ContextSnapshot
): Promise<void> {
  if (!ctx.hasUI) {
    process.stdout.write(`${renderContextText(snapshot)}\n`);
    return;
  }

  await ctx.ui.custom<void>((_tui, theme, _kb, done) => ({
    invalidate() {},
    render(width: number) {
      if (width < TEXT_FALLBACK_WIDTH) {
        return renderContextText(snapshot)
          .split("\n")
          .flatMap((line) => wrapTextWithAnsi(line, width))
          .map((line) => truncateToWidth(line, width));
      }

      return renderGridLayout(snapshot, theme, width);
    },
    handleInput(data: string) {
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.enter) ||
        data.toLowerCase() === "q"
      ) {
        done(undefined);
      }
    },
  }));
}
