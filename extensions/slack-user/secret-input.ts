import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

// Reuse native editing and bracketed paste, but never render the secret Input.
export class SecretTokenInput implements Component, Focusable {
  focused = false;
  #input = new Input();
  #finished = false;
  readonly #requestRender: () => void;
  readonly #done: (token: string | undefined) => void;

  constructor(
    requestRender: () => void,
    done: (token: string | undefined) => void,
  ) {
    this.#requestRender = requestRender;
    this.#done = done;
    this.#input.onSubmit = (value) => this.#finish(value.trim());
    this.#input.onEscape = () => this.#finish(undefined);
  }

  #finish(value: string | undefined): void {
    if (this.#finished) {
      return;
    }
    this.dispose();
    this.#done(value);
  }

  handleInput(data: string): void {
    if (this.#finished) {
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.#finish(undefined);
    } else {
      this.#input.handleInput(data);
    }
    this.#requestRender();
  }

  render(width: number): string[] {
    const masked = this.#input.getValue() ? "Token: ********" : "Token: ";
    return [
      truncateToWidth("Slack User OAuth Token", width, ""),
      truncateToWidth(masked, width, "") + (this.focused ? CURSOR_MARKER : ""),
      truncateToWidth(
        "Enter: validate and save | Esc/Ctrl+C: cancel",
        width,
        "",
      ),
    ];
  }

  invalidate(): void {
    // No rendered secret or cached output to invalidate.
  }

  dispose(): void {
    this.#finished = true;
    // Drop paste, undo and kill-ring state along with the input value.
    this.#input = new Input();
  }
}
