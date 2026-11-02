import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSkillsManagerPaths,
  readManagedManifest,
  type SkillsManagerPaths,
} from "./core";
import {
  installLocalSource,
  listManagedSkills,
  type Prompter,
  removeManaged,
  updateManaged,
} from "./ops";

interface FakePrompter extends Prompter {
  calls: string[];
  notifications: Array<{ message: string; level: string }>;
}

function fakePrompter(
  answers: { confirm?: boolean; select?: string } = {},
): FakePrompter {
  const calls: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    calls,
    notifications,
    select(title) {
      calls.push(`select:${title}`);
      return Promise.resolve(answers.select);
    },
    confirm(title) {
      calls.push(`confirm:${title}`);
      return Promise.resolve(answers.confirm ?? false);
    },
    input(title) {
      calls.push(`input:${title}`);
      return Promise.resolve(undefined);
    },
    notify(message, level) {
      notifications.push({ message, level });
    },
  };
}

function throwingPrompter(): FakePrompter {
  const prompter = fakePrompter();
  const fail = (): never => {
    throw new Error("prompt not allowed");
  };
  return { ...prompter, select: fail, confirm: fail, input: fail };
}

let home: string;
let paths: SkillsManagerPaths;

function writeSkill(name: string, body = "Original"): string {
  const dir = join(home, "source", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Ops test\n---\n${body}`,
  );
  return dir;
}

function mockTrash() {
  return spyOn(childProcess, "spawnSync").mockImplementation(((
    command: string,
    args: readonly string[],
  ) => {
    expect(command).toBe("trash");
    renameSync(String(args[0]), join(home, `trashed-${Date.now()}`));
    return { status: 0 } as ReturnType<typeof childProcess.spawnSync>;
  }) as typeof childProcess.spawnSync);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "skills-ops-"));
  paths = createSkillsManagerPaths(join(home, ".pi", "agent"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("skills ops", () => {
  it("installs a local skill directory", async () => {
    const prompter = fakePrompter();
    const installed = await installLocalSource(prompter, writeSkill("demo"), {
      paths,
    });
    expect(installed?.map((skill) => skill.id)).toEqual(["demo"]);
    expect(readManagedManifest(paths.manifestPath).skills[0]?.id).toBe("demo");
    expect(prompter.calls).toEqual([]);
    expect(prompter.notifications).toEqual([
      {
        message:
          "Installed 1 skill: demo. Changes apply after /reload or next session.",
        level: "info",
      },
    ]);
  });

  it.each([true, false])(
    "removes only when confirmation is %s",
    async (confirmed) => {
      await installLocalSource(fakePrompter(), writeSkill("demo"), { paths });
      const trash = mockTrash();
      const prompter = fakePrompter({ confirm: confirmed });
      try {
        await removeManaged(prompter, { skillNames: ["demo"], paths });
      } finally {
        trash.mockRestore();
      }
      expect(prompter.calls).toEqual(["confirm:Remove skill"]);
      expect(readManagedManifest(paths.manifestPath).skills.length).toBe(
        confirmed ? 0 : 1,
      );
      expect(prompter.notifications).toEqual(
        confirmed
          ? [
              {
                message:
                  "Removed demo. Changes apply after /reload or next session.",
                level: "info",
              },
            ]
          : [],
      );
    },
  );

  it("updates all without prompting when no local-source changes exist", async () => {
    await installLocalSource(fakePrompter(), writeSkill("demo"), { paths });
    const prompter = throwingPrompter();
    const counts: number[] = [];
    await updateManaged(
      { ...prompter, setUpdateCount: (count) => counts.push(count) },
      { all: true, paths },
    );
    expect(prompter.notifications).toEqual([
      { message: "No skill updates found.", level: "info" },
    ]);
    expect(counts).toEqual([0]);
  });

  it("lists managed skills with source text and dirty flag", async () => {
    const source = writeSkill("demo");
    const [installed] =
      (await installLocalSource(fakePrompter(), source, { paths })) ?? [];
    expect(listManagedSkills(paths)).toEqual([
      expect.objectContaining({
        id: "demo",
        name: "demo",
        source,
        dirty: false,
      }),
    ]);
    writeFileSync(join(installed?.installPath ?? "", "SKILL.md"), "edited");
    expect(listManagedSkills(paths)[0]?.dirty).toBe(true);
  });

  it("skips prompts when explicit choices are supplied", async () => {
    const source = writeSkill("demo");
    const [installed] =
      (await installLocalSource(fakePrompter(), source, { paths })) ?? [];
    writeFileSync(join(installed?.installPath ?? "", "SKILL.md"), "edited");
    const prompter = throwingPrompter();
    // Dirty overwrite is confirmed by `yes`.
    await installLocalSource(prompter, source, { yes: true, paths });
    expect(listManagedSkills(paths)[0]?.dirty).toBe(false);

    const multi = join(home, "multi");
    for (const name of ["one", "two"]) {
      mkdirSync(join(multi, name), { recursive: true });
      writeFileSync(
        join(multi, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Multi\n---\nBody`,
      );
    }
    await installLocalSource(prompter, multi, {
      skillNames: ["two"],
      paths,
    });
    await installLocalSource(prompter, multi, { all: true, paths });
    expect(
      listManagedSkills(paths)
        .map((skill) => skill.id)
        .sort(),
    ).toEqual(["demo", "one", "two"]);

    const trash = mockTrash();
    try {
      await removeManaged(prompter, { skillNames: ["demo"], yes: true, paths });
    } finally {
      trash.mockRestore();
    }
    expect(existsSync(installed?.installPath ?? "")).toBe(false);
    expect(listManagedSkills(paths).map((skill) => skill.id)).not.toContain(
      "demo",
    );
  });
});
