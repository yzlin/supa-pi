import { describe, expect, it } from "bun:test";

import type { ManagedSkillEntry } from "./core";
import { buildSkillInventoryModel } from "./model";
import {
  createInitialSkillsInstallPickerState,
  createSkillsInstallPickerComponent,
  createSkillsManagerComponent,
  reduceSkillsInstallPickerState,
  renderSkillsInstallPicker,
  renderSkillsManager,
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

  it("clips long inventory before the preview and keeps the selected skill visible", () => {
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

    expect(text).toContain("<dim:…>");
    expect(text).toContain("<accent:›> <bold:bundled-39>");
    expect(text.indexOf("<dim:Preview>")).toBeGreaterThan(
      text.indexOf("<accent:›> <bold:bundled-39>")
    );
    expect(text).toContain("<dim:↑/k ↓/j navigate");
    expectPageShortcutHelp(text);
    expect(lines.at(-1)).toContain("<border:╰");
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
