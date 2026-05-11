import { describe, expect, it } from "bun:test";

import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { renderAmpEditorChrome } from "./editor/amp-chrome";
import { matchesInterrupt } from "./editor/double-escape";
import { EnhancedEditor } from "./enhanced-editor";

const ESC = String.fromCharCode(27);
const TOP_SCROLL_COLOR_PATTERN = new RegExp(
  `${ESC}\\[2m─── ↑ 2 more\\s+${ESC}\\[0m`,
  "u"
);
const BOTTOM_SCROLL_COLOR_PATTERN = new RegExp(
  `${ESC}\\[2m─── ↓ 3 more\\s+${ESC}\\[0m`,
  "u"
);

function createEditor(
  commandRemap: Record<string, string>,
  options?: {
    statusBarEnabled?: boolean;
    statusBarContext?: ExtensionContext | null;
    statusBarFooterData?: ReadonlyFooterDataProvider | null;
    editorChromeStyle?: "classic" | "amp";
    doubleEscapeCommand?: string | null;
    getDoubleEscapeCommand?: () => string | null;
    canTriggerDoubleEscapeCommand?: () => boolean;
    interruptMatches?: boolean;
    borderColor?: (value: string) => string;
  }
) {
  const tui = {
    requestRender() {
      /* noop */
    },
    terminal: {
      rows: 24,
    },
  } as any;

  const theme = {
    borderColor: options?.borderColor ?? ((value: string) => value),
    selectList: {},
  } as any;

  const keybindings = {
    matches(_data: string, key: string) {
      return key === "app.interrupt"
        ? Boolean(options?.interruptMatches)
        : false;
    },
  } as any;

  const ui = {
    notify() {
      /* noop */
    },
    theme: {
      fg(_color: string, text: string) {
        return text;
      },
    },
  } as any;

  return new EnhancedEditor(tui, theme, keybindings, ui, {
    getDoubleEscapeCommand:
      options?.getDoubleEscapeCommand ??
      (() => options?.doubleEscapeCommand ?? null),
    canTriggerDoubleEscapeCommand:
      options?.canTriggerDoubleEscapeCommand ?? (() => false),
    commandRemap,
    editorChrome: {
      style: options?.editorChromeStyle ?? "classic",
    },
    statusBar: {
      config: {
        enabled: options?.statusBarEnabled ?? false,
        preset: "default",
      },
      getContext: () => options?.statusBarContext ?? null,
      getFooterData: () => options?.statusBarFooterData ?? null,
    },
  });
}

function createStatusBarContext(): ExtensionContext {
  return {
    model: {
      id: "test-model",
      name: "test-model",
      reasoning: false,
      contextWindow: 200_000,
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
        tokens: 25_000,
        contextWindow: 200_000,
        percent: 12.5,
      };
    },
  } as unknown as ExtensionContext;
}

function createStatusBarFooterData(
  getExtensionStatuses: () => ReadonlyMap<string, string> = () => new Map()
): ReadonlyFooterDataProvider {
  return {
    getGitBranch() {
      return "main";
    },
    getExtensionStatuses,
    getAvailableProviderCount() {
      return 0;
    },
    onBranchChange() {
      return () => {
        /* noop */
      };
    },
  };
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

  it("preserves keybindings manager method binding for interrupt checks", () => {
    const keybindings = {
      keysById: new Map([["app.interrupt", ["escape"]]]),
      matches(_data: string, key: string) {
        return this.keysById.has(key);
      },
    };

    expect(matchesInterrupt(keybindings as any, "\x1b")).toBe(true);
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

  it("submits the configured command on double escape when idle and editor is empty", () => {
    const submitted: string[] = [];
    const editor = createEditor(
      {},
      {
        doubleEscapeCommand: "anycopy",
        canTriggerDoubleEscapeCommand: () => true,
        interruptMatches: true,
      }
    );

    editor.onSubmit = (text) => {
      submitted.push(text);
    };

    editor.handleInput("\x1b");
    editor.handleInput("\x1b");

    expect(submitted).toEqual(["/anycopy"]);
  });

  it("supports commands that become available after editor attachment", () => {
    const submitted: string[] = [];
    let availableCommand: string | null = null;
    const editor = createEditor(
      {},
      {
        getDoubleEscapeCommand: () => availableCommand,
        canTriggerDoubleEscapeCommand: () => true,
        interruptMatches: true,
      }
    );

    editor.onSubmit = (text) => {
      submitted.push(text);
    };

    editor.handleInput("\x1b");
    editor.handleInput("\x1b");
    expect(submitted).toEqual([]);

    availableCommand = "anycopy";
    editor.handleInput("\x1b");
    editor.handleInput("\x1b");

    expect(submitted).toEqual(["/anycopy"]);
  });

  it("renders Amp chrome with rounded borders, side padding, labels, and minimum body height", () => {
    const lines = renderAmpEditorChrome({
      width: 20,
      editorLines: ["────────────────────", "body", "────────────────────"],
      labels: {
        topLeftContent: " top ",
        topRightContent: " right ",
        bottomContent: " bottom ",
      },
    });

    expect(lines).toEqual([
      "╭ top ────── right ╮",
      "│ body             │",
      "│                  │",
      "│                  │",
      "╰────────── bottom ╯",
    ]);
  });

  it("renders autocomplete and popup lines outside the Amp frame", () => {
    const lines = renderAmpEditorChrome({
      width: 16,
      editorLines: ["────────────────", "body", "────────────────", "popup"],
      labels: { topLeftContent: "", topRightContent: "", bottomContent: "" },
      minBodyHeight: 1,
    });

    expect(lines).toEqual([
      "╭──────────────╮",
      "│ body         │",
      "╰──────────────╯",
      "popup",
    ]);
  });

  it("clips Amp body lines without adding truncation ellipses", () => {
    const lines = renderAmpEditorChrome({
      width: 12,
      editorLines: ["────────────", "very long body text", "────────────"],
      labels: { topLeftContent: "", topRightContent: "", bottomContent: "" },
      minBodyHeight: 1,
    });

    expect(lines[1]).toBe("│ very lon │");
    expect(lines[1]).not.toContain("...");
  });

  it("colors Amp frame glyphs without recoloring status labels or body text", () => {
    const color = (value: string) => `\u001b[2m${value}\u001b[0m`;
    const body = "body\u001b[31mred\u001b[0m";
    const lines = renderAmpEditorChrome({
      width: 20,
      editorLines: ["────────────────────", body, "────────────────────"],
      labels: {
        topLeftContent: " top ",
        topRightContent: "",
        bottomContent: " bottom ",
      },
      minBodyHeight: 1,
      borderColor: color,
    });

    expect(lines[0]).toContain(color("╭"));
    expect(lines[0]).toContain(" top ");
    expect(lines[0]).not.toContain(color(" top "));
    expect(lines[1]).toContain(color("│"));
    expect(lines[1]).toContain(body);
    expect(lines[1]).not.toContain(color(body));
  });

  it("falls back to classic render output for narrow Amp widths", () => {
    const editorLines = ["───────────", "body", "───────────"];

    expect(
      renderAmpEditorChrome({
        width: 11,
        editorLines,
        labels: {
          topLeftContent: "top",
          topRightContent: "",
          bottomContent: "bottom",
        },
      })
    ).toBe(editorLines);
  });

  it("prioritizes native scroll indicators over Amp status labels and colors them as borders", () => {
    const color = (value: string) => `\u001b[2m${value}\u001b[0m`;
    const lines = renderAmpEditorChrome({
      width: 24,
      editorLines: ["─── ↑ 2 more ─────────", "body", "─── ↓ 3 more ─────────"],
      labels: {
        topLeftContent: "top",
        topRightContent: "right",
        bottomContent: "bottom",
      },
      minBodyHeight: 1,
      borderColor: color,
    });

    expect(lines[0]).toMatch(TOP_SCROLL_COLOR_PATTERN);
    expect(lines[0]).not.toContain("top");
    expect(lines[0]).not.toContain("right");
    expect(lines[2]).toMatch(BOTTOM_SCROLL_COLOR_PATTERN);
    expect(lines[2]).not.toContain("bottom");
  });

  it("uses Amp chrome in EnhancedEditor when configured", () => {
    const borderColor = (value: string) => `\u001b[2m${value}\u001b[0m`;
    const editor = createEditor(
      {},
      {
        editorChromeStyle: "amp",
        statusBarEnabled: true,
        statusBarContext: createStatusBarContext(),
        statusBarFooterData: createStatusBarFooterData(),
        borderColor,
      }
    );

    const lines = editor.render(60);

    expect(lines[0]).toStartWith(borderColor("╭"));
    expect(lines[0]).toContain("test-model");
    expect(lines[0]).not.toContain(borderColor("test-model"));
    expect(lines.at(-1)).toContain("main");
    expect(lines.some((line) => line.startsWith(`${borderColor("│")} `))).toBe(
      true
    );
  });

  it("wraps long Amp editor input at the framed body width", () => {
    const editor = createEditor(
      {},
      {
        editorChromeStyle: "amp",
      }
    );
    editor.setText("0123456789abcdef");

    const lines = editor.render(16);

    expect(lines).toContain("│ 0123456789a  │");
    expect(lines.some((line) => line.includes("bcdef"))).toBe(true);
  });

  it("keeps Amp frame with an empty top border when status bar is disabled", () => {
    const editor = createEditor(
      {},
      {
        editorChromeStyle: "amp",
        statusBarEnabled: false,
        statusBarContext: createStatusBarContext(),
      }
    );

    const lines = editor.render(20);

    expect(lines[0]).toBe("╭──────────────────╮");
  });

  it("keeps the original top border below the status bar", () => {
    const editor = createEditor(
      {},
      {
        statusBarEnabled: true,
        statusBarContext: createStatusBarContext(),
        statusBarFooterData: createStatusBarFooterData(),
      }
    );

    const width = 40;
    const lines = editor.render(width);

    expect(lines[0]).toContain("test-model");
    expect(lines[1]).toBe("─".repeat(width));
  });

  it("uses Amp chrome for fixed editor parts without separate status lines", () => {
    const editor = createEditor(
      {},
      {
        editorChromeStyle: "amp",
        statusBarEnabled: true,
        statusBarContext: createStatusBarContext(),
        statusBarFooterData: createStatusBarFooterData(),
      }
    );

    const parts = editor.renderFixedEditorParts(60);

    expect(parts.statusLines).toBeUndefined();
    expect(parts.editorLines[0]).toStartWith("╭");
    expect(parts.editorLines[0]).toContain("test-model");
    expect(parts.editorLines.at(-1)).toContain("main");
  });

  it("updates fixed editor status without rerendering base editor lines", () => {
    let widgetStatus = "widget-a";
    let baseRenderCount = 0;
    const originalRender = CustomEditor.prototype.render;
    CustomEditor.prototype.render = function renderWithCount(width: number) {
      baseRenderCount += 1;
      return originalRender.call(this, width);
    };

    try {
      const editor = createEditor(
        {},
        {
          statusBarEnabled: true,
          statusBarContext: createStatusBarContext(),
          statusBarFooterData: createStatusBarFooterData(
            () => new Map([["custom", widgetStatus]])
          ),
        }
      );
      const width = 140;

      const first = editor.renderFixedEditorParts(width);
      widgetStatus = "widget-b";
      const second = editor.renderFixedEditorParts(width);

      expect(baseRenderCount).toBe(1);
      expect(first.statusLines?.[0]).toContain("widget-a");
      expect(second.statusLines?.[0]).toContain("widget-b");
      expect(second.editorLines).toEqual(first.editorLines);
    } finally {
      CustomEditor.prototype.render = originalRender;
    }
  });

  it("rerenders fixed editor lines when terminal height changes", () => {
    let baseRenderCount = 0;
    const originalRender = CustomEditor.prototype.render;
    CustomEditor.prototype.render = function renderWithCount(width: number) {
      baseRenderCount += 1;
      return originalRender.call(this, width);
    };

    try {
      const editor = createEditor({});
      const tui = Reflect.get(editor, "tuiInstance") as {
        terminal: { rows: number };
      };
      const width = 40;

      editor.renderFixedEditorParts(width);
      tui.terminal.rows = 12;
      editor.renderFixedEditorParts(width);

      expect(baseRenderCount).toBe(2);
    } finally {
      CustomEditor.prototype.render = originalRender;
    }
  });

  it("rerenders fixed editor lines when editor text changes", () => {
    const editor = createEditor({});
    const width = 40;

    const first = editor.renderFixedEditorParts(width);
    editor.setText("changed text");
    const second = editor.renderFixedEditorParts(width);

    expect(second.editorLines).not.toEqual(first.editorLines);
    expect(second.editorLines.join("\n")).toContain("changed text");
  });

  it("skips the status bar once the context is detached", () => {
    const options = {
      statusBarEnabled: true,
      statusBarContext: createStatusBarContext(),
      statusBarFooterData: createStatusBarFooterData(),
    };

    const editor = createEditor({}, options);
    options.statusBarContext = null;

    const width = 40;
    const lines = editor.render(width);
    const detachedEditor = createEditor(
      {},
      {
        statusBarEnabled: true,
        statusBarContext: null,
        statusBarFooterData: options.statusBarFooterData,
      }
    );

    expect(lines).toEqual(detachedEditor.render(width));
    expect(lines.join("\n")).not.toContain("test-model");
  });
});
