import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  ReadonlyFooterDataProvider,
  Theme,
} from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";

import { createPieditorComposition } from "./composition";

const originalHome = process.env.HOME;
const tempRoots: string[] = [];

type EditorFactory = NonNullable<
  Parameters<ExtensionUIContext["setEditorComponent"]>[0]
>;
type FooterFactory = NonNullable<
  Parameters<ExtensionUIContext["setFooter"]>[0]
>;

interface HarnessOptions {
  fixedEditorEnabled: boolean;
  terminalWrite?: (data: string) => void;
  copySelection?: (text: string) => void;
}

interface MockTui {
  terminal: {
    columns: number;
    rows: number;
    kittyProtocolActive: boolean;
    write?: (data: string) => void;
  };
  render: (width: number) => string[];
  doRender: () => void;
  addInputListener: (
    listener: (data: string) => { consume?: boolean; data?: string } | undefined
  ) => () => void;
  requestRender: () => void;
  getShowHardwareCursor: () => boolean;
  hasOverlay: () => boolean;
  compositeLineAt: (
    baseLine: string,
    overlayLine: string,
    startCol: number,
    overlayWidth: number,
    totalWidth: number
  ) => string;
  requestRenderCount: number;
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pieditor-composition-"));
  tempRoots.push(dir);
  return dir;
}

function writePieditorConfig(
  homeDir: string,
  fixedEditorEnabled: boolean
): void {
  const configPath = join(homeDir, ".pi", "agent", "pieditor.json");
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      fixedEditor: { enabled: fixedEditorEnabled },
      filePicker: { previewHighlightMode: "builtin" },
      statusBar: { enabled: false },
    }),
    "utf-8"
  );
}

function createMockTui(terminalWrite?: (data: string) => void): MockTui {
  const listeners: Array<
    (data: string) => { consume?: boolean; data?: string } | undefined
  > = [];

  return {
    terminal: {
      columns: 80,
      rows: 24,
      kittyProtocolActive: false,
      write: terminalWrite,
    },
    render: () => ["chat"],
    doRender() {
      // The compositor patches this method during install.
    },
    addInputListener(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
    },
    requestRender() {
      this.requestRenderCount += 1;
    },
    getShowHardwareCursor: () => true,
    hasOverlay: () => false,
    compositeLineAt: (baseLine) => baseLine,
    requestRenderCount: 0,
  };
}

function createFooterData(): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => undefined,
    getExtensionStatuses: () => ({}),
    getAvailableProviderCount: () => 0,
    onBranchChange: () => () => undefined,
  } as ReadonlyFooterDataProvider;
}

function createHarness(options: HarnessOptions) {
  const root = createTempDir();
  const homeDir = join(root, "home");
  process.env.HOME = homeDir;
  writePieditorConfig(homeDir, options.fixedEditorEnabled);

  let editorFactory: EditorFactory | undefined;
  let footerFactory: FooterFactory | undefined;
  const notifications: Array<{ message: string; level: string | undefined }> =
    [];

  const pi = {
    getCommands: () => [],
  } as unknown as ExtensionAPI;

  const ui = {
    setEditorComponent(factory: EditorFactory | undefined) {
      editorFactory = factory;
    },
    setFooter(factory: FooterFactory | undefined) {
      footerFactory = factory;
    },
    notify(message: string, level?: string) {
      notifications.push({ message, level });
    },
    theme: {},
  } as unknown as ExtensionUIContext;

  const ctx = {
    hasUI: true,
    ui,
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as unknown as ExtensionContext;

  const composition = createPieditorComposition(pi, {
    copySelection: options.copySelection,
  });
  composition.attachEditor(ctx);

  if (!(editorFactory && footerFactory)) {
    throw new Error("pieditor did not register editor and footer factories");
  }

  const tui = createMockTui(options.terminalWrite);
  const theme = {
    borderColor: (value: string) => value,
    selectList: {},
  } as unknown as EditorTheme;
  const keybindings = {
    matches: () => false,
    getKeys: () => [],
  } as unknown as KeybindingsManager;

  return {
    composition,
    footerData: createFooterData(),
    footerFactory,
    keybindings,
    notifications,
    theme,
    tui,
    createEditor() {
      return editorFactory(tui as unknown as TUI, theme, keybindings);
    },
    createFooter() {
      return footerFactory(
        tui as unknown as TUI,
        {} as unknown as Theme,
        this.footerData
      );
    },
  };
}

afterEach(() => {
  process.env.HOME = originalHome;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("pieditor fixed editor composition", () => {
  it("installs after editor and footer refs are available", () => {
    const writes: string[] = [];
    const harness = createHarness({
      fixedEditorEnabled: true,
      terminalWrite: (data) => writes.push(data),
    });

    const editor = harness.createEditor();
    expect(editor.render(80).length).toBeGreaterThan(0);

    const footer = harness.createFooter();
    expect(writes.length).toBeGreaterThan(0);
    expect(editor.render(80)).toEqual([]);

    footer.dispose?.();
    expect(editor.render(80).length).toBeGreaterThan(0);
  });

  it("toggles fixed editor live and disposes on detach", () => {
    const harness = createHarness({
      fixedEditorEnabled: false,
      terminalWrite: () => undefined,
    });

    const editor = harness.createEditor();
    harness.createFooter();
    expect(editor.render(80).length).toBeGreaterThan(0);

    harness.composition.setFixedEditorEnabled(true);
    expect(editor.render(80)).toEqual([]);

    harness.composition.setFixedEditorEnabled(false);
    expect(editor.render(80).length).toBeGreaterThan(0);

    harness.composition.setFixedEditorEnabled(true);
    expect(editor.render(80)).toEqual([]);

    harness.composition.detachEditor();
    expect(editor.render(80).length).toBeGreaterThan(0);
  });

  it("fails open with a warning when compositor install fails", () => {
    const harness = createHarness({ fixedEditorEnabled: true });

    const editor = harness.createEditor();
    harness.createFooter();

    expect(editor.render(80).length).toBeGreaterThan(0);
    expect(harness.notifications).toContainEqual({
      message:
        "pieditor fixed-editor could not attach; using the normal editor",
      level: "warning",
    });
  });
});
