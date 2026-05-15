import { describe, expect, it } from "bun:test";

import type {
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { Container, TUI } from "@earendil-works/pi-tui";

import { EnhancedEditor } from "../enhanced-editor";
import { renderFixedEditorCluster } from "./cluster";
import {
  acquireReplacementSurfaceLease,
  attachReplacementLeaseCompositor,
  clearReplacementSurfaceLeases,
} from "./replacement-lease";
import { TerminalSplitCompositor } from "./terminal-split";

const RESET = "\x1b[0m";
const BORDER = "\x1b[38;2;102;92;84m";
const QUESTIONNAIRE = "\x1b[38;2;254;128;25m";
const ESC_PATTERN = "\\x1b";
const BEL_PATTERN = "\\x07";
const SGR_PATTERN = new RegExp(`^${ESC_PATTERN}\\[([0-9;]*)m`, "u");
const MOVE_PATTERN = new RegExp(`^${ESC_PATTERN}\\[(\\d+);(\\d+)H`, "u");
const COLUMN_PATTERN = new RegExp(`^${ESC_PATTERN}\\[(\\d+)G`, "u");
const UP_PATTERN = new RegExp(`^${ESC_PATTERN}\\[(\\d+)A`, "u");
const DOWN_PATTERN = new RegExp(`^${ESC_PATTERN}\\[(\\d+)B`, "u");
const SCROLL_REGION_PATTERN = new RegExp(`^${ESC_PATTERN}\\[\\d+;\\d+r`, "u");
const PRIVATE_SEQUENCE_PATTERN = new RegExp(
  `^${ESC_PATTERN}\\[\\?[0-9;]*[hl]`,
  "u"
);
const GENERIC_CSI_PATTERN = new RegExp(
  `^${ESC_PATTERN}\\[[0-9;?]*[A-Za-z]`,
  "u"
);
const OSC_PATTERN = new RegExp(
  `^${ESC_PATTERN}\\].*?(?:${BEL_PATTERN}|${ESC_PATTERN}\\\\)`,
  "su"
);
const EDITOR_ROW_PATTERN = /[╭╰│]|hello/u;

class StyledTerminal {
  columns = 72;
  rows = 14;
  kittyProtocolActive = false;
  readonly writes: string[] = [];
  private row = 1;
  private col = 1;
  private fg = "default";
  private readonly cells: Array<Array<{ char: string; fg: string }>>;

  constructor() {
    this.cells = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.columns }, () => ({ char: " ", fg: "default" }))
    );
  }

  start(): void {
    // noop for e2e harness
  }

  stop(): void {
    // noop for e2e harness
  }

  hideCursor(): void {
    // noop for e2e harness
  }

  showCursor(): void {
    // noop for e2e harness
  }

  primeQuestionnaireColor(): void {
    this.fg = QUESTIONNAIRE;
  }

  write(data: string): void {
    this.writes.push(data);
    this.apply(data);
  }

  rowsWithTextMatching(
    pattern: RegExp
  ): Array<Array<{ char: string; fg: string }>> {
    return this.cells.filter((row) =>
      pattern.test(row.map((cell) => cell.char).join(""))
    );
  }

  debugRows(): string[] {
    return this.cells.map((row) => row.map((cell) => cell.char).join(""));
  }

  private apply(data: string): void {
    let index = 0;
    while (index < data.length) {
      if (data[index] === "\x1b") {
        const consumed = this.applyEscape(data.slice(index));
        if (consumed > 0) {
          index += consumed;
          continue;
        }
      }

      const char = data[index];
      if (char === "\r") {
        this.col = 1;
      } else if (char === "\n") {
        this.row = Math.min(this.rows, this.row + 1);
        this.col = 1;
      } else if (char && char >= " ") {
        this.put(char);
      }
      index += 1;
    }
  }

  private applyEscape(data: string): number {
    const sgr = SGR_PATTERN.exec(data);
    if (sgr) {
      this.applySgr(sgr[1] ?? "0");
      return sgr[0].length;
    }

    if (data.startsWith("\x1b[H")) {
      this.row = 1;
      this.col = 1;
      return "\x1b[H".length;
    }

    if (data.startsWith("\x1b[2J")) {
      this.clearScreen();
      return "\x1b[2J".length;
    }

    if (data.startsWith("\x1b[3J")) {
      this.clearScreen();
      return "\x1b[3J".length;
    }

    const move = MOVE_PATTERN.exec(data);
    if (move) {
      this.row = this.clamp(Number(move[1]), 1, this.rows);
      this.col = this.clamp(Number(move[2]), 1, this.columns);
      return move[0].length;
    }

    const column = COLUMN_PATTERN.exec(data);
    if (column) {
      this.col = this.clamp(Number(column[1]), 1, this.columns);
      return column[0].length;
    }

    const up = UP_PATTERN.exec(data);
    if (up) {
      this.row = this.clamp(this.row - Number(up[1]), 1, this.rows);
      return up[0].length;
    }

    const down = DOWN_PATTERN.exec(data);
    if (down) {
      this.row = this.clamp(this.row + Number(down[1]), 1, this.rows);
      return down[0].length;
    }

    if (data.startsWith("\x1b[2K")) {
      this.clearLine();
      this.col = 1;
      return "\x1b[2K".length;
    }

    if (data.startsWith("\x1b[r")) {
      return "\x1b[r".length;
    }

    const scrollRegion = SCROLL_REGION_PATTERN.exec(data);
    if (scrollRegion) {
      return scrollRegion[0].length;
    }

    const privateSequence = PRIVATE_SEQUENCE_PATTERN.exec(data);
    if (privateSequence) {
      return privateSequence[0].length;
    }

    const genericCsi = GENERIC_CSI_PATTERN.exec(data);
    if (genericCsi) {
      return genericCsi[0].length;
    }

    const osc = OSC_PATTERN.exec(data);
    if (osc) {
      return osc[0].length;
    }

    return 0;
  }

  private applySgr(params: string): void {
    const parts = params.length > 0 ? params.split(";").map(Number) : [0];
    if (parts.includes(0)) {
      this.fg = "default";
      return;
    }
    const rgbIndex = parts.findIndex(
      (part, index) => part === 38 && parts[index + 1] === 2
    );
    if (rgbIndex !== -1) {
      this.fg = `\x1b[38;2;${parts[rgbIndex + 2]};${parts[rgbIndex + 3]};${parts[rgbIndex + 4]}m`;
    }
  }

  private put(char: string): void {
    if (this.row < 1 || this.row > this.rows || this.col > this.columns) {
      return;
    }
    this.cells[this.row - 1][this.col - 1] = { char, fg: this.fg };
    this.col += 1;
  }

  private clearLine(): void {
    const target = this.cells[this.row - 1];
    if (!target) {
      return;
    }
    for (let index = 0; index < target.length; index++) {
      target[index] = { char: " ", fg: this.fg };
    }
  }

  private clearScreen(): void {
    for (const row of this.cells) {
      for (let index = 0; index < row.length; index++) {
        row[index] = { char: " ", fg: this.fg };
      }
    }
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}

class MutableChat {
  lines = ["chat"];

  render(): string[] {
    return this.lines;
  }

  invalidate(): void {
    // noop
  }
}

function createEditor(tui: TUI): EnhancedEditor {
  const keybindings = {
    matches: () => false,
    getKeys: () => [],
  } as unknown as KeybindingsManager;
  const ui = {
    notify() {
      // noop
    },
    theme: {
      fg(_color: string, text: string) {
        return text;
      },
    },
  } as unknown as ExtensionUIContext;

  return new EnhancedEditor(
    tui,
    {
      borderColor: (value: string) => `${BORDER}${value}${RESET}`,
      selectList: {},
    },
    keybindings,
    ui,
    {
      getDoubleEscapeCommand: () => null,
      canTriggerDoubleEscapeCommand: () => false,
      commandRemap: {},
      editorChrome: { style: "amp" },
      statusBar: {
        config: { enabled: false, preset: "default" },
        getContext: () => null as ExtensionContext | null,
        getFooterData: () => null as ReadonlyFooterDataProvider | null,
      },
    }
  );
}

describe("fixed editor questionnaire color restore e2e", () => {
  it("does not leave questionnaire color anywhere in the restored Amp editor", () => {
    clearReplacementSurfaceLeases();
    const terminal = new StyledTerminal();
    const tui = new TUI(terminal as never, false);
    const chat = new MutableChat();
    const editorContainer = new Container();
    const editor = createEditor(tui);
    editor.setText("hello");
    editorContainer.addChild(editor);
    tui.addChild(chat);
    tui.addChild(editorContainer);

    const compositor = new TerminalSplitCompositor({
      tui: tui as never,
      terminal: terminal as never,
      getShowHardwareCursor: () => false,
      renderCluster: (width, terminalRows) =>
        renderFixedEditorCluster({
          width,
          terminalRows,
          ...editor.renderFixedEditorParts(width),
        }),
    });
    expect(compositor.install()).toBe(true);
    compositor.hideRenderable(editor);
    attachReplacementLeaseCompositor(compositor);
    tui.doRender();

    const lease = acquireReplacementSurfaceLease({
      owner: "questionnaire",
      id: "custom-ui",
      target: {
        render: () => [
          `${QUESTIONNAIRE}questionnaire${RESET}`,
          `${QUESTIONNAIRE}Cancelled${RESET}`,
        ],
      },
    });
    tui.doRender();

    lease.release();
    chat.lines = [
      `${QUESTIONNAIRE}Question cancelled.${RESET}`,
      "Ask again if want.",
    ];
    terminal.primeQuestionnaireColor();
    tui.doRender();

    const editorRows = terminal.rowsWithTextMatching(EDITOR_ROW_PATTERN);
    expect(editorRows.length).toBeGreaterThan(0);
    for (const row of editorRows) {
      expect(row.some((cell) => cell.fg === QUESTIONNAIRE)).toBe(false);
    }

    clearReplacementSurfaceLeases();
    attachReplacementLeaseCompositor(null);
  });
});
