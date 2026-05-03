import * as Clipboard from "@mariozechner/clipboard";
import {
  CustomEditor,
  type ExtensionContext,
  type ExtensionUIContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
} from "@mariozechner/pi-coding-agent";
import type {
  AutocompleteProvider,
  EditorTheme,
  TUI,
} from "@mariozechner/pi-tui";

import type { StatusBarRuntimeConfig } from "../config/index.js";
import { openFilePicker } from "../file-picker/index.js";
import { findCompletionShell, type ShellInfo } from "../shell/index.js";
import { renderStatusBarLine } from "../status-bar/index.js";
import { wrapProviderWithShellAndAtFiltering } from "./autocomplete.js";
import { remapCommand } from "./command-remap.js";
import {
  consumeDoubleEscape,
  matchesInterrupt,
  shouldHandleConfiguredDoubleEscape,
} from "./double-escape.js";

export interface FixedEditorParts {
  statusLines?: string[];
  editorLines: string[];
}

interface EditorRenderCache {
  width: number;
  terminalRows: number;
  text: string;
  cursorLine: number;
  cursorCol: number;
  lines: string[];
}

interface EnhancedEditorOptions {
  getDoubleEscapeCommand: () => string | null;
  canTriggerDoubleEscapeCommand: () => boolean;
  commandRemap: Record<string, string>;
  statusBar: {
    config: StatusBarRuntimeConfig;
    getContext: () => ExtensionContext | null;
    getFooterData: () => ReadonlyFooterDataProvider | null;
  };
}

export class EnhancedEditor extends CustomEditor {
  private readonly tuiInstance: TUI;
  private readonly sessionStartTime = Date.now();
  private openingPicker = false;
  private wrappedAutocompleteProvider = false;
  private lastEscapeTime = 0;
  private submitHandler?: (text: string) => void;

  private shell: ShellInfo;
  private editorRenderCache: EditorRenderCache | null = null;

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

    this.ui.notify(`pieditor loaded (shell: ${this.shell.type})`, "info");
  }

  private installOnSubmitInterceptor(): void {
    Object.defineProperty(this, "onSubmit", {
      get: (): ((text: string) => void) | undefined => this.submitHandler,
      set: (fn: ((text: string) => void) | undefined) => {
        this.submitHandler = fn
          ? (text: string) => fn(remapCommand(text, this.options.commandRemap))
          : undefined;
      },
      configurable: true,
      enumerable: true,
    });
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

    const doubleEscapeCommand = this.options.getDoubleEscapeCommand();
    if (
      shouldHandleConfiguredDoubleEscape({
        doubleEscapeCommand,
        data,
        keybindingsManager: this.keybindingsManager,
        isShowingAutocomplete: this.isShowingAutocomplete(),
        editorText: this.getText(),
        canTriggerDoubleEscapeCommand:
          this.options.canTriggerDoubleEscapeCommand(),
      })
    ) {
      this.handleConfiguredDoubleEscape(doubleEscapeCommand);
      return;
    }

    if (!matchesInterrupt(this.keybindingsManager, data)) {
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

  private handleConfiguredDoubleEscape(command: string | null): void {
    const result = consumeDoubleEscape({
      lastEscapeTime: this.lastEscapeTime,
    });
    this.lastEscapeTime = result.nextLastEscapeTime;

    if (!result.shouldSubmit) {
      return;
    }

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

  renderFixedEditorParts(width: number): FixedEditorParts {
    const editorLines = this.renderEditorLines(width);
    const statusLine = this.renderStatusLine(width, editorLines);
    return {
      statusLines: statusLine === null ? undefined : [statusLine],
      editorLines,
    };
  }

  render(width: number): string[] {
    const parts = this.renderFixedEditorParts(width);
    return [...(parts.statusLines ?? []), ...parts.editorLines];
  }

  private renderEditorLines(width: number): string[] {
    const cursor = this.getCursor();
    const text = this.getText();
    const terminalRows = this.getTerminalRows();
    const cache = this.editorRenderCache;
    if (
      cache &&
      cache.width === width &&
      cache.terminalRows === terminalRows &&
      cache.text === text &&
      cache.cursorLine === cursor.line &&
      cache.cursorCol === cursor.col &&
      !this.isShowingAutocomplete()
    ) {
      return cache.lines;
    }

    const lines = super.render(width);
    this.editorRenderCache = this.isShowingAutocomplete()
      ? null
      : {
          width,
          terminalRows,
          text,
          cursorLine: cursor.line,
          cursorCol: cursor.col,
          lines,
        };
    return lines;
  }

  private getTerminalRows(): number {
    const terminal = Reflect.get(this.tuiInstance, "terminal");
    const rows = terminal ? Reflect.get(terminal, "rows") : undefined;
    return typeof rows === "number" && Number.isFinite(rows) ? rows : 0;
  }

  private renderStatusLine(
    width: number,
    editorLines: string[]
  ): string | null {
    if (
      !this.options.statusBar.config.enabled ||
      width < 10 ||
      editorLines.length === 0
    ) {
      return null;
    }

    const ctx = this.options.statusBar.getContext();
    if (!ctx) {
      return null;
    }

    return renderStatusBarLine({
      width,
      ctx,
      footerData: this.options.statusBar.getFooterData(),
      config: this.options.statusBar.config,
      sessionStartTime: this.sessionStartTime,
      theme: this.ui.theme,
    });
  }
}
