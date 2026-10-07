import { stripVTControlCharacters } from "node:util";

import {
  truncateToVisualLines,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

interface Preview {
  runId: string;
  status: "queued" | "running";
  text: string;
  attachCommand?: string;
}
interface ParentPreview {
  calls: Map<string, Preview>;
  invalidate?: () => void;
}

const PREVIEW_LINES = 8;
const PREVIEW_CHARS = 8192;
function safeText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\t/gu, "    ")
    .replace(/\p{Cc}/gu, (control) => (control === "\n" ? control : ""));
}
function previewFrom(result: unknown): Preview | undefined {
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
    const preview = previewFrom(event.partialResult);
    if (!parent || !preview) {
      return;
    }
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
          const contentWidth = Math.max(1, width - 4);
          const lines = [...component.render(width)];
          for (const preview of view.calls.values()) {
            const heading = `subagent ${preview.status}: ${preview.runId}`;
            const tail = truncateToVisualLines(
              preview.text,
              PREVIEW_LINES,
              contentWidth,
              0,
              "end",
            ).visualLines;
            const body = [
              heading,
              ...(preview.attachCommand ? [preview.attachCommand] : []),
              ...tail,
            ];
            for (const text of body) {
              lines.push(
                ...new Text(theme.fg("toolOutput", text), 0, 0)
                  .render(contentWidth)
                  .map((line) =>
                    truncateToWidth(`${prefix}${line}`, width, ""),
                  ),
              );
            }
          }
          return lines;
        },
      };
    },
  };
}
