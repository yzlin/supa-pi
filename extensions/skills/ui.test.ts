import { describe, expect, it } from "bun:test";

import {
  type Component,
  type Terminal,
  TuiAltScreen,
} from "@earendil-works/pi-tui";

import type { ManagedSkillEntry } from "./core";
import { buildSkillInventoryModel } from "./model";
import {
  createInitialSkillsInstallPickerState,
  createSkillsInstallPickerComponent,
  createSkillsManagerComponent,
  reduceSkillsInstallPickerState,
  renderSkillsInstallPicker,
  renderSkillsManager,
  SKILLS_MANAGER_OVERLAY_OPTIONS,
} from "./ui";

function managedSkill(
  overrides: Partial<ManagedSkillEntry> = {}
): ManagedSkillEntry {
  return {
    id: "managed-demo",
    name: "Managed Demo",
    description: "Does managed work.",
    source: {
      type: "github",
      path: "acme/demo",
      id: "source-id",
      owner: "acme",
      repo: "demo",
      ref: "main",
      subpath: "skills/demo",
    },
    installPath: "/repo/.pi/skills/managed-demo",
    installedAt: "2026-05-21T00:00:00.000Z",
    files: [],
    ...overrides,
  };
}

function inventory() {
  return buildSkillInventoryModel({
    managed: [managedSkill()],
    bundledSkillPaths: ["/repo/skills/bundled-demo/SKILL.md"],
    cwd: "/repo",
    dirtyIds: new Set(["managed-demo"]),
  });
}

function inventoryWithSkillContent(
  skillContent = "# Managed Demo\n\nFull skill docs."
) {
  const base = inventory();
  return {
    ...base,
    managed: [
      {
        ...base.managed[0],
        skillContent,
      },
    ],
    bundled: base.bundled,
    all: [
      {
        ...base.managed[0],
        skillContent,
      },
      ...base.bundled,
    ],
  };
}

function inventoryWithManyBundled(count: number) {
  return buildSkillInventoryModel({
    managed: [managedSkill()],
    bundledSkillPaths: Array.from(
      { length: count },
      (_, index) => `/repo/skills/bundled-${index}/SKILL.md`
    ),
    cwd: "/repo",
  });
}

const LEGACY_ESCAPE = "\u001b";
const KITTY_ESCAPE = "\u001b[27u";
const LEGACY_CTRL_B = "\u0002";
const LEGACY_CTRL_F = "\u0006";
const LEGACY_CTRL_N = "\u000e";
const LEGACY_CTRL_P = "\u0010";
const LEGACY_PAGE_DOWN = "\u001b[6~";
const LEGACY_PAGE_UP = "\u001b[5~";
const KITTY_CTRL_B = "\u001b[98;5u";
const KITTY_CTRL_F = "\u001b[102;5u";

const IGNORED_CTRL_NAVIGATION_KEYS = [LEGACY_CTRL_N, LEGACY_CTRL_P] as const;
const PAGE_NAVIGATION_KEY_PAIRS = [
  [LEGACY_CTRL_F, LEGACY_CTRL_B],
  [KITTY_CTRL_F, KITTY_CTRL_B],
  [LEGACY_PAGE_DOWN, LEGACY_PAGE_UP],
] as const;

interface NavigationTestComponent {
  readonly state: { readonly selectedIndex: number };
  handleInput(data: string): void;
}

class TestTerminal implements Terminal {
  readonly columns = 100;
  readonly rows = 40;
  readonly kittyProtocolActive = false;
  onInput?: (data: string) => void;

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }

  stop(): void {
    // Test terminal has no resources.
  }
  drainInput(): Promise<void> {
    return Promise.resolve();
  }
  write(): void {
    // Test ignores terminal output.
  }
  moveBy(): void {
    // Test does not emulate cursor movement.
  }
  hideCursor(): void {
    // Test does not emulate cursor visibility.
  }
  showCursor(): void {
    // Test does not emulate cursor visibility.
  }
  clearLine(): void {
    // Test does not emulate screen clearing.
  }
  clearFromCursor(): void {
    // Test does not emulate screen clearing.
  }
  clearScreen(): void {
    // Test does not emulate screen clearing.
  }
  setTitle(): void {
    // Test ignores terminal title changes.
  }
  setProgress(): void {
    // Test ignores terminal progress changes.
  }
}

const transcript: Component = {
  invalidate() {
    // Static test transcript has no cache.
  },
  render() {
    return Array.from({ length: 100 }, (_, index) => `transcript-${index}`);
  },
};

function expectPageShortcutHelp(text: string): void {
  expect(text).toContain("ctrl+b/ctrl+f page");
  expect(text).not.toContain("ctrl+p");
  expect(text).not.toContain("ctrl+n");
}

function expectIgnoredCtrlNavigationKeys(
  component: NavigationTestComponent
): void {
  for (const key of IGNORED_CTRL_NAVIGATION_KEYS) {
    component.handleInput(key);
    expect(component.state.selectedIndex).toBe(0);
  }
}

function expectPageNavigationKeys(component: NavigationTestComponent): void {
  for (const [pageDownKey, pageUpKey] of PAGE_NAVIGATION_KEY_PAIRS) {
    component.handleInput(pageDownKey);
    expect(component.state.selectedIndex).toBeGreaterThan(1);

    component.handleInput(pageUpKey);
    expect(component.state.selectedIndex).toBe(0);
  }
}

describe("skills install picker UI", () => {
  it("starts with no selected skills and renders installed/dirty row status", () => {
    const state = createInitialSkillsInstallPickerState();
    const lines = renderSkillsInstallPicker(inventory(), state);
    const text = lines.join("\n");

    expect(state.selectedIds.size).toBe(0);
    expect(text).toContain("Install Skills");
    expect(text).toContain("› [ ] Managed Demo");
    expect(text).toContain("installed dirty");
    expect(text).toContain("[ ] bundled-demo");
    expect(text).toContain("space toggle");
    expectPageShortcutHelp(text);
    expect(text).toContain("esc/q cancel");
  });

  it("navigates, toggles selection, confirms selected skills, and cancels", () => {
    const model = inventory();
    let state = createInitialSkillsInstallPickerState();

    let transition = reduceSkillsInstallPickerState(state, "down", model.all);
    state = transition.state;
    expect(state.selectedIndex).toBe(1);

    transition = reduceSkillsInstallPickerState(state, "toggle", model.all);
    state = transition.state;
    expect([...state.selectedIds]).toEqual(["skills/bundled-demo"]);

    transition = reduceSkillsInstallPickerState(state, "confirm", model.all);
    expect(transition.confirmedIds).toEqual(["skills/bundled-demo"]);

    transition = reduceSkillsInstallPickerState(state, "cancel", model.all);
    expect(transition.cancelled).toBe(true);
  });

  it("ignores ctrl+n and ctrl+p and uses page shortcuts for picker navigation", () => {
    const model = inventoryWithManyBundled(30);
    let state = createInitialSkillsInstallPickerState();

    let transition = reduceSkillsInstallPickerState(
      state,
      "pageDown",
      model.all
    );
    state = transition.state;
    expect(state.selectedIndex).toBeGreaterThan(1);

    transition = reduceSkillsInstallPickerState(state, "pageUp", model.all);
    state = transition.state;
    expect(state.selectedIndex).toBe(0);

    const component = createSkillsInstallPickerComponent({
      inventory: model,
      done: () => undefined,
    });
    expectIgnoredCtrlNavigationKeys(component);
    expectPageNavigationKeys(component);
  });

  it("keeps picker open and shows warning when confirming empty selection", () => {
    const transition = reduceSkillsInstallPickerState(
      createInitialSkillsInstallPickerState(),
      "confirm",
      inventory().all
    );

    expect(transition.confirmedIds).toBeUndefined();
    expect(transition.cancelled).toBeUndefined();
    expect(transition.state.warning).toBe(
      "Select at least one skill to install."
    );
    expect(
      renderSkillsInstallPicker(inventory(), transition.state).join("\n")
    ).toContain("Select at least one skill to install.");
  });

  it("component maps keyboard controls to confirm and cancel callbacks", () => {
    const results: Array<string[] | undefined> = [];
    const component = createSkillsInstallPickerComponent({
      inventory: inventory(),
      done: (selectedIds) => results.push(selectedIds),
    });

    component.handleInput("\r");
    expect(results).toEqual([]);
    expect(component.render().join("\n")).toContain(
      "Select at least one skill to install."
    );

    component.handleInput(" ");
    component.handleInput("\r");
    expect(results).toEqual([["managed-demo"]]);

    for (const cancelKey of ["q", LEGACY_ESCAPE, KITTY_ESCAPE]) {
      const cancelComponent = createSkillsInstallPickerComponent({
        inventory: inventory(),
        done: (selectedIds) => results.push(selectedIds),
      });
      cancelComponent.handleInput(cancelKey);
      expect(results.at(-1)).toBeUndefined();
    }
  });
});

describe("skills manager UI", () => {
  const theme = {
    fg(color: string, text: string) {
      return `<${color}:${text}>`;
    },
    bold(text: string) {
      return `<bold:${text}>`;
    },
  };

  it("renders themed modal chrome, sections, preview, action placeholder, and footer", () => {
    const lines = renderSkillsManager(
      inventory(),
      {
        query: "",
        selectedIndex: 0,
        filterMode: false,
        actionMenuOpen: true,
      },
      100,
      theme
    );
    const text = lines.join("\n");

    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(lines[0]).toContain("<border:╭");
    expect(lines[0]).toContain("<border: Skills Manager >");
    expect(text).toContain(
      "<dim:Browse skill inventory and preview local SKILL.md content>"
    );
    expect(lines[1]).not.toContain("...");
    expect(lines[1]).not.toContain("…");
    expect(lines.at(-2)).not.toContain("...");
    expect(lines.at(-2)).not.toContain("…");
    expect(text).toContain("<border:├");
    expect(text).toContain("<border:╰");
    expect(text).toContain("<dim:Filter:> <dim:(none)>");
    expect(text).toContain("<dim:Managed (1)>");
    expect(text).toContain("<dim:Bundled/read-only (1)>");
    expect(text).toContain("<dim:Preview>");
    expect(text).not.toContain(" │ <dim:Preview>");
    expect(text.indexOf("<dim:Preview>")).toBeGreaterThan(
      text.indexOf("<dim:Bundled/read-only (1)>")
    );
    expect(text).toContain("<accent:›> <bold:Managed Demo>");
    expect(text).not.toContain("<accent:› <bold:Managed Demo>");
    expect(text).toContain("<warning:Status: dirty>");
    expect(text).toContain(
      "<dim:Actions: install/update/remove unavailable in this first slice>"
    );
    expect(text).toContain("<dim:↑/k ↓/j navigate");
    expectPageShortcutHelp(text);
    expect(text).toContain("esc/q close");
  });

  it("renders local SKILL.md content in preview when available", () => {
    const lines = renderSkillsManager(inventoryWithSkillContent(), {
      query: "",
      selectedIndex: 0,
      filterMode: false,
      actionMenuOpen: false,
    });
    const text = lines.join("\n");

    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(text).toContain("SKILL.md");
    expect(text).toContain("# Managed Demo");
    expect(text).toContain("Full skill docs.");
  });

  it("clips long preview content before the footer", () => {
    const longSkillContent = Array.from(
      { length: 60 },
      (_, index) => `line ${index + 1}`
    ).join("\n");
    const lines = renderSkillsManager(
      inventoryWithSkillContent(longSkillContent),
      {
        query: "",
        selectedIndex: 0,
        filterMode: false,
        actionMenuOpen: false,
      },
      100,
      theme
    );
    const text = lines.join("\n");

    expect(text).toContain("<dim:…>");
    expect(text).toContain("<dim:↑/k ↓/j navigate");
    expectPageShortcutHelp(text);
    expect(lines.at(-1)).toContain("<border:╰");
  });

  it("scrolls the real inventory viewport instead of swapping in a deep selected row", () => {
    const lines = renderSkillsManager(
      inventoryWithManyBundled(40),
      {
        query: "",
        selectedIndex: 40,
        filterMode: false,
        actionMenuOpen: false,
      },
      100,
      theme
    );
    const text = lines.join("\n");

    expect(text).toContain("<dim:Filter:> <dim:(none)>");
    expect(lines[5]).toContain("<dim:Bundled/read-only (40)>");
    expect(text).not.toContain("<dim:Managed (1)>");
    expect(text).not.toContain("bundled-0");
    expect(text).toContain("bundled-38");
    expect(text).toContain("<accent:›> <bold:bundled-39>");
    expect(text.indexOf("<dim:Preview>")).toBeGreaterThan(
      text.indexOf("<accent:›> <bold:bundled-39>")
    );
    expect(text).toContain("<dim:↑/k ↓/j navigate");
    expectPageShortcutHelp(text);
    expect(lines.at(-1)).toContain("<border:╰");
  });

  it("uses edge-follow scrolling and viewport-height page navigation", () => {
    const component = createSkillsManagerComponent({
      inventory: inventoryWithManyBundled(40),
      done: () => undefined,
    });

    component.render();
    for (let index = 0; index < 13; index += 1) {
      component.handleInput("j");
      component.render();
    }
    expect(component.inventoryScrollView.scrollTop).toBe(0);

    component.handleInput("j");
    component.render();
    expect(component.inventoryScrollView.scrollTop).toBe(1);

    component.handleInput("k");
    component.render();
    expect(component.inventoryScrollView.scrollTop).toBe(1);

    const paged = createSkillsManagerComponent({
      inventory: inventoryWithManyBundled(40),
      done: () => undefined,
    });
    paged.render();
    paged.handleInput(LEGACY_PAGE_DOWN);
    expect(paged.state.selectedIndex).toBe(17);
    paged.handleInput(LEGACY_PAGE_UP);
    expect(paged.state.selectedIndex).toBe(0);
  });

  it.each([
    ["missing", undefined],
    ["wrong shape", []],
  ])("fails clearly when fullscreen listener storage is %s", (_description, inputListeners) => {
    const unsupportedHost = {
      mode: "fullscreen",
      addInputListener: () => () => undefined,
      inputListeners,
    } as unknown as TuiAltScreen;

    expect(() =>
      createSkillsManagerComponent({
        inventory: inventoryWithManyBundled(40),
        done: () => undefined,
        hostTui: unsupportedHost,
      })
    ).toThrow(
      "Skills fullscreen wheel routing requires @earendil-works/pi-tui 0.84.0"
    );
  });

  it.each([
    ["SGR", "\u001b[<65;12;8M", "\u001b[<64;12;40M"],
    ["legacy X10", "\u001b[Ma,(", "\u001b[M`,H"],
  ])("routes %s wheel input by inventory pointer bounds on the host terminal path", (_protocol, insideWheelDown, outsideWheelUp) => {
    const terminal = new TestTerminal();
    const tui = new TuiAltScreen(terminal);
    tui.addChild(transcript);
    const component = createSkillsManagerComponent({
      inventory: inventoryWithManyBundled(40),
      done: () => undefined,
      hostTui: tui,
    });
    tui.showOverlay(component, SKILLS_MANAGER_OVERLAY_OPTIONS);
    tui.start();
    tui.renderNow();
    const transcriptScrollTop = tui.viewportTop;
    const selectedIndex = component.state.selectedIndex;

    terminal.onInput?.(insideWheelDown);

    expect(component.inventoryScrollView.scrollTop).toBe(1);
    expect(component.state.selectedIndex).toBe(selectedIndex);
    expect(tui.viewportTop).toBe(transcriptScrollTop);

    terminal.onInput?.(outsideWheelUp);

    expect(component.inventoryScrollView.scrollTop).toBe(1);
    expect(component.state.selectedIndex).toBe(selectedIndex);
    expect(tui.viewportTop).toBe(transcriptScrollTop - 1);
    component.dispose();
    tui.stop();
  });

  it("handles wheel input without changing selection or preview", () => {
    const component = createSkillsManagerComponent({
      inventory: inventoryWithManyBundled(40),
      done: () => undefined,
    });
    component.render();

    component.handleInput("\u001b[<65;12;8M");
    const text = component.render().join("\n");

    expect(component.inventoryScrollView.scrollTop).toBe(1);
    expect(component.state.selectedIndex).toBe(0);
    expect(text).toContain("Managed skill");
    expect(text).toContain("Filter: (none)");
    expect(text.split("\n")[5]).toContain("Managed (1)");
    expect(text).toContain("Bundled/read-only (40)");
    expect(text.match(/…/g)?.length).toBeGreaterThanOrEqual(1);

    for (let index = 0; index < 4; index += 1) {
      component.handleInput("\u001b[<65;12;8M");
    }
    expect(component.render()[5]).toContain("Bundled/read-only (40)");

    component.handleInput("\u001b[M\u0060!!");
    expect(component.inventoryScrollView.scrollTop).toBe(4);
    expect(component.state.selectedIndex).toBe(0);
  });

  it("keeps readable modal output without theme colors", () => {
    const lines = renderSkillsManager(inventory(), {
      query: "",
      selectedIndex: 0,
      filterMode: false,
      actionMenuOpen: false,
    });
    const text = lines.join("\n");

    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("Skills Manager");
    expect(text).toContain("Managed (1)");
    expect(text).toContain("Bundled/read-only (1)");
    expect(text).toContain("Managed Demo");
    expect(text).toContain("Status: dirty");
    expect(text).toContain(
      "Browse skill inventory and preview local SKILL.md content"
    );
    expectPageShortcutHelp(text);
  });

  it("updates preview when navigating", () => {
    const component = createSkillsManagerComponent({
      inventory: inventory(),
      done: () => undefined,
    });

    expect(component.render().join("\n")).toContain("Managed skill");
    component.handleInput("j");

    const text = component.render().join("\n");
    expect(text).toContain("bundled-demo");
    expect(text).toContain("Bundled/read-only skill");
    expect(text).toContain("Status: clean/read-only");

    component.handleInput("k");
    expect(component.render().join("\n")).toContain("Managed skill");
  });

  it("filters locally with keyboard input", () => {
    const component = createSkillsManagerComponent({
      inventory: inventory(),
      done: () => undefined,
    });

    component.handleInput("/");
    for (const char of "bundled") {
      component.handleInput(char);
    }
    component.handleInput("\r");

    const text = component.render().join("\n");
    expect(text).toContain("Filter: bundled");
    expect(text).toContain("Managed (0)");
    expect(text).toContain("Bundled/read-only (1)");
  });

  it("renders clean/read-only status as dim metadata", () => {
    const component = createSkillsManagerComponent({
      inventory: inventory(),
      theme,
      done: () => undefined,
    });

    component.handleInput("j");

    const text = component.render().join("\n");
    expect(text).toContain("<dim:Status: clean/read-only>");
    expect(text).not.toContain("<success:Status: clean/read-only>");
  });

  it("closes with q and escape even when a nested action shell is open", () => {
    for (const closeKey of ["q", LEGACY_ESCAPE, KITTY_ESCAPE]) {
      let closed = false;
      const component = createSkillsManagerComponent({
        inventory: inventory(),
        done: () => {
          closed = true;
        },
      });

      component.handleInput("\r");
      expect(component.render().join("\n")).toContain(
        "Actions: install/update/remove unavailable"
      );
      component.handleInput(closeKey);
      expect(closed).toBe(true);
    }
  });

  it("ignores ctrl+n and ctrl+p and uses ctrl+f and ctrl+b for page navigation", () => {
    const component = createSkillsManagerComponent({
      inventory: inventoryWithManyBundled(30),
      done: () => undefined,
    });

    expectIgnoredCtrlNavigationKeys(component);
    expectPageNavigationKeys(component);
  });
});
