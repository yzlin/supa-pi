import { stripVTControlCharacters } from "node:util";

import {
  truncateToVisualLines,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

interface Preview {
  runId: string;
  status: "queued" | "running";
  text: string;
  attachCommand?: string;
  label: string;
  startedAt: number;
}
interface ParentPreview {
  calls: Map<string, Preview>;
  invalidate?: () => void;
}

const FOCUS_LINES = 3;
const PREVIEW_CHARS = 8192;
function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
function safeText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\t/gu, "    ")
    .replace(/\p{Cc}/gu, (control) => (control === "\n" ? control : ""));
}
function labelFrom(args: unknown): string {
  const agent =
    args && typeof args === "object" && "agent" in args
      ? args.agent
      : undefined;
  return typeof agent === "string" && agent.trim()
    ? safeText(agent).replace(/\s+/gu, " ").trim().slice(0, 64)
    : "subagent";
}
function previewFrom(
  result: unknown,
  args: unknown,
  startedAt: number,
): Preview | undefined {
  if (!result || typeof result !== "object" || !("details" in result)) {
    return;
  }
  const details = result.details;
  if (
    !details ||
    typeof details !== "object" ||
    !("runId" in details) ||
    typeof details.runId !== "string" ||
    !("status" in details) ||
    (details.status !== "queued" && details.status !== "running") ||
    !("text" in details) ||
    typeof details.text !== "string"
  ) {
    return;
  }
  return {
    runId: safeText(details.runId).slice(0, 256),
    status: details.status,
    text: safeText(details.text.slice(-PREVIEW_CHARS)),
    attachCommand:
      "attachCommand" in details && typeof details.attachCommand === "string"
        ? safeText(details.attachCommand).slice(0, 512)
        : undefined,
    label: labelFrom(args),
    startedAt,
  };
}

/** Native codemode omits child partial results; execution events still carry them. */
export function registerCodemodeSubagentPreviews(pi: ExtensionAPI) {
  const parents = new Map<string, ParentPreview>();
  const views = new WeakMap<object, ParentPreview>();
  const clear = () => {
    for (const parent of parents.values()) {
      parent.calls.clear();
      parent.invalidate?.();
    }
    parents.clear();
  };
  pi.on("tool_execution_start", (event) => {
    if (
      event.toolName === "codemode" &&
      !event.parentToolCallId &&
      !parents.has(event.toolCallId)
    ) {
      parents.set(event.toolCallId, { calls: new Map() });
    }
  });
  pi.on("tool_execution_update", (event) => {
    if (event.toolName !== "subagent" || !event.parentToolCallId) {
      return;
    }
    const parent = parents.get(event.parentToolCallId);
    const preview = previewFrom(
      event.partialResult,
      event.args,
      parent?.calls.get(event.toolCallId)?.startedAt ?? Date.now(),
    );
    if (!parent || !preview) {
      return;
    }
    // Re-insert so the most recently active child is last and gets focus.
    parent.calls.delete(event.toolCallId);
    parent.calls.set(event.toolCallId, preview);
    parent.invalidate?.();
  });
  pi.on("tool_execution_end", (event) => {
    const parent = parents.get(event.parentToolCallId ?? event.toolCallId);
    if (!parent) {
      return;
    }
    if (event.parentToolCallId) {
      parent.calls.delete(event.toolCallId);
    } else {
      parent.calls.clear();
      parents.delete(event.toolCallId);
    }
    parent.invalidate?.();
  });
  return {
    clear,
    wrap(
      component: Component,
      context: { state: object; toolCallId: string; invalidate: () => void },
      theme: { fg(token: string, text: string): string },
    ): Component {
      let parent = views.get(context.state);
      if (!parent) {
        parent = parents.get(context.toolCallId) ?? { calls: new Map() };
        parents.set(context.toolCallId, parent);
        views.set(context.state, parent);
      }
      parent.invalidate = context.invalidate;
      const view = parent;
      return {
        invalidate() {
          component.invalidate();
        },
        render(width) {
          const prefix = theme.fg("dim", "┊   ");
          const lines = [...component.render(width)];
          const previews = [...view.calls.values()];
          const labelWidth = Math.max(
            ...previews.map((preview) => preview.label.length),
          );
          const push = (text: string) =>
            lines.push(truncateToWidth(`${prefix}${text}`, width, "…", true));
          for (const [index, preview] of previews.entries()) {
            const activity = preview.text
              .split("\n")
              .filter((line) => line.trim())
              .join("\n");
            const focused = index === previews.length - 1;
            const tail = truncateToVisualLines(
              activity,
              focused ? FOCUS_LINES : 1,
              Math.max(1, width - 4 - labelWidth - 13),
              0,
              "end",
            ).visualLines;
            const queued = preview.status === "queued";
            const glyph = theme.fg("warning", queued ? "◷" : "•");
            const elapsed = queued
              ? theme.fg("warning", "queued".padEnd(7))
              : theme.fg(
                  "dim",
                  formatElapsed(Date.now() - preview.startedAt).padEnd(7),
                );
            const head = `${glyph} ${preview.label.padEnd(labelWidth)} ${elapsed} `;
            const indent = " ".repeat(labelWidth + 11);
            // A single line sits inline; a multi-line tail gets a gutter.
            const gutter = tail.length > 1 ? theme.fg("dim", "│ ") : "";
            for (const [row, line] of tail.entries()) {
              const last = row === tail.length - 1;
              const text = theme.fg(last ? "accent" : "toolOutput", line);
              push(`${row === 0 ? head : indent}${gutter}${text}`);
            }
            if (tail.length === 0) {
              push(head.trimEnd());
            }
            if (focused && preview.attachCommand) {
              push(theme.fg("dim", `attach: ${preview.attachCommand}`));
            }
          }
          return lines;
        },
      };
    },
  };
}
