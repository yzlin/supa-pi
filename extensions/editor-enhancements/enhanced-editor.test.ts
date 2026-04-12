import { describe, expect, it } from "bun:test";

import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { EnhancedEditor } from "./enhanced-editor";

function createEditor(
  commandRemap: Record<string, string>,
  options?: {
    statusBarEnabled?: boolean;
    statusBarContext?: ExtensionContext | null;
    statusBarFooterData?: ReadonlyFooterDataProvider | null;
  }
) {
  const tui = {
    requestRender() {},
    terminal: {
      rows: 24,
    },
  } as any;

  const theme = {
    borderColor: (value: string) => value,
    selectList: {},
  } as any;

  const keybindings = {
    matches() {
      return false;
    },
  } as any;

  const ui = {
    notify() {},
    theme: {
      fg(_color: string, text: string) {
        return text;
      },
    },
  } as any;

  return new EnhancedEditor(tui, theme, keybindings, ui, {
    doubleEscapeCommand: null,
    canTriggerDoubleEscapeCommand: () => false,
    commandRemap,
    statusBar: {
      enabled: options?.statusBarEnabled ?? false,
      preset: "default",
      getContext: () => options?.statusBarContext ?? null,
      getFooterData: () => options?.statusBarFooterData ?? null,
    },
  });
}

describe("EnhancedEditor command remap", () => {
  it("remaps slash commands on direct onSubmit invocation", () => {
    const editor = createEditor({ tree: "anycopy" });
    let submitted = "";

    editor.onSubmit = (text) => {
      submitted = text;
    };

    editor.onSubmit?.("/tree");

    expect(submitted).toBe("/anycopy");
  });

  it("remaps slash commands at submit time", () => {
    const editor = createEditor({ tree: "anycopy" });
    const submitted: string[] = [];

    editor.onSubmit = (text) => {
      submitted.push(text);
    };

    editor.setText("/tree");
    (editor as any).submitValue();

    expect(submitted).toEqual(["/anycopy"]);
    expect(editor.getText()).toBe("");
  });

  it("preserves command arguments when remapping", () => {
    const editor = createEditor({ tree: "anycopy" });
    let submitted = "";

    editor.onSubmit = (text) => {
      submitted = text;
    };

    editor.setText("/tree src --depth 2");
    (editor as any).submitValue();

    expect(submitted).toBe("/anycopy src --depth 2");
  });

  it("forwards autocomplete request options to the wrapped provider", async () => {
    const editor = createEditor({});
    const signal = new AbortController().signal;
    let receivedOptions:
      | {
          signal: AbortSignal;
          force?: boolean;
        }
      | undefined;

    editor.setAutocompleteProvider({
      getSuggestions(
        _lines: string[],
        _cursorLine: number,
        _cursorCol: number,
        options?: { signal: AbortSignal; force?: boolean }
      ) {
        receivedOptions = options;
        return Promise.resolve(null);
      },
      applyCompletion(
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        _item: AutocompleteItem,
        _prefix: string
      ) {
        return { lines, cursorLine, cursorCol };
      },
    } as any);

    await (editor as any).autocompleteProvider.getSuggestions(["/tree"], 0, 5, {
      signal,
      force: true,
    });

    expect(receivedOptions).toEqual({ signal, force: true });
  });

  it("keeps the original top border below the status bar", () => {
    const statusBarContext = {
      model: {
        id: "test-model",
        name: "test-model",
        reasoning: false,
        contextWindow: 200000,
      },
      modelRegistry: {},
      sessionManager: {
        getBranch() {
          return [];
        },
        getSessionId() {
          return "session-12345678";
        },
      },
      getContextUsage() {
        return {
          tokens: 25000,
          contextWindow: 200000,
          percent: 12.5,
        };
      },
    } as unknown as ExtensionContext;

    const statusBarFooterData = {
      getGitBranch() {
        return "main";
      },
      getExtensionStatuses() {
        return new Map();
      },
      getAvailableProviderCount() {
        return 0;
      },
      onBranchChange() {
        return () => {};
      },
    } satisfies ReadonlyFooterDataProvider;

    const editor = createEditor(
      {},
      {
        statusBarEnabled: true,
        statusBarContext,
        statusBarFooterData,
      }
    );

    const width = 40;
    const lines = editor.render(width);

    expect(lines[0]).toContain("test-model");
    expect(lines[1]).toBe("─".repeat(width));
  });
});
