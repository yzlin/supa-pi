/**
 * Terminal split compositor for pieditor fixed editor mode.
 *
 * Adapted from nicobailon/pi-powerline-footer fixed-editor/terminal-split.ts.
 * Scope kept local to pieditor: editor/status cluster only, no stash,
 * welcome, vibes, bash transcript, or last-prompt rendering.
 */
import {
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { FixedEditorClusterRender, FixedEditorCursor } from "./cluster.js";

export interface TerminalLike {
  columns: number;
  rows: number;
  kittyProtocolActive?: boolean;
  write(data: string): void;
}

export interface TuiLike {
  doRender?: () => void;
  render?: (width: number) => string[];
  addInputListener?: (
    listener: (data: string) => { consume?: boolean; data?: string } | undefined
  ) => unknown;
  compositeLineAt?: CompositeLineAt;
  requestRender?: () => void;
  hardwareCursorRow?: number;
  cursorRow?: number;
  previousViewportTop?: number;
  hasOverlay?: () => boolean;
  overlayStack?: Array<{ hidden?: boolean } | null | undefined>;
}

type ShortcutList = string | readonly string[];

export interface KeyboardScrollShortcuts {
  up?: ShortcutList;
  down?: ShortcutList;
}

interface NormalizedKeyboardScrollShortcuts {
  up: readonly string[];
  down: readonly string[];
}

export interface TerminalSplitCompositorOptions {
  tui: TuiLike;
  terminal: TerminalLike;
  renderCluster: (
    width: number,
    terminalRows: number
  ) => FixedEditorClusterRender;
  getShowHardwareCursor?: () => boolean;
  mouseScroll?: boolean;
  keyboardScrollShortcuts?: KeyboardScrollShortcuts;
  scrollUpShortcuts?: ShortcutList;
  scrollDownShortcuts?: ShortcutList;
  onCopySelection?: (text: string) => void;
}

export interface PatchedRenderable {
  render(width: number): string[];
}

interface RenderPatch {
  target: PatchedRenderable;
  originalRender: (width: number) => string[];
}

interface RenderPassCluster {
  width: number;
  terminalRows: number;
  cluster: FixedEditorClusterRender;
}

interface PaintedCluster {
  width: number;
  terminalRows: number;
  showHardwareCursor: boolean;
  lines: string[];
  cursor: FixedEditorCursor | null;
}

type CompositeLineAt = (
  baseLine: string,
  overlayLine: string,
  startCol: number,
  overlayWidth: number,
  totalWidth: number
) => string;

interface SgrMousePacket {
  code: number;
  col: number;
  row: number;
  final: "M" | "m";
}

interface SelectionPoint {
  line: number;
  col: number;
}

type SelectionArea = "root" | "cluster";

interface SelectionLocation {
  area: SelectionArea;
  point: SelectionPoint;
}

interface SelectionBounds {
  start: SelectionPoint;
  end: SelectionPoint;
}

export interface DisposeOptions {
  resetExtendedKeyboardModes?: boolean;
}

type ExtendedKeyboardMode = "kitty" | "modifyOtherKeys";

const CONTEXT_MENU_MOUSE_REPORTING_PAUSE_MS = 1200;
const CONTEXT_MENU_SELECTION_RESTORE_WINDOW_MS = 5000;
const CONTEXT_MENU_CLIPBOARD_RESTORE_INTERVAL_MS = 100;
const DOUBLE_CLICK_MS = 500;
const ROOT_SCROLLBAR_WIDTH = 1;
const ROOT_SCROLLBAR_GLYPH = "█";
const ROOT_SCROLLBAR_TRACK = `\x1b[2;90m${ROOT_SCROLLBAR_GLYPH}\x1b[0m`;
const ROOT_SCROLLBAR_THUMB = `\x1b[97m${ROOT_SCROLLBAR_GLYPH}\x1b[0m`;
const DEFAULT_SCROLL_UP_SHORTCUTS = ["super+up"] as const;
const DEFAULT_SCROLL_DOWN_SHORTCUTS = ["super+down"] as const;
const ESC_PATTERN = "\\x1b";
const BEL_PATTERN = "\\x07";
const MOUSE_MOTION_FLAG = 32;
const MOUSE_MODIFIER_FLAGS = [4, 8, 16, MOUSE_MOTION_FLAG] as const;
const SUPER_SHORTCUT_PATTERNS = new Map<string, RegExp>([
  [
    "super+up",
    new RegExp(
      `^${ESC_PATTERN}\\[(?:1;9(?::[12])?[AH]|574(?:19|23);9(?::[12])?u|7;9(?::[12])?~|27;9;65~)$`
    ),
  ],
  [
    "super+down",
    new RegExp(
      `^${ESC_PATTERN}\\[(?:1;9(?::[12])?[BF]|574(?:20|24);9(?::[12])?u|8;9(?::[12])?~|27;9;66~)$`
    ),
  ],
  [
    "super+pageup",
    new RegExp(`^${ESC_PATTERN}\\[(?:5;9(?::[12])?~|57421;9(?::[12])?u)$`),
  ],
  [
    "super+pagedown",
    new RegExp(`^${ESC_PATTERN}\\[(?:6;9(?::[12])?~|57422;9(?::[12])?u)$`),
  ],
]);
const FALLBACK_SCROLL_UP_PATTERN = new RegExp(
  `^${ESC_PATTERN}\\[(?:5;9(?::[12])?~|1;6(?::[12])?A|57421;9(?::[12])?u|57419;6(?::[12])?u)$`
);
const FALLBACK_SCROLL_DOWN_PATTERN = new RegExp(
  `^${ESC_PATTERN}\\[(?:6;9(?::[12])?~|1;6(?::[12])?B|57422;9(?::[12])?u|57420;6(?::[12])?u)$`
);
const SGR_MOUSE_PACKET_PATTERN = new RegExp(
  `${ESC_PATTERN}\\[<(\\d+);(\\d+);(\\d+)([Mm])`,
  "g"
);
const OSC_SEQUENCE_PATTERN = new RegExp(
  `${ESC_PATTERN}\\][^${BEL_PATTERN}]*(?:${BEL_PATTERN}|${ESC_PATTERN}\\\\)`,
  "g"
);
const STRING_CONTROL_SEQUENCE_PATTERN = new RegExp(
  `${ESC_PATTERN}[P^_][\\s\\S]*?(?:${BEL_PATTERN}|${ESC_PATTERN}\\\\)`,
  "g"
);
const ANSI_CONTROL_SEQUENCE_PATTERN = new RegExp(
  `${ESC_PATTERN}\\[[0-9;?]*[ -/]*[@-~]`,
  "g"
);
const ANSI_SGR_SEQUENCE_PATTERN = new RegExp(`^${ESC_PATTERN}\\[[0-9;]*m$`);
const ESCAPE_SEQUENCE_PATTERN = new RegExp(`${ESC_PATTERN}[ -/]*[@-~]`, "g");
const SGR_PLACEHOLDER_PATTERN = /\u{e000}SGR:(\d+)\u{e000}/gu;
const noopWrite = () => undefined;

function sameCursor(
  left: FixedEditorCursor | null,
  right: FixedEditorCursor | null
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return left.row === right.row && left.col === right.col;
}

export function beginSynchronizedOutput(): string {
  return "\x1b[?2026h";
}

export function endSynchronizedOutput(): string {
  return "\x1b[?2026l";
}

export function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

export function resetScrollRegion(): string {
  return "\x1b[r";
}

export function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

function clearLine(): string {
  return "\x1b[2K";
}

function hideCursor(): string {
  return "\x1b[?25l";
}

function showCursor(): string {
  return "\x1b[?25h";
}

function enterAlternateScreen(): string {
  return "\x1b[?1049h";
}

function exitAlternateScreen(): string {
  return "\x1b[?1049l";
}

function enableAlternateScrollMode(): string {
  return "\x1b[?1007h";
}

function disableAlternateScrollMode(): string {
  return "\x1b[?1007l";
}

function enableMouseReporting(): string {
  return "\x1b[?1002h\x1b[?1006h";
}

function disableMouseReporting(): string {
  return "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
}

function enableExtendedKeyboardMode(mode: ExtendedKeyboardMode): string {
  return mode === "kitty" ? "\x1b[>7u" : "\x1b[>4;2m";
}

function disableExtendedKeyboardMode(mode: ExtendedKeyboardMode): string {
  return mode === "kitty" ? "\x1b[<u" : "\x1b[>4;0m";
}

function resetExtendedKeyboardModes(): string {
  return "\x1b[<999u\x1b[>4;0m";
}

export function emergencyTerminalModeReset(): string {
  return (
    beginSynchronizedOutput() +
    resetScrollRegion() +
    disableMouseReporting() +
    enableAlternateScrollMode() +
    exitAlternateScreen() +
    resetExtendedKeyboardModes() +
    endSynchronizedOutput()
  );
}

function normalizeShortcutList(
  value: ShortcutList | undefined,
  fallback: readonly string[]
): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry) => typeof entry === "string" && entry.length > 0
    );
  }

  if (typeof value === "string" && value.length > 0) {
    return [value];
  }

  return fallback;
}

function shortcutUsesSuper(shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split("+");
  return parts.slice(0, -1).includes("super");
}

function matchesConfiguredShortcut(data: string, shortcut: string): boolean {
  const normalizedShortcut = shortcut.toLowerCase();
  if (shortcutUsesSuper(normalizedShortcut)) {
    return SUPER_SHORTCUT_PATTERNS.get(normalizedShortcut)?.test(data) ?? false;
  }

  return matchesKey(data, shortcut);
}

function matchesAnyConfiguredShortcut(
  data: string,
  shortcuts: readonly string[]
): boolean {
  return shortcuts.some((shortcut) =>
    matchesConfiguredShortcut(data, shortcut)
  );
}

function normalizeKeyboardScrollShortcuts(
  shortcuts?: KeyboardScrollShortcuts,
  scrollUpShortcuts?: ShortcutList,
  scrollDownShortcuts?: ShortcutList
): NormalizedKeyboardScrollShortcuts {
  return {
    up: normalizeShortcutList(
      scrollUpShortcuts ?? shortcuts?.up,
      DEFAULT_SCROLL_UP_SHORTCUTS
    ),
    down: normalizeShortcutList(
      scrollDownShortcuts ?? shortcuts?.down,
      DEFAULT_SCROLL_DOWN_SHORTCUTS
    ),
  };
}

function parseKeyboardScrollDelta(
  data: string,
  shortcuts: NormalizedKeyboardScrollShortcuts
): number {
  if (isKeyRelease(data)) {
    return 0;
  }

  if (
    matchesAnyConfiguredShortcut(data, shortcuts.up) ||
    matchesKey(data, "pageUp") ||
    matchesKey(data, "ctrl+shift+up") ||
    FALLBACK_SCROLL_UP_PATTERN.test(data)
  ) {
    return 10;
  }

  if (
    matchesAnyConfiguredShortcut(data, shortcuts.down) ||
    matchesKey(data, "pageDown") ||
    matchesKey(data, "ctrl+shift+down") ||
    FALLBACK_SCROLL_DOWN_PATTERN.test(data)
  ) {
    return -10;
  }

  return 0;
}

function parseSgrMousePackets(data: string): SgrMousePacket[] | null {
  const packets: SgrMousePacket[] = [];
  let offset = 0;
  SGR_MOUSE_PACKET_PATTERN.lastIndex = 0;

  for (const match of data.matchAll(SGR_MOUSE_PACKET_PATTERN)) {
    if (match.index !== offset) {
      return null;
    }
    offset = match.index + match[0].length;
    packets.push({
      code: Number(match[1]),
      col: Number(match[2]),
      row: Number(match[3]),
      final: match[4] as "M" | "m",
    });
  }

  return packets.length > 0 && offset === data.length ? packets : null;
}

function hasMouseCodeFlag(code: number, flag: number): boolean {
  return Math.trunc(code / flag) % 2 === 1;
}

function mouseBaseButton(code: number): number {
  return MOUSE_MODIFIER_FLAGS.reduce(
    (baseButton, flag) =>
      hasMouseCodeFlag(code, flag) ? baseButton - flag : baseButton,
    code
  );
}

function mouseScrollDelta(packet: SgrMousePacket): number {
  if (packet.final !== "M") {
    return 0;
  }
  const baseButton = mouseBaseButton(packet.code);
  if (baseButton === 64) {
    return 3;
  }
  if (baseButton === 65) {
    return -3;
  }
  return 0;
}

function isLeftPress(packet: SgrMousePacket): boolean {
  return (
    packet.final === "M" &&
    mouseBaseButton(packet.code) === 0 &&
    !hasMouseCodeFlag(packet.code, MOUSE_MOTION_FLAG)
  );
}

function isLeftDrag(packet: SgrMousePacket): boolean {
  return (
    packet.final === "M" &&
    mouseBaseButton(packet.code) === 0 &&
    hasMouseCodeFlag(packet.code, MOUSE_MOTION_FLAG)
  );
}

function isRightPress(packet: SgrMousePacket): boolean {
  return (
    packet.final === "M" &&
    mouseBaseButton(packet.code) === 2 &&
    !hasMouseCodeFlag(packet.code, MOUSE_MOTION_FLAG)
  );
}

function isMouseRelease(packet: SgrMousePacket): boolean {
  return packet.final === "m";
}

function stripOscSequences(line: string): string {
  return line.replace(OSC_SEQUENCE_PATTERN, "");
}

function stripNonRenderingControls(line: string): string {
  let result = "";
  for (const char of line) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1a) ||
      (code >= 0x1c && code <= 0x1f) ||
      code === 0x7f
    ) {
      continue;
    }
    result += char;
  }
  return result;
}

function stripUnsafeTerminalControls(line: string): string {
  const sgrSequences: string[] = [];
  const stripped = stripOscSequences(line)
    .replace(STRING_CONTROL_SEQUENCE_PATTERN, "")
    .replace(ANSI_CONTROL_SEQUENCE_PATTERN, (sequence) => {
      if (!ANSI_SGR_SEQUENCE_PATTERN.test(sequence)) {
        return "";
      }

      const index = sgrSequences.push(sequence) - 1;
      return `\u{e000}SGR:${index}\u{e000}`;
    })
    .replace(ESCAPE_SEQUENCE_PATTERN, "");

  return stripNonRenderingControls(stripped).replace(
    SGR_PLACEHOLDER_PATTERN,
    (_placeholder, index: string) => sgrSequences[Number(index)] ?? ""
  );
}

function stripAnsi(line: string): string {
  return stripUnsafeTerminalControls(line).replace(
    ANSI_CONTROL_SEQUENCE_PATTERN,
    ""
  );
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function sliceColumns(text: string, startCol: number, endCol: number): string {
  let col = 0;
  let result = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const width = Math.max(0, visibleWidth(segment));
    if (col >= startCol && col < endCol) {
      result += segment;
    }
    col += width;
  }
  return result;
}

function compareSelectionPoints(a: SelectionPoint, b: SelectionPoint): number {
  return a.line === b.line ? a.col - b.col : a.line - b.line;
}

function descriptorForRows(
  terminal: TerminalLike
): PropertyDescriptor | undefined {
  let target: object | null = terminal;
  while (target) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "rows");
    if (descriptor) {
      return descriptor;
    }
    target = Object.getPrototypeOf(target);
  }

  return undefined;
}

function readRows(
  terminal: TerminalLike,
  descriptor: PropertyDescriptor | undefined
): number {
  if (descriptor?.get) {
    const value = descriptor.get.call(terminal);
    return typeof value === "number" && Number.isFinite(value) ? value : 24;
  }

  if (
    typeof descriptor?.value === "number" &&
    Number.isFinite(descriptor.value)
  ) {
    return descriptor.value;
  }

  const value = Reflect.get(terminal, "rows");
  return typeof value === "number" && Number.isFinite(value) ? value : 24;
}

function sanitizeLine(line: string, width: number): string {
  const stripped = stripUnsafeTerminalControls(line);
  return visibleWidth(stripped) > width
    ? truncateToWidth(stripped, width, "", true)
    : stripped;
}

function sanitizeOverlayBaseLine(line: string, width: number): string {
  return sanitizeLine(stripOscSequences(line), width);
}

function normalizeOverlayCompositionLine(line: string): string {
  return line.includes("\t") ? line.replace(/\t/g, "   ") : line;
}

export interface RootScrollbarState {
  totalLines: number;
  viewportRows: number;
  scrollOffset: number;
}

export interface RootScrollbarThumb {
  start: number;
  size: number;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function calculateRootScrollbarThumb(
  state: RootScrollbarState
): RootScrollbarThumb | null {
  const totalLines = nonNegativeInteger(state.totalLines);
  const viewportRows = Math.max(1, nonNegativeInteger(state.viewportRows));
  if (totalLines <= viewportRows) {
    return null;
  }

  const maxScrollOffset = totalLines - viewportRows;
  const scrollOffset = Math.max(
    0,
    Math.min(nonNegativeInteger(state.scrollOffset), maxScrollOffset)
  );
  const size = Math.max(
    1,
    Math.min(
      viewportRows,
      Math.floor((viewportRows * viewportRows) / totalLines)
    )
  );
  const travel = viewportRows - size;
  const start = Math.round(
    ((maxScrollOffset - scrollOffset) / maxScrollOffset) * travel
  );

  return { start, size };
}

function rootScrollbarContentWidth(width: number): number {
  return Math.max(1, Math.trunc(width) - ROOT_SCROLLBAR_WIDTH);
}

function fitRootLineToContentWidth(line: string, contentWidth: number): string {
  if (contentWidth <= 0) {
    return "";
  }

  const fitted =
    visibleWidth(line) > contentWidth
      ? truncateToWidth(line, contentWidth, "", true)
      : line;
  return `${fitted}${" ".repeat(
    Math.max(0, contentWidth - visibleWidth(fitted))
  )}`;
}

export function decorateRootScrollbar(
  lines: readonly string[],
  state: RootScrollbarState,
  width: number
): string[] {
  const renderWidth = Math.max(1, Math.trunc(width));
  const contentWidth = Math.max(0, renderWidth - ROOT_SCROLLBAR_WIDTH);
  const thumb = calculateRootScrollbarThumb(state);

  return lines.map((line, index) => {
    const scrollbar =
      thumb && index >= thumb.start && index < thumb.start + thumb.size
        ? ROOT_SCROLLBAR_THUMB
        : ROOT_SCROLLBAR_TRACK;
    return `${fitRootLineToContentWidth(line, contentWidth)}${scrollbar}`;
  });
}

export function buildFixedClusterPaint(
  cluster: FixedEditorClusterRender,
  terminalRows: number,
  width: number,
  showHardwareCursor: boolean
): string {
  if (cluster.lines.length === 0) {
    return "";
  }

  const startRow = Math.max(1, terminalRows - cluster.lines.length + 1);
  let buffer = resetScrollRegion();

  for (let i = 0; i < cluster.lines.length; i++) {
    buffer += moveCursor(startRow + i, 1);
    buffer += clearLine();
    buffer += sanitizeLine(cluster.lines[i] ?? "", width);
  }

  buffer += buildFixedClusterCursorPaint(
    cluster,
    terminalRows,
    showHardwareCursor
  );

  return buffer;
}

function buildFixedClusterCursorPaint(
  cluster: FixedEditorClusterRender,
  terminalRows: number,
  showHardwareCursor: boolean
): string {
  if (cluster.cursor && showHardwareCursor) {
    const startRow = Math.max(1, terminalRows - cluster.lines.length + 1);
    return `${moveCursor(
      startRow + cluster.cursor.row,
      Math.max(1, cluster.cursor.col + 1)
    )}${showCursor()}`;
  }

  return hideCursor();
}

function snapshotPaintedCluster(
  cluster: FixedEditorClusterRender,
  terminalRows: number,
  width: number,
  showHardwareCursor: boolean
): PaintedCluster {
  return {
    width,
    terminalRows,
    showHardwareCursor,
    lines: cluster.lines.map((line) => sanitizeLine(line ?? "", width)),
    cursor: cluster.cursor ? { ...cluster.cursor } : null,
  };
}

function shouldFullPaintFixedCluster(
  previous: PaintedCluster,
  next: PaintedCluster
): boolean {
  return (
    previous.width !== next.width ||
    previous.terminalRows !== next.terminalRows ||
    previous.showHardwareCursor !== next.showHardwareCursor ||
    previous.lines.length !== next.lines.length
  );
}

function buildFixedClusterChangedLinePaint(
  previous: PaintedCluster,
  next: PaintedCluster
): string {
  const startRow = Math.max(1, next.terminalRows - next.lines.length + 1);
  let buffer = "";

  for (let i = 0; i < next.lines.length; i++) {
    if (previous.lines[i] === next.lines[i]) {
      continue;
    }
    buffer += moveCursor(startRow + i, 1);
    buffer += clearLine();
    buffer += next.lines[i];
  }

  if (buffer || !sameCursor(previous.cursor, next.cursor)) {
    buffer += buildFixedClusterCursorPaint(
      { lines: next.lines, cursor: next.cursor },
      next.terminalRows,
      next.showHardwareCursor
    );
  }

  return buffer;
}

export class TerminalSplitCompositor {
  private readonly tui: TuiLike;
  private readonly terminal: TerminalLike;
  private readonly renderCluster: (
    width: number,
    terminalRows: number
  ) => FixedEditorClusterRender;
  private readonly getShowHardwareCursor: () => boolean;
  private readonly mouseScroll: boolean;
  private readonly keyboardScrollShortcuts: NormalizedKeyboardScrollShortcuts;
  private readonly onCopySelection: ((text: string) => void) | null;
  private extendedKeyboardMode: ExtendedKeyboardMode | null = null;
  private readonly rowsDescriptor: PropertyDescriptor | undefined;
  private readonly originalWrite: (data: string) => void;
  private readonly originalDoRender: (() => void) | null;
  private readonly originalRender: ((width: number) => string[]) | null;
  private originalCompositeLineAt: CompositeLineAt | null = null;
  private readonly patchedRenders: RenderPatch[] = [];
  private removeInputListener: (() => void) | null = null;
  private emergencyCleanup: (() => void) | null = null;
  private mouseReportingResumeTimer: ReturnType<typeof setTimeout> | null =
    null;
  private clipboardRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private installed = false;
  private disposed = false;
  private writing = false;
  private renderPassActive = false;
  private renderPassCluster: RenderPassCluster | null = null;
  private cachedCluster: RenderPassCluster | null = null;
  private lastPaintedCluster: PaintedCluster | null = null;
  private renderingCluster = false;
  private renderingScrollableRoot = false;
  private checkingOverlay = false;
  private scrollOffset = 0;
  private maxScrollOffset = 0;
  private lastRootLineCount = 0;
  private rootLines: string[] = [];
  private visibleRootStart = 0;
  private visibleScrollableRows = 0;
  private visibleRootLines: string[] = [];
  private visibleClusterLines: string[] = [];
  private selectionArea: SelectionArea | null = null;
  private selectionAnchor: SelectionPoint | null = null;
  private selectionFocus: SelectionPoint | null = null;
  private selectionDragging = false;
  private preserveSelectionFocusOnRelease = false;
  private lastLeftPress: {
    area: SelectionArea;
    line: number;
    at: number;
  } | null = null;

  constructor(options: TerminalSplitCompositorOptions) {
    this.tui = options.tui;
    this.terminal = options.terminal;
    this.renderCluster = options.renderCluster;
    this.getShowHardwareCursor = options.getShowHardwareCursor ?? (() => false);
    this.mouseScroll = options.mouseScroll !== false;
    this.keyboardScrollShortcuts = normalizeKeyboardScrollShortcuts(
      options.keyboardScrollShortcuts,
      options.scrollUpShortcuts,
      options.scrollDownShortcuts
    );
    this.onCopySelection = options.onCopySelection ?? null;
    this.rowsDescriptor = descriptorForRows(options.terminal);
    this.originalWrite =
      typeof options.terminal.write === "function"
        ? options.terminal.write.bind(options.terminal)
        : noopWrite;
    this.originalDoRender =
      typeof options.tui.doRender === "function"
        ? options.tui.doRender.bind(options.tui)
        : null;
    this.originalRender =
      typeof options.tui.render === "function"
        ? options.tui.render.bind(options.tui)
        : null;
  }

  install(): boolean {
    if (this.installed) {
      return true;
    }
    if (typeof this.terminal.write !== "function") {
      return false;
    }

    try {
      this.originalWrite(
        beginSynchronizedOutput() +
          enterAlternateScreen() +
          this.enableAlternateScreenKeyboardMode() +
          disableAlternateScrollMode() +
          (this.mouseScroll ? enableMouseReporting() : "") +
          endSynchronizedOutput()
      );
      this.emergencyCleanup = () => {
        if (!this.disposed) {
          this.restoreTerminalStateForExit();
        }
      };
      process.once("exit", this.emergencyCleanup);

      Object.defineProperty(this.terminal, "rows", {
        configurable: true,
        get: () => this.getScrollableRows(),
      });

      if (this.originalRender) {
        this.tui.render = (width: number) => this.renderScrollableRoot(width);
      }

      if (typeof this.tui.addInputListener === "function") {
        const removeInputListener = this.tui.addInputListener((data: string) =>
          this.handleInput(data)
        );
        if (typeof removeInputListener === "function") {
          this.removeInputListener = removeInputListener;
        }
      }

      this.terminal.write = (data: string) => this.write(data);
      if (this.originalDoRender) {
        this.tui.doRender = () => {
          this.renderPassActive = true;
          this.renderPassCluster = null;
          try {
            this.originalDoRender?.();
            this.requestRepaint();
          } finally {
            this.renderPassActive = false;
            this.renderPassCluster = null;
          }
        };
      }
      if (typeof this.tui.compositeLineAt === "function") {
        this.originalCompositeLineAt = this.tui.compositeLineAt.bind(
          this.tui
        ) as CompositeLineAt;
        this.tui.compositeLineAt = (
          baseLine: string,
          overlayLine: string,
          startCol: number,
          overlayWidth: number,
          totalWidth: number
        ) =>
          this.originalCompositeLineAt?.(
            normalizeOverlayCompositionLine(baseLine),
            normalizeOverlayCompositionLine(overlayLine),
            startCol,
            overlayWidth,
            totalWidth
          ) ?? "";
      }
      this.installed = true;
      return true;
    } catch {
      this.restoreAfterFailedInstall();
      return false;
    }
  }

  hideRenderable(target: PatchedRenderable): void {
    if (this.patchedRenders.some((patch) => patch.target === target)) {
      return;
    }
    const originalRender = target.render.bind(target);
    this.patchedRenders.push({ target, originalRender });
    target.render = (width: number) =>
      this.hasVisibleOverlay() ? originalRender(width) : [];
  }

  renderHidden(target: PatchedRenderable, width: number): string[] {
    const patch = this.patchedRenders.find(
      (candidate) => candidate.target === target
    );
    const render = patch?.originalRender ?? target.render.bind(target);
    return render(width);
  }

  jumpToPreviousRootTarget(targetLines: readonly number[]): boolean {
    return this.jumpToRootTarget(targetLines, "previous");
  }

  jumpToNextRootTarget(targetLines: readonly number[]): boolean {
    return this.jumpToRootTarget(targetLines, "next");
  }

  jumpToRootBottom(): boolean {
    if (this.disposed || this.hasVisibleOverlay() || this.scrollOffset === 0) {
      return false;
    }

    this.clearSelection();
    this.lastLeftPress = null;
    this.scrollOffset = 0;
    this.requestRender();
    return true;
  }

  private jumpToRootTarget(
    targetLines: readonly number[],
    direction: "previous" | "next"
  ): boolean {
    if (this.disposed || targetLines.length === 0 || this.hasVisibleOverlay()) {
      return false;
    }

    const start = this.visibleRootStart;
    const candidates =
      direction === "previous"
        ? targetLines.filter((line) => line < start).sort((a, b) => b - a)
        : targetLines.filter((line) => line > start).sort((a, b) => a - b);

    for (const target of candidates) {
      const nextOffset = Math.max(
        0,
        Math.min(
          this.lastRootLineCount -
            Math.max(1, this.visibleScrollableRows) -
            target,
          this.maxScrollOffset
        )
      );
      if (nextOffset === this.scrollOffset) {
        continue;
      }

      this.clearSelection();
      this.lastLeftPress = null;
      this.scrollOffset = nextOffset;
      this.requestRender();
      return true;
    }

    return false;
  }

  requestRepaint(): void {
    if (this.disposed || this.hasVisibleOverlay()) {
      return;
    }
    const rawRows = this.getRawRows();
    const width = Math.max(1, this.terminal.columns || 80);
    const cluster = this.getCluster(width, rawRows);
    if (cluster.lines.length === 0) {
      return;
    }

    const paint = this.buildFixedClusterRepaint(cluster, rawRows, width);
    if (!paint) {
      return;
    }

    this.originalWrite(
      beginSynchronizedOutput() + paint + endSynchronizedOutput()
    );
  }

  private buildFixedClusterRepaint(
    cluster: FixedEditorClusterRender,
    terminalRows: number,
    width: number
  ): string {
    const decoratedCluster = this.decorateCluster(cluster);
    const showHardwareCursor = this.getShowHardwareCursor();
    const nextPaintedCluster = snapshotPaintedCluster(
      decoratedCluster,
      terminalRows,
      width,
      showHardwareCursor
    );

    const previousPaintedCluster = this.lastPaintedCluster;
    let paint: string;
    if (
      !previousPaintedCluster ||
      shouldFullPaintFixedCluster(previousPaintedCluster, nextPaintedCluster)
    ) {
      paint = buildFixedClusterPaint(
        decoratedCluster,
        terminalRows,
        width,
        showHardwareCursor
      );
    } else {
      paint = buildFixedClusterChangedLinePaint(
        previousPaintedCluster,
        nextPaintedCluster
      );
    }

    this.lastPaintedCluster = nextPaintedCluster;
    return paint;
  }

  dispose(options: DisposeOptions = {}): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const patch of this.patchedRenders.splice(0)) {
      patch.target.render = patch.originalRender;
    }

    this.removeInputListener?.();
    this.removeInputListener = null;
    if (this.emergencyCleanup) {
      process.removeListener("exit", this.emergencyCleanup);
      this.emergencyCleanup = null;
    }
    if (this.mouseReportingResumeTimer) {
      clearTimeout(this.mouseReportingResumeTimer);
      this.mouseReportingResumeTimer = null;
    }
    this.clearClipboardRestoreTimer();

    this.terminal.write = this.originalWrite;
    if (this.originalDoRender) {
      this.tui.doRender = this.originalDoRender;
    }
    if (this.originalRender) {
      this.tui.render = this.originalRender;
    }
    if (this.originalCompositeLineAt) {
      this.tui.compositeLineAt = this.originalCompositeLineAt;
      this.originalCompositeLineAt = null;
    }
    if (this.rowsDescriptor) {
      Object.defineProperty(this.terminal, "rows", this.rowsDescriptor);
    } else {
      Reflect.deleteProperty(this.terminal, "rows");
    }

    try {
      this.restoreTerminalState(options);
    } catch {
      // Disposal is best-effort; callers should still fall back to the native terminal.
    }
  }

  private restoreAfterFailedInstall(): void {
    try {
      this.installed = false;
      this.terminal.write = this.originalWrite;
      if (this.originalDoRender) {
        this.tui.doRender = this.originalDoRender;
      }
      if (this.originalRender) {
        this.tui.render = this.originalRender;
      }
      if (this.originalCompositeLineAt) {
        this.tui.compositeLineAt = this.originalCompositeLineAt;
        this.originalCompositeLineAt = null;
      }
      if (this.rowsDescriptor) {
        Object.defineProperty(this.terminal, "rows", this.rowsDescriptor);
      } else {
        Reflect.deleteProperty(this.terminal, "rows");
      }
      this.removeInputListener?.();
      this.removeInputListener = null;
      if (this.emergencyCleanup) {
        process.removeListener("exit", this.emergencyCleanup);
        this.emergencyCleanup = null;
      }

      this.restoreTerminalState({ resetExtendedKeyboardModes: true });
    } catch {
      // Failed installs must not break Pi's normal terminal path.
    }
  }

  private getRawRows(): number {
    return Math.max(2, readRows(this.terminal, this.rowsDescriptor));
  }

  private getScrollableRows(): number {
    if (
      this.disposed ||
      this.writing ||
      this.renderingCluster ||
      this.checkingOverlay ||
      this.hasVisibleOverlay()
    ) {
      return this.getRawRows();
    }

    const rawRows = this.getRawRows();
    const width = Math.max(1, this.terminal.columns || 80);
    const cluster = this.getCluster(width, rawRows);
    return Math.max(1, rawRows - cluster.lines.length);
  }

  private renderScrollableRoot(width: number): string[] {
    if (!this.originalRender || this.disposed || this.renderingScrollableRoot) {
      return this.originalRender?.(width) ?? [];
    }

    this.renderingScrollableRoot = true;
    try {
      const renderWidth = Math.max(1, width);
      if (this.hasVisibleOverlay()) {
        return this.renderOverlayRoot(renderWidth);
      }

      const rawRows = this.getRawRows();
      const cluster = this.getCluster(renderWidth, rawRows, true);
      const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
      const lines = this.originalRender(rootScrollbarContentWidth(renderWidth));
      const start = this.updateRootScrollState(lines, scrollableRows);
      const highlightedLines = this.visibleRootLines.map((line, index) =>
        this.renderSelectionHighlight(line, start + index, "root")
      );
      return decorateRootScrollbar(
        highlightedLines,
        {
          totalLines: this.rootLines.length,
          viewportRows: scrollableRows,
          scrollOffset: this.scrollOffset,
        },
        renderWidth
      );
    } finally {
      this.renderingScrollableRoot = false;
    }
  }

  private renderOverlayRoot(width: number): string[] {
    const rawRows = this.getRawRows();
    const cluster = this.getCluster(width, rawRows, true);
    const reservedRows =
      this.patchedRenders.length > 0 ? cluster.lines.length : 0;
    const lines = this.originalRender(width);
    if (reservedRows === 0) {
      return lines.map((line) => sanitizeOverlayBaseLine(line, width));
    }

    const scrollableRows = Math.max(1, rawRows - reservedRows);
    const tailCount = Math.min(reservedRows, lines.length);
    const tailStart = lines.length - tailCount;
    const rootLines = lines.slice(0, tailStart);
    const tailLines = lines.slice(tailStart);

    this.updateRootScrollState(rootLines, scrollableRows);
    return [...this.visibleRootLines, ...tailLines].map((line) =>
      sanitizeOverlayBaseLine(line, width)
    );
  }

  private updateRootScrollState(
    rootLines: string[],
    scrollableRows: number
  ): number {
    this.rootLines = rootLines;
    if (
      this.scrollOffset > 0 &&
      this.lastRootLineCount > 0 &&
      rootLines.length > this.lastRootLineCount
    ) {
      this.scrollOffset += rootLines.length - this.lastRootLineCount;
    }
    this.lastRootLineCount = rootLines.length;
    this.maxScrollOffset = Math.max(0, rootLines.length - scrollableRows);
    this.scrollOffset = Math.max(
      0,
      Math.min(this.scrollOffset, this.maxScrollOffset)
    );

    return this.updateVisibleRootWindow(scrollableRows);
  }

  private handleInput(
    data: string
  ): { consume?: boolean; data?: string } | undefined {
    if (this.disposed || this.hasVisibleOverlay()) {
      return undefined;
    }

    const mousePackets = this.mouseScroll ? parseSgrMousePackets(data) : null;
    if (mousePackets) {
      for (const packet of mousePackets) {
        this.handleMousePacket(packet);
      }
      return { consume: true };
    }

    const keyboardDelta = parseKeyboardScrollDelta(
      data,
      this.keyboardScrollShortcuts
    );
    if (keyboardDelta === 0) {
      return undefined;
    }

    this.scrollBy(keyboardDelta);
    return { consume: true };
  }

  private handleMousePacket(packet: SgrMousePacket): void {
    const delta = mouseScrollDelta(packet);
    if (delta !== 0) {
      this.selectionDragging = false;
      this.scrollBy(delta);
      return;
    }

    const location = this.selectionLocationForPacket(packet);

    if (isRightPress(packet)) {
      this.selectionDragging = false;
      this.preserveSelectionFocusOnRelease = false;
      const selectedText = this.isLocationInsideSelection(location)
        ? this.getSelectedText()
        : "";
      if (selectedText) {
        this.onCopySelection?.(selectedText);
        this.lastLeftPress = null;
        this.pauseMouseReportingForContextMenu(selectedText);
        return;
      }

      this.clearSelection();
      this.lastLeftPress = null;
      this.pauseMouseReportingForContextMenu();
      return;
    }

    if (this.scrollSelectionAtViewportEdge(packet)) {
      return;
    }
    if (this.selectionDragging && isMouseRelease(packet)) {
      this.finishSelection(packet, location);
      return;
    }

    if (!location) {
      return;
    }

    if (isLeftPress(packet)) {
      this.startSelection(location);
      return;
    }

    if (
      this.selectionDragging &&
      isLeftDrag(packet) &&
      location.area === this.selectionArea
    ) {
      this.lastLeftPress = null;
      this.preserveSelectionFocusOnRelease = false;
      this.selectionFocus = location.point;
      this.requestRender();
      return;
    }
  }

  private updateVisibleRootWindow(
    scrollableRows = this.visibleScrollableRows
  ): number {
    const rows = Math.max(1, scrollableRows);
    const start = Math.max(0, this.rootLines.length - rows - this.scrollOffset);
    const visibleLines = this.rootLines.slice(start, start + rows);
    while (visibleLines.length < rows) {
      visibleLines.push("");
    }

    this.visibleRootStart = start;
    this.visibleScrollableRows = rows;
    this.visibleRootLines = visibleLines;
    return start;
  }

  private finishSelection(
    packet: SgrMousePacket,
    location: SelectionLocation | null
  ): void {
    if (!this.preserveSelectionFocusOnRelease) {
      this.selectionFocus =
        location?.area === this.selectionArea
          ? location.point
          : this.clampedSelectionPointForPacket(packet, this.selectionArea);
    }

    this.preserveSelectionFocusOnRelease = false;
    this.selectionDragging = false;
    const selectedText = this.getSelectedText();
    if (selectedText) {
      this.lastLeftPress = null;
      this.onCopySelection?.(selectedText);
    } else {
      this.clearSelection();
    }
    this.requestRender();
  }

  private startSelection(location: SelectionLocation): void {
    const now = Date.now();
    const line = location.point.line;
    if (
      this.lastLeftPress &&
      this.lastLeftPress.area === location.area &&
      this.lastLeftPress.line === line &&
      now - this.lastLeftPress.at <= DOUBLE_CLICK_MS
    ) {
      this.selectionArea = location.area;
      this.selectionAnchor = { line, col: 0 };
      this.selectionFocus = {
        line,
        col: this.selectionLineWidth(location.area, line),
      };
      this.selectionDragging = true;
      this.preserveSelectionFocusOnRelease = true;
      this.lastLeftPress = null;
      this.requestRender();
      return;
    }

    this.selectionArea = location.area;
    this.selectionAnchor = location.point;
    this.selectionFocus = location.point;
    this.selectionDragging = true;
    this.preserveSelectionFocusOnRelease = false;
    this.lastLeftPress = { area: location.area, line, at: now };
    this.requestRender();
  }

  private selectionLocationForPacket(
    packet: SgrMousePacket
  ): SelectionLocation | null {
    if (packet.row < 1) {
      return null;
    }

    const col = Math.max(0, packet.col - 1);
    if (packet.row <= this.visibleScrollableRows) {
      return {
        area: "root",
        point: { line: this.visibleRootStart + packet.row - 1, col },
      };
    }

    const clusterLine = packet.row - this.visibleScrollableRows - 1;
    if (clusterLine >= this.visibleClusterLines.length) {
      return null;
    }

    return {
      area: "cluster",
      point: { line: clusterLine, col },
    };
  }

  private scrollSelectionAtViewportEdge(packet: SgrMousePacket): boolean {
    if (
      !this.selectionDragging ||
      this.selectionArea !== "root" ||
      !isLeftDrag(packet)
    ) {
      return false;
    }

    let delta = 0;
    if (packet.row <= 1) {
      delta = 1;
    } else if (packet.row >= this.visibleScrollableRows) {
      delta = -1;
    }
    if (delta === 0) {
      return false;
    }

    const nextOffset = Math.max(
      0,
      Math.min(this.scrollOffset + delta, this.maxScrollOffset)
    );
    if (nextOffset === this.scrollOffset) {
      return false;
    }

    this.lastLeftPress = null;
    this.preserveSelectionFocusOnRelease = true;
    this.scrollOffset = nextOffset;
    const start = this.updateVisibleRootWindow();
    const edgeLine =
      delta > 0 ? start : start + Math.max(0, this.visibleScrollableRows - 1);
    this.selectionFocus = {
      line: edgeLine,
      col: Math.max(0, packet.col - 1),
    };
    this.requestRender();
    return true;
  }

  private clampedSelectionPointForPacket(
    packet: SgrMousePacket,
    area: SelectionArea | null
  ): SelectionPoint {
    if (area === "cluster") {
      return {
        line: Math.max(
          0,
          Math.min(
            packet.row - this.visibleScrollableRows - 1,
            this.visibleClusterLines.length - 1
          )
        ),
        col: Math.max(0, packet.col - 1),
      };
    }

    const row = Math.max(1, Math.min(packet.row, this.visibleScrollableRows));
    return {
      line: this.visibleRootStart + row - 1,
      col: Math.max(0, packet.col - 1),
    };
  }

  private renderSelectionHighlight(
    line: string,
    lineIndex: number,
    area: SelectionArea
  ): string {
    const range = this.getSelectionRangeForLine(lineIndex, area);
    if (!range) {
      return line;
    }

    const plain = stripAnsi(line);
    const startCol = Math.max(0, Math.min(range.startCol, visibleWidth(plain)));
    const endCol = Math.max(
      startCol,
      Math.min(range.endCol, visibleWidth(plain))
    );
    if (startCol === endCol) {
      return line;
    }

    const before = sliceColumns(plain, 0, startCol);
    const selected = sliceColumns(plain, startCol, endCol);
    const after = sliceColumns(plain, endCol, Number.POSITIVE_INFINITY);
    return `${before}\x1b[7m${selected}\x1b[27m${after}`;
  }

  private selectionLineWidth(area: SelectionArea, lineIndex: number): number {
    const lines =
      area === "root" ? this.visibleRootLines : this.visibleClusterLines;
    const firstLine = area === "root" ? this.visibleRootStart : 0;
    return visibleWidth(stripAnsi(lines[lineIndex - firstLine] ?? ""));
  }

  private getSelectedText(): string {
    if (!this.selectionArea) {
      return "";
    }

    const bounds = this.getSelectionBounds();
    if (!bounds) {
      return "";
    }

    const { start, end } = bounds;
    if (start.line === end.line && start.col === end.col) {
      return "";
    }

    const lines =
      this.selectionArea === "root" ? this.rootLines : this.visibleClusterLines;
    const selected: string[] = [];
    for (let lineIndex = start.line; lineIndex <= end.line; lineIndex++) {
      const line = stripAnsi(lines[lineIndex] ?? "");
      const startCol = lineIndex === start.line ? start.col : 0;
      const endCol =
        lineIndex === end.line ? end.col : Number.POSITIVE_INFINITY;
      selected.push(sliceColumns(line, startCol, endCol));
    }

    return selected
      .join("\n")
      .replace(/[ \t]+$/gm, "")
      .trimEnd();
  }

  private getSelectionBounds(): SelectionBounds | null {
    if (!(this.selectionAnchor && this.selectionFocus)) {
      return null;
    }

    if (
      compareSelectionPoints(this.selectionAnchor, this.selectionFocus) <= 0
    ) {
      return { start: this.selectionAnchor, end: this.selectionFocus };
    }

    return { start: this.selectionFocus, end: this.selectionAnchor };
  }

  private getSelectionRangeForLine(
    lineIndex: number,
    area: SelectionArea
  ): { startCol: number; endCol: number } | null {
    if (this.selectionArea !== area) {
      return null;
    }

    const bounds = this.getSelectionBounds();
    if (
      !bounds ||
      lineIndex < bounds.start.line ||
      lineIndex > bounds.end.line
    ) {
      return null;
    }

    return {
      startCol: lineIndex === bounds.start.line ? bounds.start.col : 0,
      endCol:
        lineIndex === bounds.end.line
          ? bounds.end.col
          : Number.POSITIVE_INFINITY,
    };
  }

  private isLocationInsideSelection(
    location: SelectionLocation | null
  ): boolean {
    if (!location || location.area !== this.selectionArea) {
      return false;
    }
    const range = this.getSelectionRangeForLine(
      location.point.line,
      location.area
    );
    return Boolean(
      range &&
        location.point.col >= range.startCol &&
        location.point.col < range.endCol
    );
  }

  private scrollBy(delta: number): void {
    const nextOffset = Math.max(
      0,
      Math.min(this.scrollOffset + delta, this.maxScrollOffset)
    );
    if (nextOffset === this.scrollOffset) {
      return;
    }

    this.clearSelection();
    this.lastLeftPress = null;
    this.scrollOffset = nextOffset;
    this.requestRender();
  }

  private requestRender(): void {
    if (typeof this.tui.requestRender === "function") {
      this.tui.requestRender();
    }
  }

  private clearClipboardRestoreTimer(): void {
    if (!this.clipboardRestoreTimer) {
      return;
    }

    clearTimeout(this.clipboardRestoreTimer);
    this.clipboardRestoreTimer = null;
  }

  private pauseMouseReportingForContextMenu(
    textToRestoreToClipboard: string | null = null
  ): void {
    if (this.mouseReportingResumeTimer) {
      clearTimeout(this.mouseReportingResumeTimer);
    }
    this.clearClipboardRestoreTimer();

    this.originalWrite(
      beginSynchronizedOutput() +
        disableMouseReporting() +
        endSynchronizedOutput()
    );
    this.mouseReportingResumeTimer = setTimeout(() => {
      this.mouseReportingResumeTimer = null;
      if (!this.disposed) {
        this.originalWrite(
          beginSynchronizedOutput() +
            enableMouseReporting() +
            endSynchronizedOutput()
        );
      }
    }, CONTEXT_MENU_MOUSE_REPORTING_PAUSE_MS);

    if (
      typeof this.mouseReportingResumeTimer === "object" &&
      "unref" in this.mouseReportingResumeTimer
    ) {
      this.mouseReportingResumeTimer.unref();
    }

    const restoreClipboard = this.onCopySelection;
    if (!(textToRestoreToClipboard && restoreClipboard)) {
      return;
    }

    let remainingRestores = Math.ceil(
      CONTEXT_MENU_SELECTION_RESTORE_WINDOW_MS /
        CONTEXT_MENU_CLIPBOARD_RESTORE_INTERVAL_MS
    );
    const scheduleClipboardRestore = () => {
      this.clipboardRestoreTimer = setTimeout(() => {
        this.clipboardRestoreTimer = null;
        if (this.disposed) {
          return;
        }

        remainingRestores -= 1;
        if (this.getSelectedText() !== textToRestoreToClipboard) {
          return;
        }

        restoreClipboard(textToRestoreToClipboard);
        if (remainingRestores > 0) {
          scheduleClipboardRestore();
        }
      }, CONTEXT_MENU_CLIPBOARD_RESTORE_INTERVAL_MS);

      if (
        typeof this.clipboardRestoreTimer === "object" &&
        "unref" in this.clipboardRestoreTimer
      ) {
        this.clipboardRestoreTimer.unref();
      }
    };

    scheduleClipboardRestore();
  }

  private clearSelection(): void {
    this.selectionArea = null;
    this.selectionAnchor = null;
    this.selectionFocus = null;
    this.selectionDragging = false;
    this.preserveSelectionFocusOnRelease = false;
  }

  private activeExtendedKeyboardMode(): ExtendedKeyboardMode | null {
    if (this.terminal.kittyProtocolActive === true) {
      return "kitty";
    }
    if (Reflect.get(this.terminal, "_modifyOtherKeysActive") === true) {
      return "modifyOtherKeys";
    }
    return null;
  }

  private enableAlternateScreenKeyboardMode(): string {
    this.extendedKeyboardMode = this.activeExtendedKeyboardMode();
    return this.extendedKeyboardMode
      ? enableExtendedKeyboardMode(this.extendedKeyboardMode)
      : "";
  }

  private restoreTerminalState(options: DisposeOptions = {}): void {
    const activeMode =
      this.extendedKeyboardMode ?? this.activeExtendedKeyboardMode();
    const restoreMainScreenMode =
      !options.resetExtendedKeyboardModes &&
      this.extendedKeyboardMode === null &&
      activeMode !== null;

    this.originalWrite(
      beginSynchronizedOutput() +
        resetScrollRegion() +
        (this.mouseScroll ? disableMouseReporting() : "") +
        (activeMode ? disableExtendedKeyboardMode(activeMode) : "") +
        enableAlternateScrollMode() +
        exitAlternateScreen() +
        (restoreMainScreenMode && activeMode
          ? enableExtendedKeyboardMode(activeMode)
          : "") +
        (options.resetExtendedKeyboardModes
          ? resetExtendedKeyboardModes()
          : "") +
        endSynchronizedOutput()
    );
  }

  private restoreTerminalStateForExit(): void {
    try {
      this.restoreTerminalState({ resetExtendedKeyboardModes: true });
    } catch {
      // Process-exit cleanup cannot report useful errors and must not throw.
    }
  }

  private write(data: string): void {
    if (this.disposed || this.writing || this.hasVisibleOverlay()) {
      this.originalWrite(data);
      return;
    }

    this.writing = true;
    try {
      const rawRows = this.getRawRows();
      const width = Math.max(1, this.terminal.columns || 80);
      const cluster = this.getCluster(width, rawRows);
      const reservedRows = cluster.lines.length;

      if (reservedRows === 0 || rawRows <= 2) {
        this.originalWrite(data);
        return;
      }

      const scrollBottom = Math.max(1, rawRows - reservedRows);
      let hardwareCursorRow = 0;
      if (typeof this.tui.hardwareCursorRow === "number") {
        hardwareCursorRow = this.tui.hardwareCursorRow;
      } else if (typeof this.tui.cursorRow === "number") {
        hardwareCursorRow = this.tui.cursorRow;
      }
      const viewportTop =
        typeof this.tui.previousViewportTop === "number"
          ? this.tui.previousViewportTop
          : 0;
      const screenRow = Math.max(
        1,
        Math.min(scrollBottom, hardwareCursorRow - viewportTop + 1)
      );
      const buffer =
        beginSynchronizedOutput() +
        setScrollRegion(1, scrollBottom) +
        moveCursor(screenRow, 1) +
        data +
        resetScrollRegion() +
        this.buildFixedClusterRepaint(cluster, rawRows, width) +
        endSynchronizedOutput();

      this.originalWrite(buffer);
    } finally {
      this.writing = false;
    }
  }

  private getCluster(
    width: number,
    terminalRows: number,
    forceRefresh = false
  ): FixedEditorClusterRender {
    if (
      !forceRefresh &&
      this.renderPassActive &&
      this.renderPassCluster?.width === width &&
      this.renderPassCluster.terminalRows === terminalRows
    ) {
      return this.renderPassCluster.cluster;
    }

    if (
      !(forceRefresh || this.renderPassActive) &&
      this.cachedCluster?.width === width &&
      this.cachedCluster.terminalRows === terminalRows
    ) {
      return this.cachedCluster.cluster;
    }

    const cluster = this.withClusterRender(() =>
      this.renderCluster(width, terminalRows)
    );
    const cachedCluster = { width, terminalRows, cluster };
    this.visibleClusterLines = cluster.lines;
    this.cachedCluster = cachedCluster;
    if (this.renderPassActive) {
      this.renderPassCluster = cachedCluster;
    }
    return cluster;
  }

  private decorateCluster(
    cluster: FixedEditorClusterRender
  ): FixedEditorClusterRender {
    if (this.selectionArea !== "cluster") {
      return cluster;
    }

    return {
      ...cluster,
      lines: cluster.lines.map((line, index) =>
        this.renderSelectionHighlight(line, index, "cluster")
      ),
    };
  }

  private withClusterRender<T>(render: () => T): T {
    const wasRenderingCluster = this.renderingCluster;
    this.renderingCluster = true;
    try {
      return render();
    } finally {
      this.renderingCluster = wasRenderingCluster;
    }
  }

  private hasVisibleOverlay(): boolean {
    if (this.checkingOverlay) {
      return false;
    }

    this.checkingOverlay = true;
    try {
      let hasVisibleOverlay = false;
      if (typeof this.tui.hasOverlay === "function" && this.tui.hasOverlay()) {
        hasVisibleOverlay = true;
      }

      if (!hasVisibleOverlay) {
        const overlayStack = Reflect.get(this.tui, "overlayStack");
        hasVisibleOverlay =
          Array.isArray(overlayStack) &&
          overlayStack.some((entry) => entry && entry.hidden !== true);
      }

      if (hasVisibleOverlay) {
        this.lastPaintedCluster = null;
      }
      return hasVisibleOverlay;
    } finally {
      this.checkingOverlay = false;
    }
  }
}
