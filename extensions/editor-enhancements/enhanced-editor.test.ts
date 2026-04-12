import { describe, expect, it } from "bun:test";

import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { EnhancedEditor } from "./enhanced-editor";

function createEditor(commandRemap: Record<string, string>) {
  const tui = {
    requestRender() {},
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
  } as any;

  return new EnhancedEditor(tui, theme, keybindings, ui, {
    doubleEscapeCommand: null,
    canTriggerDoubleEscapeCommand: () => false,
    commandRemap,
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
});
