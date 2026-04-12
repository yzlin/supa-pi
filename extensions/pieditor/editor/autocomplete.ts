import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@mariozechner/pi-tui";

import {
  type CompletionResult,
  getShellCompletions,
  type ShellInfo,
} from "../shell/index.js";

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

export function isAtCompletionContext(
  lines: string[],
  cursorLine: number,
  cursorCol: number
): boolean {
  const line = lines[cursorLine] ?? "";
  const beforeCursor = line.slice(0, cursorCol);
  return Boolean(beforeCursor.match(/(?:^|[\s])@[^\s]*$/));
}

export function isBashMode(lines: string[]): boolean {
  const text = lines.join("\n").trimStart();
  return text.startsWith("!") || text.startsWith("!!");
}

export function extractCompletionTextUpToCursor(
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

function getBashSuggestions(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  shell: ShellInfo
): CompletionResult | null {
  const text = extractCompletionTextUpToCursor(lines, cursorLine, cursorCol);
  return getShellCompletions(text, process.cwd(), shell);
}

export function wrapProviderWithShellAndAtFiltering(
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
      if (isAtCompletionContext(lines, cursorLine, cursorCol)) {
        return null;
      }

      if (isBashMode(lines)) {
        const result = getBashSuggestions(lines, cursorLine, cursorCol, shell);
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

    getForceFileSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number
    ): AutocompleteSuggestionResult {
      if (isBashMode(lines)) {
        return getBashSuggestions(lines, cursorLine, cursorCol, shell);
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
