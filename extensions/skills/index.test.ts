import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  copyInstallPlan,
  createSkillsManagerPaths,
  planInstallSkill,
  readManagedManifest,
} from "./core";
import skillsExtension, { skillOperationLabel } from "./index";

describe("skills panel removal", () => {
  it.each([
    true,
    false,
  ])("confirmation %s returns a fresh inventory", async (confirmed) => {
    const home = mkdtempSync(join(tmpdir(), "skills-panel-remove-"));
    const previousHome = process.env.HOME;
    const paths = createSkillsManagerPaths(join(home, ".pi", "agent"));
    const source = join(home, "source", "panel-demo");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: panel-demo\ndescription: Panel test\n---\nOriginal"
    );
    const skill = copyInstallPlan(planInstallSkill(source, paths), paths);
    writeFileSync(join(skill.installPath, "SKILL.md"), "Local edits");
    const events: string[] = [];
    const trash = spyOn(childProcess, "spawnSync").mockImplementation(((
      command: string,
      args: readonly string[]
    ) => {
      expect(command).toBe("trash");
      expect(args).toEqual([skill.installPath]);
      events.push("trash");
      renameSync(skill.installPath, join(home, "trashed-skill"));
      return { status: 0 } as ReturnType<typeof childProcess.spawnSync>;
    }) as typeof childProcess.spawnSync);
    let handler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
      | undefined;
    skillsExtension({
      on: () => undefined,
      registerCommand(_name, command) {
        handler = command.handler;
      },
    } as Pick<ExtensionAPI, "on" | "registerCommand"> as ExtensionAPI);
    let panels = 0;
    const ctx = {
      hasUI: true,
      ui: {
        setWidget: () => undefined,
        setStatus: () => undefined,
        notify: () => undefined,
        confirm(title: string, message: string) {
          events.push("confirm");
          expect(title).toBe("Remove dirty skill");
          expect(message).toContain("panel-demo");
          expect(existsSync(skill.installPath)).toBe(true);
          return Promise.resolve(confirmed);
        },
        custom(
          factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]
        ) {
          return new Promise((resolve) => {
            const component = factory(
              { mode: "regular" } as never,
              {} as never,
              {} as never,
              resolve
            ) as unknown as {
              render(): string[];
              handleInput(data: string): void;
            };
            panels += 1;
            if (panels === 1) {
              events.push("selection");
              component.handleInput("d");
              component.handleInput("q");
            } else {
              events.push("refresh");
              expect(component.render().join("\n")).toContain(
                `Managed (${confirmed ? 0 : 1})`
              );
              component.handleInput("q");
            }
          });
        },
      },
    } as unknown as ExtensionCommandContext;
    try {
      process.env.HOME = home;
      await handler?.("list panel-demo", ctx);
      expect(panels).toBe(2);
      expect(events).toEqual(
        confirmed
          ? ["selection", "confirm", "trash", "refresh"]
          : ["selection", "confirm", "refresh"]
      );
      expect(readManagedManifest(paths.manifestPath).skills.length).toBe(
        confirmed ? 0 : 1
      );
      expect(existsSync(skill.installPath)).toBe(!confirmed);
    } finally {
      process.env.HOME = previousHome;
      trash.mockRestore();
    }
  });
});

describe("skills command activity labels", () => {
  it("preserves known /skill subcommand labels", () => {
    expect(skillOperationLabel("list")).toBe("Loading skills…");
    expect(skillOperationLabel("search")).toBe("Searching skills…");
    expect(skillOperationLabel("install")).toBe("Installing skill…");
    expect(skillOperationLabel("update")).toBe("Updating skills…");
    expect(skillOperationLabel("remove")).toBe("Removing skill…");
  });

  it("uses the entered token for unknown /skill subcommand labels", () => {
    expect(skillOperationLabel("unknown", "wat")).toBe("Running skill wat…");
  });
});
