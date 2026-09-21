// Hidden credential input adapted from pi-typesafe (MIT); see LICENSE.pi-typesafe.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  CURSOR_MARKER,
  type Focusable,
  Input,
  Key,
  matchesKey,
  Text,
} from "@earendil-works/pi-tui";

class RouterLoginPrompt extends Container implements Focusable {
  readonly #input = new MaskedKeyInput();
  #focused = false;

  constructor(
    theme: {
      fg(color: string, text: string): string;
      bold(text: string): string;
    },
    done: (value: string | undefined) => void
  ) {
    super();
    this.addChild(
      new Text(theme.fg("accent", theme.bold("TypeSafe API key")), 1, 0)
    );
    this.addChild(
      new Text(
        theme.fg(
          "muted",
          "Get one at console.typesafe.ai › API Keys. Input is hidden; Enter verifies and saves, Esc cancels."
        ),
        1,
        0
      )
    );
    this.addChild(this.#input);
    this.#input.onSubmit = (value) => done(value);
    this.#input.onEscape = () => done(undefined);
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.#input.onEscape?.();
      return;
    }
    this.#input.handleInput(data);
  }
}

class MaskedKeyInput extends Input {
  override handleInput(data: string): void {
    super.handleInput(data);
    if (this.getValue().length > 512) {
      this.setValue(this.getValue().slice(0, 512));
    }
  }

  override render(width: number): string[] {
    const usable = Math.max(1, Math.min(64, width));
    const count = Math.min(this.getValue().length, usable - 1);
    return [
      `${"•".repeat(count)}${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`,
    ];
  }
}

export function hiddenRouterInput(
  ctx: ExtensionContext
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (_tui, theme, _keys, done) => new RouterLoginPrompt(theme, done)
  );
}
