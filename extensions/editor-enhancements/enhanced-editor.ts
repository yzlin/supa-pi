import * as Clipboard from "@mariozechner/clipboard";
import {
  CustomEditor,
  type ExtensionContext,
  type ExtensionUIContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
} from "@mariozechner/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type EditorTheme,
  type TUI,
} from "@mariozechner/pi-tui";

import { openFilePicker } from "./file-picker.js";
import {
  findCompletionShell,
  getShellCompletions,
  type ShellInfo,
} from "./shell-completions.js";
import type { StatusBarRuntimeConfig } from "./config.js";
import { renderStatusBarLine } from "./status-bar.js";

type EnhancedEditorOptions = {
  doubleEscapeCommand: string | null;
  canTriggerDoubleEscapeCommand: () => boolean;
  commandRemap: Record<string, string>;
  statusBar: {
    config: StatusBarRuntimeConfig;
    getContext: () => ExtensionContext | null;
    getFooterData: () => ReadonlyFooterDataProvider | null;
  };
};

type AutocompleteSuggestionResult = {
  items: AutocompleteItem[];
  prefix: string;
} | null;

type Awaitable<T> = T | Promise<T>;

type AutocompleteRequestOptions = {
  signal: AbortSignal;
  force?: boolean;
};

type CompatibleAutocompleteProvider = {
  getSuggestions: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options?: AutocompleteRequestOptions
  ) => Awaitable<AutocompleteSuggestionResult>;
  applyCompletion: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string
  ) => {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  };
  getForceFileSuggestions?: (
    lines: string[],
    cursorLine: number,
    cursorCol: number
  ) => AutocompleteSuggestionResult;
  shouldTriggerFileCompletion?: (
    lines: string[],
    cursorLine: number,
    cursorCol: number
  ) => boolean;
};

const DOUBLE_ESCAPE_WINDOW_MS = 500;

function isAtCompletionContext(
  lines: string[],
  cursorLine: number,
  cursorCol: number
): boolean {
  const line = lines[cursorLine] ?? "";
  const beforeCursor = line.slice(0, cursorCol);
  return Boolean(beforeCursor.match(/(?:^|[\s])@[^\s]*$/));
}

function isBashMode(lines: string[]): boolean {
  const text = lines.join("\n").trimStart();
  return text.startsWith("!") || text.startsWith("!!");
}

function extractCompletionTextUpToCursor(
  lines: string[],
  cursorLine: number,
  cursorCol: number
): string {
  const textLines = lines.slice(0, cursorLine + 1);
  if (textLines.length > 0) {
    textLines[textLines.length - 1] = (
      textLines[textLines.length - 1] ?? ""
    ).slice(0, cursorCol);
  }
  return textLines.join("\n");
}

function wrapProviderWithShellAndAtFiltering(
  provider: AutocompleteProvider,
  shell: ShellInfo
): AutocompleteProvider {
  const compatibleProvider =
    provider as unknown as CompatibleAutocompleteProvider;

  const wrappedProvider: CompatibleAutocompleteProvider = {
    getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options?: AutocompleteRequestOptions
    ): Awaitable<AutocompleteSuggestionResult> {
      // If user is typing an @ reference, suppress the native autocomplete
      // (we handle "@" ourselves by opening the picker)
      if (isAtCompletionContext(lines, cursorLine, cursorCol)) {
        return null;
      }

      if (isBashMode(lines)) {
        const text = extractCompletionTextUpToCursor(
          lines,
          cursorLine,
          cursorCol
        );
        const result = getShellCompletions(text, process.cwd(), shell);
        if (result && result.items.length > 0) {
          return result;
        }
      }

      return compatibleProvider.getSuggestions(lines, cursorLine, cursorCol, {
        signal: options?.signal ?? new AbortController().signal,
        force: options?.force,
      });
    },

    applyCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      item: AutocompleteItem,
      prefix: string
    ): { lines: string[]; cursorLine: number; cursorCol: number } {
      if (isBashMode(lines)) {
        const currentLine = lines[cursorLine] || "";
        const prefixStart = cursorCol - prefix.length;
        const beforePrefix = currentLine.slice(0, prefixStart);
        const afterCursor = currentLine.slice(cursorCol);

        // Don't add space after directories
        const isDirectory = item.value.endsWith("/");
        const suffix = isDirectory ? "" : " ";

        const newLine = beforePrefix + item.value + suffix + afterCursor;
        const newLines = [...lines];
        newLines[cursorLine] = newLine;

        return {
          lines: newLines,
          cursorLine,
          cursorCol: prefixStart + item.value.length + suffix.length,
        };
      }

      return provider.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix
      );
    },

    // Forward optional methods (duck typed)
    getForceFileSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number
    ): AutocompleteSuggestionResult {
      if (isBashMode(lines)) {
        const text = extractCompletionTextUpToCursor(
          lines,
          cursorLine,
          cursorCol
        );
        return getShellCompletions(text, process.cwd(), shell);
      }
      if (compatibleProvider.getForceFileSuggestions) {
        return compatibleProvider.getForceFileSuggestions(
          lines,
          cursorLine,
          cursorCol
        );
      }
      return null;
    },

    shouldTriggerFileCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number
    ): boolean {
      if (isBashMode(lines)) {
        return true;
      }
      if (compatibleProvider.shouldTriggerFileCompletion) {
        return compatibleProvider.shouldTriggerFileCompletion(
          lines,
          cursorLine,
          cursorCol
        );
      }
      return true;
    },
  };

  return wrappedProvider as unknown as AutocompleteProvider;
}

export class EnhancedEditor extends CustomEditor {
  private readonly tuiInstance: TUI;
  private readonly sessionStartTime = Date.now();
  private openingPicker = false;
  private wrappedAutocompleteProvider = false;
  private lastEscapeTime = 0;
  private submitHandler?: (text: string) => void;

  private shell: ShellInfo;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private ui: ExtensionUIContext,
    private options: EnhancedEditorOptions,
    private keybindingsManager: KeybindingsManager = keybindings
  ) {
    super(tui, theme, keybindings);
    this.tuiInstance = tui;
    this.shell = findCompletionShell();

    this.installOnSubmitInterceptor();

    this.ui.notify(
      `editor-enhancements loaded (shell: ${this.shell.type})`,
      "info"
    );
  }

  private installOnSubmitInterceptor(): void {
    Object.defineProperty(this, "onSubmit", {
      get: (): ((text: string) => void) | undefined => this.submitHandler,
      set: (fn: ((text: string) => void) | undefined) => {
        this.submitHandler = fn
          ? (text: string) => fn(this.remapCommand(text))
          : undefined;
      },
      configurable: true,
      enumerable: true,
    });
  }

  private remapCommand(text: string): string {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/")) return text;

    const match = trimmed.match(/^\/([^\s:]+)(.*)/s);
    if (!match) return text;

    const [, cmd, rest] = match;
    const target = this.options.commandRemap[cmd!];
    return target ? `/${target}${rest}` : text;
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    // Wrap once. If pi resets providers, we still want our wrapper.
    if (!this.wrappedAutocompleteProvider && provider) {
      const wrapped = wrapProviderWithShellAndAtFiltering(provider, this.shell);
      super.setAutocompleteProvider(wrapped);
      this.wrappedAutocompleteProvider = true;
      return;
    }

    super.setAutocompleteProvider(provider);
  }

  async openFilePickerAtCursor(): Promise<void> {
    const refs = await openFilePicker(this.ui);
    if (!refs) return;
    this.insertTextAtCursor(refs + " ");
    this.tuiInstance.requestRender();
  }

  async pasteClipboardRawAtCursor(): Promise<void> {
    let text: string | undefined;
    try {
      text = await Clipboard.getText();
    } catch {
      text = undefined;
    }

    if (!text) return;

    // Normalize line endings
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Insert using editor primitive (NOT bracketed paste), so it won't turn into [paste #..]
    this.insertTextAtCursor(normalized);
    this.tuiInstance.requestRender();
  }

  handleInput(data: string): void {
    if (this.openingPicker) return;

    if (this.shouldHandleConfiguredDoubleEscape(data)) {
      this.handleConfiguredDoubleEscape();
      return;
    }

    if (!this.keybindingsManager.matches(data, "interrupt")) {
      this.lastEscapeTime = 0;
    }

    // Intercept @ at token start to open picker
    if (data === "@" && this.shouldTriggerFilePicker()) {
      this.openingPicker = true;
      if (this.isShowingAutocomplete()) {
        // Escape cancels autocomplete in the base editor
        super.handleInput("\x1b");
      }
      this.openFilePickerAtCursor().finally(() => {
        this.openingPicker = false;
      });
      return;
    }

    super.handleInput(data);
  }

  private shouldHandleConfiguredDoubleEscape(data: string): boolean {
    return Boolean(
      this.options.doubleEscapeCommand &&
        this.keybindingsManager.matches(data, "interrupt") &&
        !this.isShowingAutocomplete() &&
        !this.getText().trim() &&
        this.options.canTriggerDoubleEscapeCommand()
    );
  }

  private handleConfiguredDoubleEscape(): void {
    const now = Date.now();
    if (now - this.lastEscapeTime >= DOUBLE_ESCAPE_WINDOW_MS) {
      this.lastEscapeTime = now;
      return;
    }

    this.lastEscapeTime = 0;
    const command = this.options.doubleEscapeCommand;
    if (!command || !this.onSubmit) return;

    this.onSubmit(`/${command}`);
  }

  private shouldTriggerFilePicker(): boolean {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";

    if (cursor.col === 0) return true;

    const before = line[cursor.col - 1];
    return before === " " || before === "\t" || before === undefined;
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.options.statusBar.config.enabled || width < 10 || lines.length === 0) {
      return lines;
    }

    const ctx = this.options.statusBar.getContext();
    if (!ctx) {
      return lines;
    }

    return [
      renderStatusBarLine({
        width,
        ctx,
        footerData: this.options.statusBar.getFooterData(),
        config: this.options.statusBar.config,
        sessionStartTime: this.sessionStartTime,
        theme: this.ui.theme,
      }),
      ...lines,
    ];
  }
}
