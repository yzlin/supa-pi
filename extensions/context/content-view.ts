import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

import type {
  ContextContentBlock,
  ContextContentMessage,
  ContextContentSnapshot,
} from "./content";

const TEXT_FALLBACK_WIDTH = 56;
const OVERLAY_HEIGHT_RATIO = 0.85;
const MIN_BODY_HEIGHT = 8;
const CHROME_ROWS = 8;
const HELP =
  "↑↓/j/k scroll · pgup/pgdn or ctrl+b/ctrl+f faster · home/end · esc/q/enter close";

function normalizeRenderableText(text: string): string {
  return text.replace(/\t/g, "    ");
}

export function fitRenderedLinesToWidth(
  lines: string[],
  width: number
): string[] {
  return lines.map((line) =>
    truncateToWidth(normalizeRenderableText(line), width, "")
  );
}

function wrapPreservingLines(text: string, width: number): string[] {
  if (!text) {
    return [""];
  }

  return normalizeRenderableText(text)
    .split("\n")
    .flatMap((line) => {
      if (!line) {
        return [""];
      }

      return wrapTextWithAnsi(line, width).map((item) =>
        truncateToWidth(item, width)
      );
    });
}

function renderBlockLines(
  block: ContextContentBlock,
  width: number,
  formatLabel: (text: string) => string
): string[] {
  const indent = "  ";
  const contentIndent = "    ";
  const lines = [`${indent}${formatLabel(block.label)}`];

  for (const line of wrapPreservingLines(
    block.content,
    Math.max(8, width - contentIndent.length)
  )) {
    lines.push(`${contentIndent}${line}`);
  }

  return lines;
}

function renderMessageLines(
  message: ContextContentMessage,
  width: number,
  formatTitle: (text: string) => string,
  formatMeta: (text: string) => string,
  formatLabel: (text: string) => string
): string[] {
  const lines = [formatTitle(message.title)];

  if (message.metadata.length > 0) {
    lines.push(formatMeta(`  ${message.metadata.join(" · ")}`));
  }

  for (const block of message.blocks) {
    lines.push(...renderBlockLines(block, width, formatLabel));
  }

  return lines;
}

function buildBodyLines(
  snapshot: ContextContentSnapshot,
  width: number,
  formatSection: (text: string) => string,
  formatTitle: (text: string) => string,
  formatMeta: (text: string) => string,
  formatLabel: (text: string) => string
): string[] {
  const lines: string[] = [];

  lines.push(formatSection("System prompt"));
  lines.push(...wrapPreservingLines(snapshot.systemPrompt || "(empty)", width));
  lines.push("");
  lines.push(formatSection(`Messages (${snapshot.messageCount})`));

  if (snapshot.messages.length === 0) {
    lines.push("(empty)");
    return lines;
  }

  snapshot.messages.forEach((message, index) => {
    if (index > 0) {
      lines.push("");
    }

    lines.push(
      ...renderMessageLines(
        message,
        width,
        formatTitle,
        formatMeta,
        formatLabel
      )
    );
  });

  return lines;
}

function frameLine(content: string, width: number): string {
  const innerWidth = Math.max(0, width - 4);
  const clipped = truncateToWidth(normalizeRenderableText(content), innerWidth);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return `│ ${clipped}${padding} │`;
}

function border(
  width: number,
  left: string,
  fill: string,
  right: string
): string {
  return `${left}${fill.repeat(Math.max(0, width - 2))}${right}`;
}

function buildStatusLine(
  scroll: number,
  visibleRows: number,
  totalRows: number
): string {
  if (totalRows <= 0) {
    return HELP;
  }

  const from = Math.min(totalRows, scroll + 1);
  const to = Math.min(totalRows, scroll + visibleRows);
  return `${HELP} · ${from}-${to}/${totalRows}`;
}

export function renderContextContentText(
  snapshot: ContextContentSnapshot
): string {
  const lines = [
    "/context content",
    snapshot.sourceNote,
    `Model: ${snapshot.modelLabel}`,
    `Thinking: ${snapshot.thinkingLevel}`,
    `Messages: ${snapshot.messageCount}`,
    "",
    ...buildBodyLines(
      snapshot,
      120,
      (text) => `== ${text} ==`,
      (text) => text,
      (text) => text,
      (text) => `[${text}]`
    ),
  ];

  return lines.join("\n");
}

export async function showContextContentView(
  ctx: ExtensionCommandContext,
  snapshot: ContextContentSnapshot
): Promise<void> {
  if (!ctx.hasUI) {
    process.stdout.write(`${renderContextContentText(snapshot)}\n`);
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      let scroll = 0;
      let cachedWidth = -1;
      let cachedBody: string[] = [];
      let lastInnerWidth = 80;

      const refresh = () => {
        cachedWidth = -1;
        tui.requestRender();
      };

      const getBodyHeight = () =>
        Math.max(
          MIN_BODY_HEIGHT,
          Math.floor(tui.terminal.rows * OVERLAY_HEIGHT_RATIO) - CHROME_ROWS
        );

      const getBodyLines = (width: number) => {
        if (cachedWidth === width) {
          return cachedBody;
        }

        cachedWidth = width;
        cachedBody = fitRenderedLinesToWidth(
          buildBodyLines(
            snapshot,
            Math.max(8, width),
            (text) => theme.bold(theme.fg("toolTitle", text)),
            (text) => theme.bold(text),
            (text) => theme.fg("dim", text),
            (text) => theme.fg("accent", `[${text}]`)
          ),
          Math.max(8, width)
        );
        return cachedBody;
      };

      return {
        invalidate() {
          cachedWidth = -1;
        },
        render(width: number) {
          if (width < TEXT_FALLBACK_WIDTH) {
            return fitRenderedLinesToWidth(
              renderContextContentText(snapshot)
                .split("\n")
                .flatMap((line) => wrapTextWithAnsi(line, width))
                .map((line) => truncateToWidth(line, width)),
              width
            );
          }

          const frameWidth = Math.max(24, width);
          const innerWidth = Math.max(8, frameWidth - 4);
          lastInnerWidth = innerWidth;
          const body = getBodyLines(innerWidth);
          const bodyHeight = getBodyHeight();
          const maxScroll = Math.max(0, body.length - bodyHeight);
          scroll = Math.min(scroll, maxScroll);
          const visibleBody = body.slice(scroll, scroll + bodyHeight);
          const lines = [
            border(frameWidth, "╭", "─", "╮"),
            frameLine(theme.bold("/context content"), frameWidth),
            frameLine(theme.fg("dim", snapshot.sourceNote), frameWidth),
            frameLine(
              theme.fg(
                "muted",
                `Model: ${snapshot.modelLabel} · Thinking: ${snapshot.thinkingLevel} · Messages: ${snapshot.messageCount}`
              ),
              frameWidth
            ),
            border(frameWidth, "├", "─", "┤"),
            ...visibleBody.map((line) => frameLine(line, frameWidth)),
          ];

          while (lines.length < bodyHeight + 5) {
            lines.push(frameLine("", frameWidth));
          }

          lines.push(border(frameWidth, "├", "─", "┤"));
          lines.push(
            frameLine(
              theme.fg(
                "dim",
                buildStatusLine(scroll, visibleBody.length, body.length)
              ),
              frameWidth
            )
          );
          lines.push(border(frameWidth, "╰", "─", "╯"));
          return lines;
        },
        handleInput(data: string) {
          const bodyHeight = getBodyHeight();
          const maxScroll = Math.max(
            0,
            getBodyLines(lastInnerWidth).length - bodyHeight
          );

          if (
            matchesKey(data, Key.escape) ||
            matchesKey(data, Key.enter) ||
            data.toLowerCase() === "q"
          ) {
            done(undefined);
            return;
          }

          if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
            scroll = Math.max(0, scroll - 1);
            refresh();
            return;
          }

          if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
            scroll = Math.min(maxScroll, scroll + 1);
            refresh();
            return;
          }

          if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
            scroll = Math.max(0, scroll - Math.max(1, bodyHeight - 2));
            refresh();
            return;
          }

          if (
            matchesKey(data, Key.pageDown) ||
            matchesKey(data, Key.ctrl("f"))
          ) {
            scroll = Math.min(maxScroll, scroll + Math.max(1, bodyHeight - 2));
            refresh();
            return;
          }

          if (matchesKey(data, Key.home)) {
            scroll = 0;
            refresh();
            return;
          }

          if (matchesKey(data, Key.end)) {
            scroll = maxScroll;
            refresh();
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "88%",
        maxHeight: "85%",
        margin: 1,
      },
    }
  );
}
