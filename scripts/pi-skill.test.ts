import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "pi-skill.ts");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "pi-skill-cli-"));
  const bin = join(home, "bin");
  const trashed = join(home, "trashed");
  mkdirSync(bin);
  mkdirSync(trashed);
  // Fake `trash` so tests never touch the real Trash.
  writeFileSync(join(bin, "trash"), `#!/bin/sh\nmv "$1" "${trashed}/"\n`);
  chmodSync(join(bin, "trash"), 0o755);
  const run = (...args: string[]) => {
    const result = spawnSync("bun", [SCRIPT, ...args], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return {
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const writeSkill = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} test\n---\nBody`,
    );
  };
  const manifest = () =>
    JSON.parse(
      readFileSync(join(home, ".pi", "agent", "skills.json"), "utf8"),
    ) as { skills: { id: string }[] };
  return { home, run, writeSkill, manifest };
}

describe("pi-skill CLI without a TTY", () => {
  it("installs, lists, and removes a local skill", () => {
    const { home, run, writeSkill, manifest } = setup();
    const source = join(home, "src", "cli-demo");
    writeSkill(source, "cli-demo");

    const install = run("install", source);
    expect(install.code).toBe(0);
    expect(install.stdout).toContain("cli-demo");
    expect(manifest().skills.map((skill) => skill.id)).toEqual(["cli-demo"]);
    expect(
      existsSync(join(home, ".pi", "agent", "skills", "cli-demo", "SKILL.md")),
    ).toBe(true);

    const list = run("list", "--json");
    expect(list.code).toBe(0);
    const listed = JSON.parse(list.stdout) as {
      name: string;
      dirty: boolean;
    }[];
    expect(listed).toEqual([
      expect.objectContaining({ name: "cli-demo", dirty: false }),
    ]);

    const table = run("list");
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/^NAME\s+SOURCE\s+DIRTY/);

    const names = run("__complete-names");
    expect(names.code).toBe(0);
    expect(names.stdout).toBe("cli-demo\n");

    const remove = run("remove", "cli-demo", "--yes");
    expect(remove.code).toBe(0);
    expect(remove.stdout).toContain("Removed cli-demo");
    expect(manifest().skills).toEqual([]);
  });

  it("exits 2 naming --yes when removal needs confirmation", () => {
    const { home, run, writeSkill, manifest } = setup();
    const source = join(home, "src", "keep-me");
    writeSkill(source, "keep-me");
    expect(run("install", source).code).toBe(0);

    const remove = run("remove", "keep-me");
    expect(remove.code).toBe(2);
    expect(remove.stderr).toContain("--yes");
    expect(manifest().skills.map((skill) => skill.id)).toEqual(["keep-me"]);
  });

  it("exits 2 naming --skill when a multi-skill source needs a choice", () => {
    const { home, run, writeSkill, manifest } = setup();
    const root = join(home, "src", "many");
    writeSkill(join(root, "one"), "one");
    writeSkill(join(root, "two"), "two");

    const install = run("install", root);
    expect(install.code).toBe(2);
    expect(install.stderr).toContain("--skill");

    const picked = run("install", root, "--skill", "two");
    expect(picked.code).toBe(0);
    expect(manifest().skills.map((skill) => skill.id)).toEqual(["two"]);
  });

  it("exits 2 for usage errors and 1 for operation failures", () => {
    const { run } = setup();
    expect(run().code).toBe(2);
    expect(run("bogus").code).toBe(2);
    expect(run("list", "--nope").code).toBe(2);
    expect(run("--help").code).toBe(0);
    expect(run("remove", "missing", "--yes").code).toBe(1);
  });

  it("exits 1 when ops reports a failure as a warning", () => {
    const { home, run } = setup();
    const empty = join(home, "src", "empty");
    mkdirSync(empty, { recursive: true });
    const install = run("install", empty);
    expect(install.code).toBe(1);
    expect(install.stderr).toContain("No SKILL.md");
  });

  it("exits 2 naming --yes when reinstalling over a dirty skill", () => {
    const { home, run, writeSkill } = setup();
    const source = join(home, "src", "dirty-demo");
    writeSkill(source, "dirty-demo");
    expect(run("install", source).code).toBe(0);
    writeFileSync(
      join(home, ".pi", "agent", "skills", "dirty-demo", "SKILL.md"),
      "local edit",
    );
    const reinstall = run("install", source);
    expect(reinstall.code).toBe(2);
    expect(reinstall.stderr).toContain("--yes");
    expect(run("install", source, "--yes").code).toBe(0);
  });
});
