import {
  type Component,
  type OverlayOptions,
  parseKey,
  ScrollView,
  type TUI,
  type TuiInputListener,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

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
  hostTui?: TUI;
}

export interface SkillsInstallPickerState {
  selectedIndex: number;
  selectedIds: ReadonlySet<string>;
  warning?: string;
}

export type SkillsInstallPickerInput =
  | "down"
  | "up"
  | "pageDown"
  | "pageUp"
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

const PAGE_NAVIGATION_STEP = 10;
export const SKILLS_MANAGER_OVERLAY_OPTIONS = {
  anchor: "center",
  width: "90%",
  minWidth: 64,
  maxHeight: "95%",
  margin: 1,
} as const satisfies OverlayOptions;
const MANAGER_HEADER_ROWS = 3;
const FIXED_FILTER_ROWS = 2;
const INVENTORY_FIRST_OVERLAY_ROW = MANAGER_HEADER_ROWS + FIXED_FILTER_ROWS;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Mouse input uses the terminal escape character.
const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/;

type SkillsNavigationInput = Extract<
  SkillsInstallPickerInput,
  "down" | "up" | "pageDown" | "pageUp"
>;

function isCloseKey(key: string | undefined): boolean {
  return key === "escape" || key === "q";
}

function navigationInputForKey(
  key: string | undefined
): SkillsNavigationInput | undefined {
  switch (key) {
    case "down":
    case "j":
      return "down";
    case "up":
    case "k":
      return "up";
    case "pageDown":
    case "ctrl+f":
      return "pageDown";
    case "pageUp":
    case "ctrl+b":
      return "pageUp";
    default:
      return;
  }
}

function selectionDeltaForInput(
  input: SkillsNavigationInput,
  pageStep = PAGE_NAVIGATION_STEP
): number {
  switch (input) {
    case "down":
      return 1;
    case "up":
      return -1;
    case "pageDown":
      return pageStep;
    case "pageUp":
      return -pageStep;
  }
}

const FULLSCREEN_WHEEL_COMPATIBILITY_ERROR =
  "Skills fullscreen wheel routing requires @earendil-works/pi-tui 0.84.0 with TuiBase inputListeners storage. Reinstall the pinned version or disable fullscreen mode.";

interface PiTui084FullscreenInternals {
  inputListeners: Set<TuiInputListener>;
}

function piTui084FullscreenInternals(tui: TUI): PiTui084FullscreenInternals {
  // pi-tui 0.84.0 has no public listener-priority or overlay wheel-routing API.
  // Remove this private compatibility adapter when either API becomes public.
  const inputListeners = (tui as unknown as { inputListeners?: unknown })
    .inputListeners;
  if (
    !(inputListeners instanceof Set) ||
    [...inputListeners].some((candidate) => typeof candidate !== "function")
  ) {
    throw new Error(FULLSCREEN_WHEEL_COMPATIBILITY_ERROR);
  }
  return { inputListeners };
}

function prioritizeFullscreenInputListener(
  tui: TUI,
  listener: TuiInputListener
): () => void {
  const { inputListeners } = piTui084FullscreenInternals(tui);
  const remove = tui.addInputListener(listener);
  if (!inputListeners.delete(listener)) {
    remove();
    throw new Error(FULLSCREEN_WHEEL_COMPATIBILITY_ERROR);
  }

  // The fullscreen viewport handler consumes wheel input before focused overlay
  // dispatch. Keep all existing order while prepending this overlay listener.
  const existing = [...inputListeners];
  inputListeners.clear();
  inputListeners.add(listener);
  for (const existingListener of existing) {
    inputListeners.add(existingListener);
  }
  return remove;
}

interface WheelInput {
  direction: -1 | 1;
  x: number;
  y: number;
}

function wheelInputForData(data: string): WheelInput | undefined {
  const sgrMatch = SGR_MOUSE_PATTERN.exec(data);
  let button: number;
  let x: number;
  let y: number;
  if (sgrMatch) {
    button = Number(sgrMatch[1]);
    x = Number(sgrMatch[2]) - 1;
    y = Number(sgrMatch[3]) - 1;
  } else if (data.length === 6 && data.startsWith("\x1b[M")) {
    button = data.charCodeAt(3) - 32;
    x = data.charCodeAt(4) - 33;
    y = data.charCodeAt(5) - 33;
  } else {
    return;
  }

  // biome-ignore lint/suspicious/noBitwiseOperators: Terminal mouse buttons are bit flags.
  if ((button & 64) === 0) {
    return;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Wheel direction is stored in the low button bits.
  const direction = button & 3;
  if (direction !== 0 && direction !== 1) {
    return;
  }
  return { direction: direction === 0 ? -1 : 1, x, y };
}

function overlaySize(value: number | `${number}%`, reference: number): number {
  if (typeof value === "number") {
    return value;
  }
  return Math.floor((reference * Number.parseFloat(value)) / 100);
}

function skillsManagerInventoryBounds(
  terminalWidth: number,
  terminalHeight: number,
  renderedHeight: number,
  viewportHeight: number
): { left: number; right: number; top: number; bottom: number } {
  const margin = SKILLS_MANAGER_OVERLAY_OPTIONS.margin;
  const availableWidth = Math.max(1, terminalWidth - margin * 2);
  const availableHeight = Math.max(1, terminalHeight - margin * 2);
  const requestedWidth = overlaySize(
    SKILLS_MANAGER_OVERLAY_OPTIONS.width,
    terminalWidth
  );
  const width = Math.max(
    1,
    Math.min(
      Math.max(requestedWidth, SKILLS_MANAGER_OVERLAY_OPTIONS.minWidth),
      availableWidth
    )
  );
  const maxHeight = Math.max(
    1,
    Math.min(
      overlaySize(SKILLS_MANAGER_OVERLAY_OPTIONS.maxHeight, terminalHeight),
      availableHeight
    )
  );
  const height = Math.min(renderedHeight, maxHeight);
  const row = margin + Math.floor((availableHeight - height) / 2);
  const col = margin + Math.floor((availableWidth - width) / 2);
  return {
    left: col + 1,
    right: col + width - 1,
    top: row + INVENTORY_FIRST_OVERLAY_ROW,
    bottom: Math.min(
      row + height,
      row + INVENTORY_FIRST_OVERLAY_ROW + viewportHeight
    ),
  };
}

function pointIsWithinInventory(
  input: WheelInput,
  bounds: ReturnType<typeof skillsManagerInventoryBounds>
): boolean {
  return (
    input.x >= bounds.left &&
    input.x < bounds.right &&
    input.y >= bounds.top &&
    input.y < bounds.bottom
  );
}

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

class InventoryContent implements Component {
  lines: string[] = [];

  invalidate(): void {
    // Content is rebuilt on every manager render.
  }

  render(): string[] {
    return this.lines;
  }
}

function createInventoryScrollView(content: InventoryContent): ScrollView {
  return new ScrollView(content, {
    overscroll: "contain",
    scrollbar: "hidden",
  });
}

const INVENTORY_VIEWPORT_LINES = MAX_INVENTORY_PANEL_LINES - 2;

function ignoreLayoutRenderRequest(): void {
  // The owning custom component renders synchronously after state changes.
}

function renderInventoryViewport(
  scrollView: ScrollView,
  content: InventoryContent,
  lines: string[],
  selectedLineIndex: number | undefined,
  bundledSectionLineIndex: number,
  width: number,
  theme?: SkillsManagerTheme
): string[] {
  content.lines = lines.map((line) => truncate(line, width));
  const viewportHeight = Math.min(INVENTORY_VIEWPORT_LINES, lines.length);
  scrollView.updateLayout(
    content.lines.length,
    viewportHeight,
    ignoreLayoutRenderRequest
  );

  if (selectedLineIndex !== undefined) {
    const maxScrollTop = Math.max(0, lines.length - viewportHeight);
    let scrollTop = scrollView.scrollTop;
    if (selectedLineIndex < scrollTop) {
      scrollTop = selectedLineIndex;
    } else if (selectedLineIndex >= scrollTop + viewportHeight) {
      scrollTop = selectedLineIndex - viewportHeight + 1;
    }
    scrollTop = Math.max(0, Math.min(maxScrollTop, scrollTop));

    if (scrollTop > 0 && selectedLineIndex === scrollTop) {
      scrollTop -= 1;
    }
    if (
      scrollTop + viewportHeight < lines.length &&
      selectedLineIndex === scrollTop + viewportHeight - 1
    ) {
      scrollTop = Math.min(maxScrollTop, scrollTop + 1);
    }
    scrollView.scrollTo(scrollTop);
  }

  const viewport = scrollView
    .render(width)
    .slice(scrollView.scrollTop, scrollView.scrollTop + viewportHeight);
  if (scrollView.scrollTop > 0 && viewport.length > 0) {
    const sectionLineIndex =
      scrollView.scrollTop >= bundledSectionLineIndex
        ? bundledSectionLineIndex
        : 0;
    viewport[0] = lines[sectionLineIndex] ?? "";
  }
  if (
    scrollView.scrollTop + scrollView.viewportHeight < lines.length &&
    viewport.length > 0
  ) {
    viewport[viewport.length - 1] = color(theme, "dim", "…");
  }
  return viewport;
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

function renderSkillsManagerWithScrollView(
  inventory: SkillInventoryModel,
  state: SkillsManagerState,
  width: number,
  theme: SkillsManagerTheme | undefined,
  scrollView: ScrollView,
  inventoryContent: InventoryContent,
  followSelection = true
): string[] {
  const frameWidth = Math.max(60, width);
  const contentWidth = Math.max(0, frameWidth - 4);
  const filter = { query: state.query };
  const all = visibleItems(inventory, filter);
  const selected = all[clampIndex(state.selectedIndex, all.length)];
  const grouped = groupedVisibleItems(inventory, filter);
  const filterLine = `${color(theme, "dim", "Filter:")} ${state.filterMode ? color(theme, "accent", "▸ ") : ""}${state.query || color(theme, "dim", "(none)")}`;
  const managedLines = sectionLines(
    "Managed",
    grouped.managed,
    selected,
    contentWidth,
    theme
  );
  const bundledLines = sectionLines(
    "Bundled/read-only",
    grouped.bundled,
    selected,
    contentWidth,
    theme
  );
  const bundledSectionLineIndex = managedLines.length + 1;
  const inventoryLines = [...managedLines, "", ...bundledLines];
  let selectedLineIndex: number | undefined;
  if (selected?.kind === "managed") {
    selectedLineIndex =
      1 + grouped.managed.findIndex((item) => item.id === selected.id);
  } else if (selected) {
    selectedLineIndex =
      bundledSectionLineIndex +
      1 +
      grouped.bundled.findIndex((item) => item.id === selected.id);
  }
  const inventoryPanelLines = renderInventoryViewport(
    scrollView,
    inventoryContent,
    inventoryLines,
    followSelection ? selectedLineIndex : undefined,
    bundledSectionLineIndex,
    contentWidth,
    theme
  );
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
    "↑/k ↓/j navigate  pgup/pgdn ctrl+b/ctrl+f page  / filter  enter actions  esc/q close"
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
    frameLine(filterLine, frameWidth, theme),
    frameLine("", frameWidth, theme),
    ...inventoryPanelLines.map((line) => frameLine(line, frameWidth, theme)),
    frameBorder(frameWidth, "├", "─", "┤", theme),
    ...previewPanelLines.map((line) => frameLine(line, frameWidth, theme)),
    ...actionLines.map((line) => frameLine(line, frameWidth, theme)),
    frameBorder(frameWidth, "├", "─", "┤", theme),
    centeredFrameLine(help, frameWidth, theme),
    frameBorder(frameWidth, "╰", "─", "╯", theme),
  ];
}

export function renderSkillsManager(
  inventory: SkillInventoryModel,
  state: SkillsManagerState,
  width = 100,
  theme?: SkillsManagerTheme
): string[] {
  const content = new InventoryContent();
  const scrollView = createInventoryScrollView(content);
  return renderSkillsManagerWithScrollView(
    inventory,
    state,
    width,
    theme,
    scrollView,
    content
  );
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
    case "up":
    case "pageDown":
    case "pageUp":
      return {
        state: {
          selectedIndex: clampIndex(
            state.selectedIndex + selectionDeltaForInput(input),
            items.length
          ),
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
    "↑/k ↓/j navigate  pgup/pgdn ctrl+b/ctrl+f page  space toggle  enter install  esc/q cancel"
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
  const key = parseKey(data);
  if (isCloseKey(key)) {
    return "cancel";
  }
  const navigationInput = navigationInputForKey(key);
  if (navigationInput) {
    return navigationInput;
  }
  if (data === " ") {
    return "toggle";
  }
  if (data === "\r" || data === "\n") {
    return "confirm";
  }
  return;
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
  hostTui,
}: SkillsManagerComponentOptions) {
  const state: SkillsManagerState = {
    query: initialQuery,
    selectedIndex: 0,
    filterMode: false,
    actionMenuOpen: false,
  };
  const inventoryContent = new InventoryContent();
  const inventoryScrollView = createInventoryScrollView(inventoryContent);
  let lastRenderedSelection: string | undefined;
  let lastRenderedHeight = 0;
  let removeHostInputListener: (() => void) | undefined;

  function normalizeSelection(): void {
    state.selectedIndex = clampIndex(
      state.selectedIndex,
      visibleItems(inventory, { query: state.query }).length
    );
  }

  const component = {
    state,
    inventoryScrollView,
    invalidate() {
      // Component owns local state only.
    },
    dispose() {
      removeHostInputListener?.();
      removeHostInputListener = undefined;
    },
    render(width = 100) {
      normalizeSelection();
      const selectionToken = `${state.query}\0${state.selectedIndex}`;
      const lines = renderSkillsManagerWithScrollView(
        inventory,
        state,
        width,
        theme,
        inventoryScrollView,
        inventoryContent,
        selectionToken !== lastRenderedSelection
      );
      lastRenderedSelection = selectionToken;
      lastRenderedHeight = lines.length;
      return lines;
    },
    handleInput(data: string) {
      const wheelInput = wheelInputForData(data);
      if (wheelInput) {
        inventoryScrollView.scrollBy(wheelInput.direction);
        return;
      }

      const key = parseKey(data);
      if (state.filterMode) {
        if (key === "escape") {
          done();
          return;
        }
        if (key === "enter") {
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
      if (isCloseKey(key)) {
        done();
        return;
      }
      const navigationInput = navigationInputForKey(key);
      if (navigationInput) {
        const pageStep = Math.max(
          1,
          (inventoryScrollView.viewportHeight || INVENTORY_VIEWPORT_LINES) - 1
        );
        state.selectedIndex += selectionDeltaForInput(
          navigationInput,
          pageStep
        );
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

  if (hostTui?.mode === "fullscreen") {
    removeHostInputListener = prioritizeFullscreenInputListener(
      hostTui,
      (data) => {
        const wheelInput = wheelInputForData(data);
        if (!wheelInput || lastRenderedHeight === 0) {
          return;
        }
        const bounds = skillsManagerInventoryBounds(
          hostTui.terminal.columns,
          hostTui.terminal.rows,
          lastRenderedHeight,
          inventoryScrollView.viewportHeight
        );
        if (!pointIsWithinInventory(wheelInput, bounds)) {
          return;
        }
        inventoryScrollView.scrollBy(wheelInput.direction);
        hostTui.requestRender();
        return { consume: true };
      }
    );
  }

  return component;
}
