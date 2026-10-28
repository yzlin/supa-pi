import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  Input,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export const REVIEW_CUSTOM_OPTION = "Type something.";

export interface ReviewPrompt {
  title: string;
  options: string[];
  // Adds a final free-text row; only reviewer questions allow it.
  custom?: boolean;
}

interface ThemeLike {
  bold(text: string): string;
  fg(token: string, text: string): string;
}

interface TuiLike {
  requestRender(): void;
  terminal: { rows: number };
}

// Undefined = the host cannot show custom UI; null = the user cancelled.
type DialogResult = { answer: string } | null;

function promptRows(prompt: ReviewPrompt): string[] {
  return prompt.custom
    ? [...prompt.options, REVIEW_CUSTOM_OPTION]
    : prompt.options;
}

function previewLines(text: string, width: number, theme: ThemeLike) {
  let fenced = false;
  return text.split("\n").flatMap((line) => {
    if (/^`{3,}/.test(line)) {
      fenced = !fenced;
      return [theme.fg("dim", line)];
    }
    let styled = line;
    if (fenced && /^\+(?!\+\+)/.test(line)) {
      styled = theme.fg("success", line);
    } else if (fenced && /^-(?!--)/.test(line)) {
      styled = theme.fg("error", line);
    }
    return wrapTextWithAnsi(styled, width);
  });
}

function dialog(
  tui: TuiLike,
  theme: ThemeLike,
  preview: string,
  prompt: ReviewPrompt,
  done: (result: DialogResult) => void,
): Component {
  const rows = promptRows(prompt);
  const input = new Input();
  let selected = 0;
  let typing = false;
  let scroll = 0;
  let maxScroll = 0;
  input.onSubmit = (value) => {
    const answer = value.trim();
    if (answer) {
      done({ answer });
    }
  };
  input.onEscape = () => {
    typing = false;
    input.focused = false;
    tui.requestRender();
  };
  return {
    invalidate() {
      return;
    },
    render(width) {
      const inner = Math.max(1, width - 2);
      const pad = (line: string) => ` ${truncateToWidth(line, inner, "…")}`;
      const rule = theme.fg("accent", "─".repeat(Math.max(1, width)));
      const title = wrapTextWithAnsi(
        theme.fg("accent", theme.bold(prompt.title)),
        inner,
      );
      const options = rows.map((option, index) =>
        index === selected
          ? theme.fg("accent", `→ ${option}`)
          : `  ${theme.fg("text", option)}`,
      );
      const field = typing ? input.render(inner) : [];
      const hint = theme.fg(
        "dim",
        typing
          ? "enter submit  esc back"
          : "↑↓ navigate  pgup/pgdn scroll preview  enter select  esc cancel",
      );
      const body = previewLines(preview, inner, theme);
      // Keep the prompt on screen; the preview gets the remaining rows.
      const fixed = title.length + options.length + field.length + 7;
      const room = Math.max(3, tui.terminal.rows - fixed);
      maxScroll = Math.max(0, body.length - room);
      scroll = Math.min(scroll, maxScroll);
      const visible = body.slice(scroll, scroll + room);
      if (maxScroll > 0) {
        visible.push(
          theme.fg(
            "dim",
            `(preview ${scroll + 1}-${scroll + visible.length} of ${body.length} lines)`,
          ),
        );
      }
      return [
        rule,
        ...visible.map(pad),
        ...(visible.length ? [""] : []),
        ...title.map(pad),
        "",
        ...options.map(pad),
        ...field.map(pad),
        "",
        pad(hint),
        rule,
      ];
    },
    handleInput(data) {
      if (typing) {
        input.handleInput(data);
        tui.requestRender();
        return;
      }
      const kb = getKeybindings();
      if (kb.matches(data, "tui.select.up")) {
        selected = Math.max(0, selected - 1);
      } else if (kb.matches(data, "tui.select.down")) {
        selected = Math.min(rows.length - 1, selected + 1);
      } else if (kb.matches(data, "tui.select.pageUp")) {
        scroll = Math.max(0, scroll - 10);
      } else if (kb.matches(data, "tui.select.pageDown")) {
        scroll = Math.min(maxScroll, scroll + 10);
      } else if (kb.matches(data, "tui.select.confirm")) {
        if (prompt.custom && selected === rows.length - 1) {
          typing = true;
          input.focused = true;
          input.setValue("");
        } else {
          const answer = rows[selected];
          if (answer !== undefined) {
            done({ answer });
          }
          return;
        }
      } else if (kb.matches(data, "tui.select.cancel")) {
        done(null);
        return;
      }
      tui.requestRender();
    },
  };
}

// Shows the review text inside the dialog: a custom message sent during the
// tool call is held until the call ends, so it cannot be "shown above".
export async function askReview(
  ctx: ExtensionContext,
  preview: string,
  prompt: ReviewPrompt,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (ctx.mode === "tui") {
    if (signal?.aborted) {
      return undefined;
    }
    const result = await ctx.ui.custom<DialogResult>(
      (tui, theme, _kb, done) => {
        const finish = (value: DialogResult) => {
          signal?.removeEventListener("abort", onAbort);
          done(value);
        };
        const onAbort = () => finish(null);
        signal?.addEventListener("abort", onAbort, { once: true });
        return dialog(tui, theme, preview, prompt, finish);
      },
    );
    if (result !== undefined) {
      return result?.answer;
    }
  }
  const choice = await ctx.ui.select(prompt.title, promptRows(prompt), {
    signal,
  });
  if (
    choice === REVIEW_CUSTOM_OPTION &&
    prompt.custom &&
    !prompt.options.includes(choice)
  ) {
    const typed = (await ctx.ui.input(prompt.title, "", { signal }))?.trim();
    return typed || undefined;
  }
  return choice;
}
