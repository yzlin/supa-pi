/**
 * File Picker Extension
 *
 * Replaces the built-in @ file picker with an enhanced file browser.
 * Selected files are attached to the prompt as context.
 *
 * Features:
 * - @ shortcut opens file browser (replaces built-in)
 * - Resume-picker-style search input editing
 * - Right arrow toggles files / enters directories when the search box is empty
 * - Ctrl+N / Ctrl+P move down / up in picker lists
 * - Shift+Tab to toggle options panel (gitignore, hidden files)
 * - Configurable Tab completion modes: segment or best-match
 * - Fuzzy search and glob patterns
 * - Git-aware file listing (respects .gitignore)
 * - Selected files injected as context on prompt submit
 *
 * Based on codemap extension by @kcosr
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  getLanguageFromPath,
  highlightCode,
  type ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

import { loadConfig } from "./config.js";
import { createPickerState } from "./file-picker-config.js";
import {
  getCwdRoot,
  isGitRepo,
  isWithinCwd,
  listAllFiles,
  listDirectoryWithGit,
  listGitFiles,
} from "./file-picker-data.js";
import {
  filterEntries,
  isGlobPattern,
  resolveScopedFuzzyQuery,
  scoreScopedEntry,
  stripLeadingSlash,
  withQuerySlash,
} from "./file-picker-filter.js";
import { loadPreviewData } from "./file-picker-preview.js";
import type {
  BrowserOption,
  CompletionEntry,
  FileBrowserAction,
  FileEntry,
  SelectedPath,
} from "./file-picker-types.js";

const config = loadConfig().filePicker;
const state = createPickerState(config);

// ═══════════════════════════════════════════════════════════════════════════
// Theming
// ═══════════════════════════════════════════════════════════════════════════

interface PaletteTheme {
  border: string;
  title: string;
  selected: string;
  selectedText: string;
  directory: string;
  checked: string;
  searchIcon: string;
  placeholder: string;
  hint: string;
}

const DEFAULT_THEME: PaletteTheme = {
  border: "2",
  title: "2",
  selected: "36",
  selectedText: "36",
  directory: "34",
  checked: "32",
  searchIcon: "2",
  placeholder: "2;3",
  hint: "2",
};

function loadTheme(): PaletteTheme {
  const themePath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "extensions",
    "file-picker",
    "theme.json"
  );
  try {
    if (fs.existsSync(themePath)) {
      const content = fs.readFileSync(themePath, "utf-8");
      const custom = JSON.parse(content) as Partial<PaletteTheme>;
      return { ...DEFAULT_THEME, ...custom };
    }
  } catch {
    // Ignore errors
  }
  return DEFAULT_THEME;
}

function fg(code: string, text: string): string {
  if (!code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const paletteTheme = loadTheme();

function padVisibleText(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function truncateVisibleText(text: string, maxWidth: number): string {
  return truncateToWidth(text, maxWidth, "…");
}

export function highlightPreviewLine(line: string, lang?: string): string {
  if (!lang) return line;

  const match = line.match(/^(\s*\d+\s│ )(.*)$/u);
  if (!match) return line;

  const [, prefix, code] = match;
  try {
    const [highlighted = code] = highlightCode(code, lang);
    return `${prefix}${highlighted}`;
  } catch {
    return line;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// File Browser Component
// ═══════════════════════════════════════════════════════════════════════════

export class FileBrowserComponent {
  readonly width = 120;
  private readonly maxVisible = 10;
  private readonly overlayHeightRatio = 0.94;
  private readonly minPreviewPaneHeight = 11;
  private cwdRoot: string;
  private currentDir: string;
  private allEntries: FileEntry[];
  private allFilesRecursive: FileEntry[];
  private filtered: FileEntry[];
  private selected = 0;
  private readonly searchInput: Input;
  private query = "";
  private isSearchMode = false;
  private selectedPaths: Map<string, boolean>; // path -> isDirectory
  private rootParentView = false;
  private inGitRepo: boolean;
  private gitFiles: Set<string> | null = null;
  private focusOnOptions = false;
  private selectedOption = 0;
  private options: BrowserOption[];
  private done: (action: FileBrowserAction) => void;

  constructor(done: (action: FileBrowserAction) => void) {
    this.done = done;
    this.cwdRoot = getCwdRoot();
    this.currentDir = this.cwdRoot;
    this.selectedPaths = new Map();
    this.searchInput = new Input();
    this.searchInput.focused = true;
    this.inGitRepo = isGitRepo(this.cwdRoot);

    this.options = [
      {
        id: "gitignore",
        label: "Respect .gitignore",
        enabled: state.respectGitignore,
        visible: () => this.inGitRepo,
      },
      {
        id: "skipHidden",
        label: "Skip hidden files",
        enabled: state.skipHidden,
        visible: () => true,
      },
      {
        id: "allowFolderSelection",
        label: "Allow folder selection",
        enabled: state.allowFolderSelection,
        visible: () => true,
      },
    ];

    this.rebuildFileLists();
  }

  private getOption(id: string): BrowserOption | undefined {
    return this.options.find((o) => o.id === id);
  }

  private getVisibleOptions(): BrowserOption[] {
    return this.options.filter((o) => o.visible());
  }

  private setSearchQuery(
    query: string,
    cursor: "preserve" | "end" = "preserve"
  ): void {
    this.searchInput.setValue(query);
    if (cursor === "end") {
      (this.searchInput as unknown as { cursor: number }).cursor = query.length;
    }
    this.query = query;
  }

  private handleSearchInput(data: string): void {
    const previousQuery = this.query;
    this.searchInput.handleInput(data);
    this.query = this.searchInput.getValue();
    if (this.query !== previousQuery) {
      this.updateFilter();
    }
  }

  private rebuildFileLists(): void {
    const respectGitignore = this.getOption("gitignore")?.enabled ?? false;
    const skipHidden = this.getOption("skipHidden")?.enabled ?? true;

    if (this.inGitRepo && respectGitignore) {
      const gitEntries = listGitFiles(this.cwdRoot);
      this.gitFiles = new Set(gitEntries.map((e) => e.relativePath));
      this.allFilesRecursive = gitEntries;
    } else {
      this.gitFiles = null;
      this.allFilesRecursive = listAllFiles(
        this.cwdRoot,
        this.cwdRoot,
        [],
        skipHidden,
        config.skipPatterns
      );
    }

    this.allEntries = this.listCurrentDirectory();
    this.updateFilter();
  }

  private listCurrentDirectory(): FileEntry[] {
    if (this.rootParentView) {
      return [
        {
          name: path.basename(this.cwdRoot),
          isDirectory: true,
          relativePath: ".",
        },
      ];
    }

    const skipHidden = this.getOption("skipHidden")?.enabled ?? true;
    const entries = listDirectoryWithGit(
      this.currentDir,
      this.cwdRoot,
      this.gitFiles,
      skipHidden,
      config.skipPatterns
    );

    entries.unshift({
      name: "..",
      isDirectory: true,
      relativePath: "..",
    });

    return entries;
  }

  private isUpEntry(entry: FileEntry): boolean {
    return entry.name === ".." && entry.relativePath === "..";
  }

  private navigateTo(dir: string): void {
    if (!isWithinCwd(dir, this.cwdRoot)) return;

    this.rootParentView = false;
    this.currentDir = dir;
    this.allEntries = this.listCurrentDirectory();
    this.setSearchQuery("");
    this.isSearchMode = false;
    this.filtered = this.allEntries;
    this.selected = 0;
  }

  private goUp(): boolean {
    if (this.rootParentView) return false;

    if (this.currentDir === this.cwdRoot) {
      this.rootParentView = true;
      this.allEntries = this.listCurrentDirectory();
      this.setSearchQuery("");
      this.isSearchMode = false;
      this.filtered = this.allEntries;
      this.selected = 0;
      return true;
    }

    const parentDir = path.dirname(this.currentDir);
    if (isWithinCwd(parentDir, this.cwdRoot)) {
      this.navigateTo(parentDir);
      return true;
    }
    return false;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "shift+tab")) {
      const visibleOptions = this.getVisibleOptions();
      if (visibleOptions.length > 0) {
        this.focusOnOptions = !this.focusOnOptions;
        this.searchInput.focused = !this.focusOnOptions;
        if (this.focusOnOptions) this.selectedOption = 0;
      }
      return;
    }

    if (this.focusOnOptions) {
      this.handleOptionsInput(data);
    } else {
      this.handleBrowserInput(data);
    }
  }

  private handleOptionsInput(data: string): void {
    const visibleOptions = this.getVisibleOptions();
    const currentOption = visibleOptions[this.selectedOption];

    if (matchesKey(data, "escape")) {
      this.focusOnOptions = false;
      this.searchInput.focused = true;
      return;
    }

    if (
      matchesKey(data, "up") ||
      matchesKey(data, "left") ||
      matchesKey(data, "ctrl+p")
    ) {
      if (visibleOptions.length > 0) {
        this.selectedOption =
          this.selectedOption === 0
            ? visibleOptions.length - 1
            : this.selectedOption - 1;
      }
      return;
    }

    if (
      matchesKey(data, "down") ||
      matchesKey(data, "right") ||
      matchesKey(data, "ctrl+n")
    ) {
      if (visibleOptions.length > 0) {
        this.selectedOption =
          this.selectedOption === visibleOptions.length - 1
            ? 0
            : this.selectedOption + 1;
      }
      return;
    }

    if (data === " " || matchesKey(data, "return")) {
      if (currentOption) {
        currentOption.enabled = !currentOption.enabled;
        // Sync to global state
        if (currentOption.id === "gitignore") {
          state.respectGitignore = currentOption.enabled;
        } else if (currentOption.id === "skipHidden") {
          state.skipHidden = currentOption.enabled;
        } else if (currentOption.id === "allowFolderSelection") {
          state.allowFolderSelection = currentOption.enabled;
          if (!currentOption.enabled) {
            for (const [
              selectedPath,
              isDirectory,
            ] of this.selectedPaths.entries()) {
              if (isDirectory) {
                this.selectedPaths.delete(selectedPath);
              }
            }
          }
        }
        this.rebuildFileLists();
      }
    }
  }

  private getSelectedPathsArray(): SelectedPath[] {
    return Array.from(this.selectedPaths.entries()).map(([p, isDir]) => ({
      path: p,
      isDirectory: isDir,
    }));
  }

  private handleBrowserInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (!this.goUp()) {
        this.done({ action: "confirm", paths: this.getSelectedPathsArray() });
      }
      return;
    }

    if (matchesKey(data, "return")) {
      const entry = this.filtered[this.selected];
      if (entry) {
        if (entry.name === "..") {
          this.goUp();
        } else if (entry.isDirectory && !state.allowFolderSelection) {
          this.navigateTo(path.join(this.cwdRoot, entry.relativePath));
        } else {
          const paths = this.getSelectedPathsArray();
          const selected = {
            path: entry.relativePath,
            isDirectory: entry.isDirectory,
          };
          if (!this.selectedPaths.has(entry.relativePath)) {
            paths.push(selected);
          }
          this.done({ action: "select", selected, paths });
        }
      }
      return;
    }

    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      if (this.filtered.length > 0) {
        this.selected =
          this.selected === 0 ? this.filtered.length - 1 : this.selected - 1;
      }
      return;
    }

    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      if (this.filtered.length > 0) {
        this.selected =
          this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
      }
      return;
    }

    if (matchesKey(data, "tab")) {
      this.completeQueryToClosestMatch();
      return;
    }

    if (data === " ") {
      const entry = this.filtered[this.selected];
      if (entry && !this.isUpEntry(entry)) {
        if (entry.isDirectory && !state.allowFolderSelection) {
          this.navigateTo(path.join(this.cwdRoot, entry.relativePath));
        } else if (this.selectedPaths.has(entry.relativePath)) {
          this.selectedPaths.delete(entry.relativePath);
        } else {
          this.selectedPaths.set(entry.relativePath, entry.isDirectory);
        }
      }
      return;
    }

    if (matchesKey(data, "left") && this.query.length === 0) {
      this.goUp();
      return;
    }

    if (matchesKey(data, "right") && this.query.length === 0) {
      const entry = this.filtered[this.selected];
      if (entry && !this.isUpEntry(entry)) {
        if (entry.isDirectory) {
          this.navigateTo(path.join(this.cwdRoot, entry.relativePath));
        } else if (this.selectedPaths.has(entry.relativePath)) {
          this.selectedPaths.delete(entry.relativePath);
        } else {
          this.selectedPaths.set(entry.relativePath, entry.isDirectory);
        }
      }
      return;
    }

    if (matchesKey(data, "backspace") && this.query.length === 0) {
      this.goUp();
      return;
    }

    this.handleSearchInput(data);
  }

  private completeQueryToClosestMatch(): void {
    if (!this.query.trim()) return;

    const match =
      config.tabCompletionMode === "bestMatch"
        ? this.findBestMatchCompletion(this.query)
        : this.findSegmentCompletionMatch(this.query);
    if (!match) return;

    if (config.tabCompletionMode === "bestMatch") {
      if (match.path === this.query) return;
      this.setSearchQuery(match.path, "end");
      this.updateFilter(match.path);
      return;
    }

    const completedQuery = this.completeOneWordPart(this.query, match.path);
    if (!completedQuery || completedQuery === this.query) return;

    this.setSearchQuery(completedQuery, "end");
    this.updateFilter();
  }

  private getCompletionEntries(query: string): CompletionEntry[] {
    return this.allFilesRecursive.map((entry) => {
      const displayPath = withQuerySlash(entry.relativePath, query);
      return {
        path: entry.isDirectory ? `${displayPath}/` : displayPath,
        isDirectory: entry.isDirectory,
      };
    });
  }

  private findSegmentCompletionMatch(query: string): CompletionEntry | null {
    const entries = this.getCompletionEntries(query);
    return this.findPrefixCompletionMatch(query, entries);
  }

  private findBestMatchCompletion(query: string): CompletionEntry | null {
    const entries = this.getCompletionEntries(query);
    return (
      this.findDirectPrefixCompletionMatch(query, entries) ??
      this.findScopedFuzzyCompletionMatch(query, entries) ??
      this.findNormalizedPrefixCompletionMatch(query, entries)
    );
  }

  private findPrefixCompletionMatch(
    query: string,
    entries: CompletionEntry[]
  ): CompletionEntry | null {
    return (
      this.findDirectPrefixCompletionMatch(query, entries) ??
      this.findNormalizedPrefixCompletionMatch(query, entries)
    );
  }

  private findDirectPrefixCompletionMatch(
    query: string,
    entries: CompletionEntry[]
  ): CompletionEntry | null {
    const queryLower = query.toLowerCase();
    const matches = entries
      .filter((entry) => entry.path.toLowerCase().startsWith(queryLower))
      .sort((a, b) => this.compareCompletionEntries(a, b));
    return matches[0] ?? null;
  }

  private findNormalizedPrefixCompletionMatch(
    query: string,
    entries: CompletionEntry[]
  ): CompletionEntry | null {
    const normalizedQuery = this.normalizeAlnum(query);
    if (!normalizedQuery) return null;

    const matches = entries
      .filter((entry) =>
        this.normalizeAlnum(entry.path).startsWith(normalizedQuery)
      )
      .sort((a, b) => this.compareCompletionEntries(a, b));
    return matches[0] ?? null;
  }

  private findScopedFuzzyCompletionMatch(
    query: string,
    entries: CompletionEntry[]
  ): CompletionEntry | null {
    const scopedQuery = resolveScopedFuzzyQuery(query);
    if (!scopedQuery) return null;

    const matches = entries
      .map((entry) => ({
        entry,
        score: stripLeadingSlash(entry.path).startsWith(scopedQuery.basePath)
          ? scoreScopedEntry(entry.path, scopedQuery.query, entry.isDirectory)
          : 0,
      }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || this.compareCompletionEntries(a.entry, b.entry)
      );
    return matches[0]?.entry ?? null;
  }

  private compareCompletionEntries(
    a: CompletionEntry,
    b: CompletionEntry
  ): number {
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.path.localeCompare(b.path);
  }

  private completeOneWordPart(query: string, completionPath: string): string {
    const queryLower = query.toLowerCase();
    const completionLower = completionPath.toLowerCase();

    if (completionLower.startsWith(queryLower)) {
      const end = this.nextWordPartBoundary(completionPath, query.length);
      return completionPath.slice(0, end);
    }

    const longestCommonPrefix = this.commonPrefixLength(
      queryLower,
      completionLower
    );
    if (longestCommonPrefix === 0) return query;

    const end = this.nextWordPartBoundary(completionPath, longestCommonPrefix);
    return completionPath.slice(0, end);
  }

  private nextWordPartBoundary(text: string, start: number): number {
    if (start >= text.length) return text.length;

    let index = start;
    if (this.isAlphaNumeric(text[index])) {
      while (index < text.length && this.isAlphaNumeric(text[index])) {
        index += 1;
      }
      if (index < text.length && this.isWordSeparator(text[index])) {
        index += 1;
      }
      return index;
    }

    while (index < text.length && this.isWordSeparator(text[index])) {
      index += 1;
    }
    while (index < text.length && this.isAlphaNumeric(text[index])) {
      index += 1;
    }
    if (index < text.length && this.isWordSeparator(text[index])) {
      index += 1;
    }
    return index;
  }

  private isAlphaNumeric(char: string | undefined): boolean {
    return char !== undefined && /[a-zA-Z0-9]/.test(char);
  }

  private isWordSeparator(char: string | undefined): boolean {
    return char !== undefined && /[\/_.\-]/.test(char);
  }

  private normalizeAlnum(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  private commonPrefixLength(left: string, right: string): number {
    let index = 0;
    const maxLength = Math.min(left.length, right.length);
    while (index < maxLength && left[index] === right[index]) {
      index += 1;
    }
    return index;
  }

  private updateFilter(preferredPath?: string): void {
    if (this.query.trim()) {
      this.isSearchMode = true;
      this.filtered = filterEntries(
        this.allFilesRecursive,
        this.query,
        preferredPath
      );
    } else {
      this.isSearchMode = false;
      this.filtered = this.allEntries;
    }
    this.selected = 0;
  }

  private getPreviewEntry(): FileEntry | null {
    return this.filtered[this.selected] ?? null;
  }

  private renderBrowserPane(width: number): string[] {
    const w = width;
    const innerW = w - 2;
    const lines: string[] = [];

    const t = paletteTheme;
    const border = (s: string) => fg(t.border, s);
    const title = (s: string) => fg(t.title, s);
    const selected = (s: string) => fg(t.selected, s);
    const selectedText = (s: string) => fg(t.selectedText, s);
    const directory = (s: string) => fg(t.directory, s);
    const checked = (s: string) => fg(t.checked, s);
    const hint = (s: string) => fg(t.hint, s);
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

    const row = (content: string) =>
      border("│") + padVisibleText(content, innerW) + border("│");

    let titleText: string;
    if (this.isSearchMode) {
      titleText = " Search ";
    } else if (this.rootParentView) {
      titleText = " Files ";
    } else {
      const relDir = path.relative(this.cwdRoot, this.currentDir);
      titleText = relDir ? ` ${truncateVisibleText(relDir, 40)} ` : " Files ";
    }
    const borderLen = Math.max(0, innerW - visibleWidth(titleText));
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;
    lines.push(
      border("╭" + "─".repeat(leftBorder)) +
        title(titleText) +
        border("─".repeat(rightBorder) + "╮")
    );

    const searchPrompt = selected("❯ ");
    const modeIndicator =
      this.query && isGlobPattern(this.query) ? hint(" [glob]") : "";
    const searchWidth = Math.max(3, innerW - 1 - visibleWidth(modeIndicator));
    const renderedSearchInput = this.searchInput.render(searchWidth)[0] ?? "> ";
    const normalizedSearchInput = renderedSearchInput.startsWith("> ")
      ? renderedSearchInput.slice(2)
      : renderedSearchInput;
    lines.push(row(` ${searchPrompt}${normalizedSearchInput}${modeIndicator}`));

    const visibleOptions = this.getVisibleOptions();
    if (visibleOptions.length > 0) {
      const optParts: string[] = [];
      for (let i = 0; i < visibleOptions.length; i++) {
        const opt = visibleOptions[i];
        const isSelectedOpt = this.focusOnOptions && i === this.selectedOption;
        const checkbox = opt.enabled ? checked("☑") : hint("☐");
        const label = isSelectedOpt
          ? selected(opt.label)
          : opt.enabled
            ? opt.label
            : hint(opt.label);
        const prefix = isSelectedOpt ? selected("▸") : " ";
        optParts.push(`${prefix}${checkbox} ${label}`);
      }
      const optionsStr = optParts.join(" ");
      const tabHint = this.focusOnOptions
        ? hint(" (arrows/space/esc)")
        : hint(" (shift+tab)");
      lines.push(row(` ${optionsStr}${tabHint}`));
    } else {
      lines.push(row(""));
    }

    lines.push(border(`├${"─".repeat(innerW)}┤`));

    const startIndex = Math.max(
      0,
      Math.min(
        this.selected - Math.floor(this.maxVisible / 2),
        this.filtered.length - this.maxVisible
      )
    );

    for (let i = 0; i < this.maxVisible; i++) {
      const actualIndex = startIndex + i;
      if (actualIndex < this.filtered.length) {
        const entry = this.filtered[actualIndex];
        const isSelectedEntry = actualIndex === this.selected;
        const isUpDir = this.isUpEntry(entry);
        const isChecked =
          !isUpDir && this.selectedPaths.has(entry.relativePath);

        const prefix = isSelectedEntry ? selected(" ▶ ") : "   ";

        let displayName: string;
        if (isUpDir) {
          displayName = "..";
        } else if (this.isSearchMode) {
          displayName = entry.relativePath + (entry.isDirectory ? "/" : "");
        } else {
          displayName = entry.name + (entry.isDirectory ? "/" : "");
        }

        const maxNameLen = innerW - 8;
        const truncatedName = truncateVisibleText(displayName, maxNameLen);

        let nameStr: string;
        if (isUpDir) {
          nameStr = isSelectedEntry
            ? bold(selectedText(truncatedName))
            : hint(truncatedName);
        } else if (entry.isDirectory) {
          nameStr = isSelectedEntry
            ? bold(selectedText(truncatedName))
            : directory(truncatedName);
        } else {
          nameStr = isSelectedEntry
            ? bold(selectedText(truncatedName))
            : truncatedName;
        }

        if (isUpDir) {
          lines.push(row(`${prefix}   ${nameStr}`));
        } else {
          const checkMark = isChecked ? checked("☑ ") : hint("☐ ");
          lines.push(row(`${prefix}${checkMark}${nameStr}`));
        }
      } else if (i === 0 && this.filtered.length === 0) {
        lines.push(row(hint("   No matching files")));
      } else {
        lines.push(row(""));
      }
    }

    if (this.filtered.length > this.maxVisible) {
      const shown = `${startIndex + 1}-${Math.min(startIndex + this.maxVisible, this.filtered.length)}`;
      lines.push(row(hint(` (${shown} of ${this.filtered.length})`)));
    } else if (this.filtered.length > 0) {
      lines.push(
        row(
          hint(
            ` (${this.filtered.length} file${this.filtered.length === 1 ? "" : "s"})`
          )
        )
      );
    } else {
      lines.push(row(""));
    }

    lines.push(border(`├${"─".repeat(innerW)}┤`));
    if (this.selectedPaths.size > 0) {
      const selectedList = Array.from(this.selectedPaths.keys()).slice(0, 3);
      const preview =
        selectedList.join(", ") + (this.selectedPaths.size > 3 ? ", ..." : "");
      lines.push(
        row(
          ` ${checked(`Selected (${this.selectedPaths.size}):`)} ${truncateVisibleText(preview, innerW - 18)}`
        )
      );
    } else {
      lines.push(row(hint(" No files or folders selected")));
    }

    lines.push(border(`├${"─".repeat(innerW)}┤`));
    lines.push(
      row(
        hint(
          " ↑↓ nav  space queue  → open dir  tab complete  enter attach  esc done"
        )
      )
    );
    lines.push(border(`╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  private renderPreviewPane(width: number, height: number): string[] {
    const w = Math.max(1, width);
    const innerW = w - 2;
    const bodyRows = Math.max(3, height - 8);
    const preview = loadPreviewData({
      cwdRoot: this.cwdRoot,
      currentDir: this.currentDir,
      entry: this.getPreviewEntry(),
      maxLines: bodyRows,
    });
    const lines: string[] = [];

    const t = paletteTheme;
    const border = (s: string) => fg(t.border, s);
    const title = (s: string) => fg(t.title, s);
    const directory = (s: string) => fg(t.directory, s);
    const checked = (s: string) => fg(t.checked, s);
    const hint = (s: string) => fg(t.hint, s);
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const row = (content: string) =>
      border("│") + padVisibleText(content, innerW) + border("│");

    const titleText = " Preview ";
    const borderLen = Math.max(0, innerW - visibleWidth(titleText));
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;
    lines.push(
      border("╭" + "─".repeat(leftBorder)) +
        title(titleText) +
        border("─".repeat(rightBorder) + "╮")
    );

    const previewLanguage =
      preview.kind === "file" ? getLanguageFromPath(preview.title) : undefined;
    const previewTitle = truncateVisibleText(preview.title, innerW - 1);
    let titleLine = hint(previewTitle);
    if (preview.kind === "directory") {
      titleLine = directory(previewTitle);
    } else if (preview.kind === "file") {
      titleLine = bold(previewTitle);
    }
    lines.push(row(` ${titleLine}`));
    lines.push(
      row(` ${hint(truncateVisibleText(preview.details, innerW - 1))}`)
    );
    lines.push(border(`├${"─".repeat(innerW)}┤`));

    for (let i = 0; i < bodyRows; i++) {
      const line = preview.lines[i];
      if (line === undefined) {
        lines.push(row(""));
        continue;
      }

      const isCodePreviewLine = preview.kind === "file" && !line.startsWith("…");
      const renderedLine = isCodePreviewLine
        ? highlightPreviewLine(line, previewLanguage)
        : line;
      const truncatedLine = truncateVisibleText(renderedLine, innerW - 1);
      const lineContent = isCodePreviewLine ? truncatedLine : hint(truncatedLine);
      lines.push(row(` ${lineContent}`));
    }

    lines.push(border(`├${"─".repeat(innerW)}┤`));
    if (this.selectedPaths.size > 0) {
      lines.push(row(` ${checked(`Queued: ${this.selectedPaths.size}`)}`));
    } else {
      lines.push(row(hint(" No queued files")));
    }
    lines.push(row(hint(" Preview follows highlighted item")));
    lines.push(border(`╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  render(width: number): string[] {
    const totalWidth = Math.max(1, width || this.width);
    const browserLines = this.renderBrowserPane(totalWidth);
    const terminalRows = process.stdout.rows ?? 24;
    const targetModalHeight = Math.max(
      browserLines.length + 1 + this.minPreviewPaneHeight,
      Math.floor(terminalRows * this.overlayHeightRatio)
    );
    const previewHeight = Math.max(
      this.minPreviewPaneHeight,
      targetModalHeight - browserLines.length - 1
    );
    const previewLines = this.renderPreviewPane(totalWidth, previewHeight);

    return [...browserLines, "", ...previewLines].map((line) =>
      truncateToWidth(line, totalWidth, "")
    );
  }
  invalidate(): void {}
  dispose(): void {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared File Picker Logic
// ═══════════════════════════════════════════════════════════════════════════

export async function openFilePicker(ui: ExtensionUIContext): Promise<string> {
  const result = await ui.custom<FileBrowserAction>(
    (_tui, _theme, _kb, done) => new FileBrowserComponent(done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "92%",
        minWidth: 80,
        maxHeight: "94%",
        margin: 1,
      },
    }
  );

  if (!result || result.action === "cancel") return "";
  const paths = result.paths ?? [];
  if (paths.length == 0) return "";

  // Add trailing / for directories to make it clear
  const refs = paths
    .map((p) => `@${p.path}${p.isDirectory ? "/" : ""}`)
    .join(" ");
  ui.notify(`Added ${paths.length} file${paths.length > 1 ? "s" : ""}`, "info");
  return refs;
}
