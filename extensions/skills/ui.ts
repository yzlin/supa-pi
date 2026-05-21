import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  buildSkillPreviewModel,
  filterSkillInventory,
  type SkillInventoryItem,
  type SkillInventoryModel,
  type SkillListFilter,
} from "./model";

export interface SkillsManagerState {
  query: string;
  selectedIndex: number;
  filterMode: boolean;
  actionMenuOpen: boolean;
}

export interface SkillsManagerTheme {
  fg?(tone: string, text: string): string;
  bold?(text: string): string;
}

export interface SkillsManagerComponentOptions {
  inventory: SkillInventoryModel;
  initialQuery?: string;
  theme?: SkillsManagerTheme;
  done: () => void;
}

export interface SkillsInstallPickerState {
  selectedIndex: number;
  selectedIds: ReadonlySet<string>;
  warning?: string;
}

export type SkillsInstallPickerInput =
  | "down"
  | "up"
  | "toggle"
  | "confirm"
  | "cancel";

export interface SkillsInstallPickerTransition {
  state: SkillsInstallPickerState;
  confirmedIds?: string[];
  cancelled?: boolean;
}

export interface SkillsInstallPickerComponentOptions {
  inventory: SkillInventoryModel;
  theme?: SkillsManagerTheme;
  done: (selectedIds: string[] | undefined) => void;
}

const CLOSE_KEYS = new Set(["\u001b", "q"]);
const DOWN_KEYS = new Set(["\u001b[B", "j", "\u000e"]);
const UP_KEYS = new Set(["\u001b[A", "k", "\u0010"]);

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, length - 1));
}

function visibleItems(
  inventory: SkillInventoryModel,
  filter: SkillListFilter
): SkillInventoryItem[] {
  return filterSkillInventory(inventory, filter).all;
}

function groupedVisibleItems(
  inventory: SkillInventoryModel,
  filter: SkillListFilter
): { managed: SkillInventoryItem[]; bundled: SkillInventoryItem[] } {
  const filtered = filterSkillInventory(inventory, filter);
  return { managed: filtered.managed, bundled: filtered.bundled };
}

function truncate(value: string, width: number): string {
  return truncateToWidth(value, width);
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function color(
  theme: SkillsManagerTheme | undefined,
  tone: string,
  text: string
): string {
  return theme?.fg?.(tone, text) ?? text;
}

function strong(theme: SkillsManagerTheme | undefined, text: string): string {
  return theme?.bold?.(text) ?? text;
}

function centerText(text: string, width: number): string {
  const clipped = truncate(text, width);
  const remaining = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(remaining / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
}

function frameBorder(
  width: number,
  left: string,
  fill: string,
  right: string,
  theme?: SkillsManagerTheme
): string {
  return color(
    theme,
    "border",
    `${left}${fill.repeat(Math.max(0, width - 2))}${right}`
  );
}

function titleBorder(
  width: number,
  title: string,
  theme?: SkillsManagerTheme
): string {
  const innerWidth = Math.max(0, width - 2);
  const clippedTitle = truncate(title, innerWidth);
  const borderWidth = Math.max(0, innerWidth - visibleWidth(clippedTitle));
  const leftWidth = Math.floor(borderWidth / 2);
  const rightWidth = borderWidth - leftWidth;
  return (
    color(theme, "border", `╭${"─".repeat(leftWidth)}`) +
    color(theme, "border", clippedTitle) +
    color(theme, "border", `${"─".repeat(rightWidth)}╮`)
  );
}

function frameLine(
  content: string,
  width: number,
  theme?: SkillsManagerTheme
): string {
  const innerWidth = Math.max(0, width - 2);
  const clipped = truncate(` ${content} `, innerWidth);
  return `${color(theme, "border", "│")}${padVisible(clipped, innerWidth)}${color(theme, "border", "│")}`;
}

function centeredFrameLine(
  content: string,
  width: number,
  theme?: SkillsManagerTheme
): string {
  const innerWidth = Math.max(0, width - 2);
  return frameLine(
    centerText(content, Math.max(0, innerWidth - 2)),
    width,
    theme
  );
}

function installPickerItemLine(
  item: SkillInventoryItem,
  focused: boolean,
  checked: boolean,
  width: number,
  theme?: SkillsManagerTheme
): string {
  const marker = focused ? color(theme, "accent", "›") : " ";
  const checkbox = checked ? color(theme, "accent", "[x]") : "[ ]";
  const installed =
    item.kind === "managed" ? color(theme, "success", " installed") : "";
  const dirty =
    item.dirtyStatus === "dirty" ? color(theme, "warning", " dirty") : "";
  const status =
    installed || dirty ? ` [${`${installed}${dirty}`.trim()}]` : "";
  const label = focused ? strong(theme, item.name) : item.name;
  const line = `${marker} ${checkbox} ${label} ${color(theme, "dim", `(${item.id})`)}${status}`;
  return truncate(line, width);
}

function itemLine(
  item: SkillInventoryItem,
  selected: boolean,
  width: number,
  theme?: SkillsManagerTheme
): string {
  const marker = selected ? color(theme, "accent", "›") : " ";
  const dirty =
    item.dirtyStatus === "dirty" ? color(theme, "warning", " dirty") : "";
  const kind = color(
    theme,
    "dim",
    item.kind === "managed" ? "managed" : "bundled"
  );
  const label = selected ? strong(theme, item.name) : item.name;
  const line = `${marker} ${label} ${color(theme, "dim", `(${item.id})`)} [${kind}${dirty}]`;
  return truncate(line, width);
}

function sectionLines(
  title: string,
  items: SkillInventoryItem[],
  selected: SkillInventoryItem | undefined,
  width: number,
  theme?: SkillsManagerTheme
): string[] {
  const lines = [color(theme, "dim", `${title} (${items.length})`)];
  if (items.length === 0) {
    lines.push(color(theme, "dim", "  No skills."));
    return lines;
  }
  for (const item of items) {
    lines.push(itemLine(item, item.id === selected?.id, width, theme));
  }
  return lines;
}

const SKILL_CONTENT_PREVIEW_LINES = 40;
const MAX_INVENTORY_PANEL_LINES = 20;
const MAX_PREVIEW_PANEL_LINES = 22;
const SKILL_CONTENT_LINE_PATTERN = /\r?\n/;

function clipPanelLines(
  lines: string[],
  maxLines: number,
  theme?: SkillsManagerTheme
): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  return [
    ...lines.slice(0, Math.max(0, maxLines - 1)),
    color(theme, "dim", "…"),
  ];
}

function clipPanelLinesKeepingLine(
  lines: string[],
  maxLines: number,
  keepLine: string | undefined,
  theme?: SkillsManagerTheme
): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  const clipped = lines.slice(0, Math.max(0, maxLines - 1));
  if (!keepLine || clipped.includes(keepLine)) {
    return [...clipped, color(theme, "dim", "…")];
  }
  return [
    ...lines.slice(0, Math.max(0, maxLines - 2)),
    color(theme, "dim", "…"),
    keepLine,
  ];
}

function previewLines(
  item: SkillInventoryItem | undefined,
  theme?: SkillsManagerTheme
): string[] {
  if (!item) {
    return [
      color(theme, "dim", "Preview"),
      "",
      color(theme, "dim", "No skill selected."),
    ];
  }
  const preview = buildSkillPreviewModel(item);
  const lines = [
    color(theme, "dim", "Preview"),
    "",
    strong(theme, preview.title),
    color(theme, "dim", preview.subtitle),
    preview.dirty
      ? color(theme, "warning", "Status: dirty")
      : color(theme, "dim", "Status: clean/read-only"),
    `${color(theme, "dim", "Path:")} ${preview.path}`,
  ];
  if (preview.source) {
    lines.push(`${color(theme, "dim", "Source:")} ${preview.source}`);
  }
  lines.push("", preview.description);
  if (preview.skillContent) {
    const skillContentLines = preview.skillContent.split(
      SKILL_CONTENT_LINE_PATTERN
    );
    lines.push(
      "",
      color(theme, "dim", "SKILL.md"),
      ...skillContentLines.slice(0, SKILL_CONTENT_PREVIEW_LINES)
    );
    if (skillContentLines.length > SKILL_CONTENT_PREVIEW_LINES) {
      lines.push(color(theme, "dim", "…"));
    }
  }
  return lines;
}

export function renderSkillsManager(
  inventory: SkillInventoryModel,
  state: SkillsManagerState,
  width = 100,
  theme?: SkillsManagerTheme
): string[] {
  const frameWidth = Math.max(60, width);
  const contentWidth = Math.max(0, frameWidth - 4);
  const filter = { query: state.query };
  const all = visibleItems(inventory, filter);
  const selected = all[clampIndex(state.selectedIndex, all.length)];
  const grouped = groupedVisibleItems(inventory, filter);
  const inventoryLines = [
    `${color(theme, "dim", "Filter:")} ${state.filterMode ? color(theme, "accent", "▸ ") : ""}${state.query || color(theme, "dim", "(none)")}`,
    "",
    ...sectionLines("Managed", grouped.managed, selected, contentWidth, theme),
    "",
    ...sectionLines(
      "Bundled/read-only",
      grouped.bundled,
      selected,
      contentWidth,
      theme
    ),
  ];
  const selectedInventoryLine = selected
    ? itemLine(selected, true, contentWidth, theme)
    : undefined;
  const inventoryPanelLines = clipPanelLinesKeepingLine(
    inventoryLines,
    MAX_INVENTORY_PANEL_LINES,
    selectedInventoryLine,
    theme
  ).map((line) => truncate(line, contentWidth));
  const previewPanelLines = clipPanelLines(
    previewLines(selected, theme),
    MAX_PREVIEW_PANEL_LINES,
    theme
  ).map((line) => truncate(line, contentWidth));
  const actionLines = state.actionMenuOpen
    ? [
        "",
        color(
          theme,
          "dim",
          "Actions: install/update/remove unavailable in this first slice"
        ),
      ]
    : [];
  const help = color(
    theme,
    "dim",
    "↑/k/ctrl+p ↓/j/ctrl+n navigate  / filter  backspace edit  enter actions  esc/q close"
  );
  return [
    titleBorder(frameWidth, " Skills Manager ", theme),
    centeredFrameLine(
      color(
        theme,
        "dim",
        "Browse skill inventory and preview local SKILL.md content"
      ),
      frameWidth,
      theme
    ),
    frameBorder(frameWidth, "├", "─", "┤", theme),
    ...inventoryPanelLines.map((line) => frameLine(line, frameWidth, theme)),
    frameBorder(frameWidth, "├", "─", "┤", theme),
    ...previewPanelLines.map((line) => frameLine(line, frameWidth, theme)),
    ...actionLines.map((line) => frameLine(line, frameWidth, theme)),
    frameBorder(frameWidth, "├", "─", "┤", theme),
    centeredFrameLine(help, frameWidth, theme),
    frameBorder(frameWidth, "╰", "─", "╯", theme),
  ];
}

export function createInitialSkillsInstallPickerState(): SkillsInstallPickerState {
  return {
    selectedIndex: 0,
    selectedIds: new Set<string>(),
  };
}

export function reduceSkillsInstallPickerState(
  state: SkillsInstallPickerState,
  input: SkillsInstallPickerInput,
  items: readonly SkillInventoryItem[]
): SkillsInstallPickerTransition {
  switch (input) {
    case "cancel":
      return { state, cancelled: true };
    case "down":
      return {
        state: {
          selectedIndex: clampIndex(state.selectedIndex + 1, items.length),
          selectedIds: state.selectedIds,
        },
      };
    case "up":
      return {
        state: {
          selectedIndex: clampIndex(state.selectedIndex - 1, items.length),
          selectedIds: state.selectedIds,
        },
      };
    case "toggle": {
      const item = items[clampIndex(state.selectedIndex, items.length)];
      if (!item) {
        return { state };
      }
      const selectedIds = new Set(state.selectedIds);
      if (selectedIds.has(item.id)) {
        selectedIds.delete(item.id);
      } else {
        selectedIds.add(item.id);
      }
      return {
        state: {
          selectedIndex: state.selectedIndex,
          selectedIds,
        },
      };
    }
  }
  const confirmedIds = items
    .map((item) => item.id)
    .filter((id) => state.selectedIds.has(id));
  if (confirmedIds.length === 0) {
    return {
      state: {
        selectedIndex: clampIndex(state.selectedIndex, items.length),
        selectedIds: state.selectedIds,
        warning: "Select at least one skill to install.",
      },
    };
  }
  return { state, confirmedIds };
}

export function renderSkillsInstallPicker(
  inventory: SkillInventoryModel,
  state: SkillsInstallPickerState,
  width = 100,
  theme?: SkillsManagerTheme
): string[] {
  const frameWidth = Math.max(60, width);
  const contentWidth = Math.max(0, frameWidth - 4);
  const all = inventory.all;
  const selected = all[clampIndex(state.selectedIndex, all.length)];
  const itemLines = all.length
    ? all.map((item) =>
        installPickerItemLine(
          item,
          item.id === selected?.id,
          state.selectedIds.has(item.id),
          contentWidth,
          theme
        )
      )
    : [color(theme, "dim", "No skills available.")];
  const help = color(
    theme,
    "dim",
    "↑/k/ctrl+p ↓/j/ctrl+n navigate  space toggle  enter install selected  esc/q cancel"
  );
  return [
    titleBorder(frameWidth, " Install Skills ", theme),
    centeredFrameLine(
      color(theme, "dim", "Choose skills to install"),
      frameWidth,
      theme
    ),
    frameBorder(frameWidth, "├", "─", "┤", theme),
    ...itemLines.map((line) => frameLine(line, frameWidth, theme)),
    ...(state.warning
      ? [
          frameBorder(frameWidth, "├", "─", "┤", theme),
          frameLine(color(theme, "warning", state.warning), frameWidth, theme),
        ]
      : []),
    frameBorder(frameWidth, "├", "─", "┤", theme),
    centeredFrameLine(help, frameWidth, theme),
    frameBorder(frameWidth, "╰", "─", "╯", theme),
  ];
}

function inputForInstallPicker(
  data: string
): SkillsInstallPickerInput | undefined {
  if (CLOSE_KEYS.has(data)) {
    return "cancel";
  }
  if (DOWN_KEYS.has(data)) {
    return "down";
  }
  if (UP_KEYS.has(data)) {
    return "up";
  }
  if (data === " ") {
    return "toggle";
  }
  if (data === "\r" || data === "\n") {
    return "confirm";
  }
  return undefined;
}

export function createSkillsInstallPickerComponent({
  inventory,
  theme,
  done,
}: SkillsInstallPickerComponentOptions) {
  let state = createInitialSkillsInstallPickerState();

  return {
    get state() {
      return state;
    },
    invalidate() {
      // Component owns local state only.
    },
    render(width = 100) {
      return renderSkillsInstallPicker(inventory, state, width, theme);
    },
    handleInput(data: string) {
      const input = inputForInstallPicker(data);
      if (!input) {
        return;
      }
      const transition = reduceSkillsInstallPickerState(
        state,
        input,
        inventory.all
      );
      state = transition.state;
      if (transition.confirmedIds) {
        done(transition.confirmedIds);
      }
      if (transition.cancelled) {
        done(undefined);
      }
    },
  };
}

export function createSkillsManagerComponent({
  inventory,
  initialQuery = "",
  theme,
  done,
}: SkillsManagerComponentOptions) {
  const state: SkillsManagerState = {
    query: initialQuery,
    selectedIndex: 0,
    filterMode: false,
    actionMenuOpen: false,
  };

  function normalizeSelection(): void {
    state.selectedIndex = clampIndex(
      state.selectedIndex,
      visibleItems(inventory, { query: state.query }).length
    );
  }

  return {
    state,
    invalidate() {
      // Component owns local state only.
    },
    render(width = 100) {
      normalizeSelection();
      return renderSkillsManager(inventory, state, width, theme);
    },
    handleInput(data: string) {
      if (state.filterMode) {
        if (data === "\r" || data === "\n" || data === "\u001b") {
          state.filterMode = false;
          return;
        }
        if (data === "\u007f" || data === "\b") {
          state.query = state.query.slice(0, -1);
          normalizeSelection();
          return;
        }
        if (data.length === 1 && data >= " ") {
          state.query += data;
          state.selectedIndex = 0;
          normalizeSelection();
        }
        return;
      }
      if (CLOSE_KEYS.has(data)) {
        if (state.actionMenuOpen) {
          state.actionMenuOpen = false;
          return;
        }
        done();
        return;
      }
      if (DOWN_KEYS.has(data)) {
        state.selectedIndex += 1;
        normalizeSelection();
        return;
      }
      if (UP_KEYS.has(data)) {
        state.selectedIndex -= 1;
        normalizeSelection();
        return;
      }
      if (data === "/") {
        state.filterMode = true;
        return;
      }
      if (data === "\u007f" || data === "\b") {
        state.query = state.query.slice(0, -1);
        state.selectedIndex = 0;
        normalizeSelection();
        return;
      }
      if (data === "\r" || data === "\n") {
        state.actionMenuOpen = !state.actionMenuOpen;
      }
    },
  };
}
