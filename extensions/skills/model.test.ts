import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ManagedSkillEntry } from "./core";
import {
  buildSkillInventoryModel,
  buildSkillPreviewModel,
  filterSkillInventory,
  parseSkillCommandInitialState,
} from "./model";

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

describe("skills manager model", () => {
  it("groups managed and bundled inventory without sibling extension imports", () => {
    const inventory = buildSkillInventoryModel({
      managed: [managedSkill()],
      bundledSkillPaths: ["/repo/skills/bundled-demo/SKILL.md"],
      cwd: "/repo",
      dirtyIds: new Set(["managed-demo"]),
    });

    expect(inventory.managed).toMatchObject([
      {
        id: "managed-demo",
        name: "Managed Demo",
        kind: "managed",
        displayPath: ".pi/skills/managed-demo",
        dirtyStatus: "dirty",
      },
    ]);
    expect(inventory.bundled).toMatchObject([
      {
        id: "skills/bundled-demo",
        name: "bundled-demo",
        kind: "bundled",
        displayPath: "skills/bundled-demo",
      },
    ]);
    expect(inventory.all.map((item) => item.kind)).toEqual([
      "managed",
      "bundled",
    ]);
  });

  it("filters inventory by query and group", () => {
    const inventory = buildSkillInventoryModel({
      managed: [managedSkill()],
      bundledSkillPaths: ["/repo/skills/react-helper/SKILL.md"],
      cwd: "/repo",
    });

    expect(
      filterSkillInventory(inventory, { query: "managed" }).all
    ).toHaveLength(1);
    expect(
      filterSkillInventory(inventory, { kind: "bundled", query: "react" }).all
    ).toMatchObject([{ kind: "bundled", name: "react-helper" }]);
    expect(
      filterSkillInventory(inventory, { kind: "managed", query: "react" }).all
    ).toEqual([]);
  });

  it("builds preview data for selected skills", () => {
    const inventory = buildSkillInventoryModel({
      managed: [managedSkill()],
      bundledSkillPaths: [],
      cwd: "/repo",
      dirtyIds: new Set(["managed-demo"]),
    });

    expect(buildSkillPreviewModel(inventory.managed[0])).toEqual({
      id: "managed-demo",
      title: "Managed Demo",
      subtitle: "Managed skill",
      description: "Does managed work.",
      kind: "managed",
      path: ".pi/skills/managed-demo",
      source: "acme/demo/tree/main/skills/demo",
      dirty: true,
      skillContent: undefined,
    });
  });

  it("includes local SKILL.md content in preview data when available", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-model-"));
    try {
      const managedDir = join(root, "managed-demo");
      const bundledDir = join(root, "bundled-demo");
      mkdirSync(managedDir);
      mkdirSync(bundledDir);
      writeFileSync(
        join(managedDir, "SKILL.md"),
        "# Managed Demo\n\nDo managed work.\n"
      );
      writeFileSync(
        join(bundledDir, "SKILL.md"),
        "# Bundled Demo\n\nDo bundled work.\n"
      );

      const inventory = buildSkillInventoryModel({
        managed: [managedSkill({ installPath: managedDir })],
        bundledSkillPaths: [join(bundledDir, "SKILL.md")],
        cwd: root,
      });

      expect(buildSkillPreviewModel(inventory.managed[0]).skillContent).toBe(
        "# Managed Demo\n\nDo managed work."
      );
      expect(buildSkillPreviewModel(inventory.bundled[0]).skillContent).toBe(
        "# Bundled Demo\n\nDo bundled work."
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses command initial state for /skill deep links", () => {
    expect(parseSkillCommandInitialState("")).toEqual({
      action: "list",
      operand: "",
      rawArgs: "",
      enteredSubcommand: "list",
    });
    expect(parseSkillCommandInitialState("list managed")).toEqual({
      action: "list",
      operand: "managed",
      rawArgs: "list managed",
      enteredSubcommand: "list",
    });
    expect(parseSkillCommandInitialState("search react native")).toEqual({
      action: "search",
      operand: "react native",
      rawArgs: "search react native",
      enteredSubcommand: "search",
    });
    expect(parseSkillCommandInitialState("wat now")).toEqual({
      action: "unknown",
      operand: "now",
      rawArgs: "wat now",
      enteredSubcommand: "wat",
    });
  });
});
