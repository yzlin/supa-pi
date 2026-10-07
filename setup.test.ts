import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryDir = import.meta.dir;
const temporaryDirectories: string[] = [];

async function writeBunStub(
  bin: string,
  script = 'printf \'%s\\n\' "$*" >> "$BUN_CALL_LOG"\n',
) {
  const bunStub = join(bin, "bun");
  await writeFile(bunStub, `#!/usr/bin/env bash\n${script}`);
  await chmod(bunStub, 0o755);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("setup local package deployment", () => {
  test("fails before local registration when dependency bootstrap fails", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "supa-pi-setup-"));
    temporaryDirectories.push(temporaryDirectory);

    const home = join(temporaryDirectory, "home");
    const bin = join(temporaryDirectory, "bin");
    const piCallLog = join(temporaryDirectory, "pi-calls.log");
    await mkdir(bin, { recursive: true });
    await writeBunStub(bin, "exit 23\n");

    const piStub = join(bin, "pi");
    await writeFile(
      piStub,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$PI_CALL_LOG"\n',
    );
    await chmod(piStub, 0o755);

    const result = spawnSync("bash", [join(repositoryDir, "setup.sh")], {
      cwd: repositoryDir,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PI_CALL_LOG: piCallLog,
      },
    });

    expect(result.status).toBe(23);
    expect((await readFile(piCallLog, "utf8")).split("\n")).not.toContain(
      `install ${repositoryDir}`,
    );
    expect(result.stdout).not.toContain("Linking prompts...");
  });

  test("bootstraps a fresh checkout from another cwd before local registration", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "supa-pi-setup-"));
    temporaryDirectories.push(temporaryDirectory);
    const checkout = join(temporaryDirectory, "checkout");
    const home = join(temporaryDirectory, "home");
    const bin = join(temporaryDirectory, "bin");
    const callLog = join(temporaryDirectory, "calls.log");
    await mkdir(checkout);
    await mkdir(bin);
    for (const path of ["setup.sh", "agents", "rules", "prompts"]) {
      await cp(join(repositoryDir, path), join(checkout, path), {
        recursive: true,
      });
    }
    await writeBunStub(
      bin,
      'printf \'bun:%s:%s\\n\' "$PWD" "$*" >> "$CALL_LOG"\n',
    );
    const piStub = join(bin, "pi");
    await writeFile(
      piStub,
      '#!/usr/bin/env bash\nprintf \'pi:%s\\n\' "$*" >> "$CALL_LOG"\n',
    );
    await chmod(piStub, 0o755);
    const result = spawnSync("bash", [join(checkout, "setup.sh")], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CALL_LOG: callLog,
      },
    });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    const calls = (await readFile(callLog, "utf8")).trim().split("\n");
    expect(calls.slice(-2)).toEqual([
      `bun:${checkout}:install --frozen-lockfile --production`,
      `pi:install ${checkout}`,
    ]);
    expect(
      await readlink(join(home, ".pi", "agent", "agents", "executor.md")),
    ).toBe(join(checkout, "agents", "executor.md"));
  });

  test("registers the repo-owned subagent without changing skill-router precedence", async () => {
    const manifest = JSON.parse(
      await readFile(join(repositoryDir, "package.json"), "utf8"),
    );
    expect(manifest.pi.extensions[0]).toBe("./extensions/skill-router");
    expect(
      manifest.pi.extensions.filter(
        (path: string) => path === "./extensions/subagent",
      ),
    ).toHaveLength(1);
  });

  test("fresh installs deploy the command package before prompt reconciliation", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "supa-pi-setup-"));
    temporaryDirectories.push(temporaryDirectory);

    const home = join(temporaryDirectory, "home");
    const bin = join(temporaryDirectory, "bin");
    const callLog = join(temporaryDirectory, "pi-calls.log");
    const bunCallLog = join(temporaryDirectory, "bun-calls.log");
    await mkdir(bin, { recursive: true });
    await writeBunStub(bin);

    const piStub = join(bin, "pi");
    await writeFile(
      piStub,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$PI_CALL_LOG"\nif [ "$2" = "$REPOSITORY_DIR" ]; then echo "local package deployed"; fi\n',
    );
    await chmod(piStub, 0o755);

    const result = spawnSync("bash", [join(repositoryDir, "setup.sh")], {
      cwd: repositoryDir,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        BUN_CALL_LOG: bunCallLog,
        PI_CALL_LOG: callLog,
        REPOSITORY_DIR: repositoryDir,
      },
    });

    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect((await readFile(bunCallLog, "utf8")).split("\n")).toContain(
      "install --frozen-lockfile --production",
    );
    expect((await readFile(callLog, "utf8")).split("\n")).toContain(
      `install ${repositoryDir}`,
    );
    const calls = (await readFile(callLog, "utf8")).trim().split("\n");
    const packages = JSON.parse(
      await readFile(join(home, ".pi", "agent", "settings.json"), "utf8"),
    ).packages;
    for (const retired of [
      "npm:@tintinweb/pi-subagents",
      "npm:@tintinweb/pi-tasks",
    ]) {
      expect(packages).not.toContain(retired);
      expect(calls).not.toContain(`install ${retired}`);
    }
    expect(calls.every((call) => call.startsWith("install "))).toBe(true);
    expect(packages).toEqual([
      "npm:@yzlin/pieditor@2.0.0",
      "npm:pi-mcp-adapter",
      "npm:pi-rewind",
      "npm:pi-web-access",
      "npm:@plannotator/pi-extension",
      "npm:glimpseui",
      "npm:pi-anycopy",
      "npm:pi-token-burden",
    ]);
    expect(calls).toEqual([
      ...packages.map((source: string) => `install ${source}`),
      `install ${repositoryDir}`,
    ]);
    expect(
      result.stdout.indexOf(
        "Installing locked supa-pi runtime dependencies...",
      ),
    ).toBeLessThan(result.stdout.indexOf("local package deployed"));
    expect(result.stdout.indexOf("local package deployed")).toBeLessThan(
      result.stdout.indexOf("Linking prompts..."),
    );
    expect(
      JSON.parse(
        await readFile(join(home, ".pi", "agent", "settings.json"), "utf8"),
      ),
    ).toMatchObject({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-6.1-sol",
      defaultThinkingLevel: "high",
    });
  });

  test("upgrades deploy the transformer before reconciling queueable prompt entrypoints", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "supa-pi-setup-"));
    temporaryDirectories.push(temporaryDirectory);

    const home = join(temporaryDirectory, "home");
    const bin = join(temporaryDirectory, "bin");
    const promptsDirectory = join(home, ".pi", "agent", "prompts");
    const callLog = join(temporaryDirectory, "pi-calls.log");
    const bunCallLog = join(temporaryDirectory, "bun-calls.log");
    await mkdir(promptsDirectory, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeBunStub(bin);
    const settingsPath = join(home, ".pi", "agent", "settings.json");
    const existingSettings =
      '{ "defaultModel": "user-selected-model", "packages": ["npm:@tintinweb/pi-subagents", "npm:@tintinweb/pi-tasks"] }\n';
    await writeFile(settingsPath, existingSettings);

    for (const command of ["grill-me", "research-brief", "show-me"]) {
      await symlink(
        join(repositoryDir, "prompts", `${command}.md`),
        join(promptsDirectory, `${command}.md`),
      );
    }

    const piStub = join(bin, "pi");
    await writeFile(
      piStub,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$PI_CALL_LOG"
if [ "$2" = "$REPOSITORY_DIR" ]; then
  for command in grill-me research-brief show-me; do
    [ -L "$HOME/.pi/agent/prompts/$command.md" ] || exit 42
  done
fi
`,
    );
    await chmod(piStub, 0o755);

    const result = spawnSync("bash", [join(repositoryDir, "setup.sh")], {
      cwd: repositoryDir,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        BUN_CALL_LOG: bunCallLog,
        PI_CALL_LOG: callLog,
        REPOSITORY_DIR: repositoryDir,
      },
    });

    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect((await readFile(callLog, "utf8")).split("\n")).toContain(
      `install ${repositoryDir}`,
    );
    const calls = (await readFile(callLog, "utf8")).trim().split("\n");
    expect(calls.every((call) => call.startsWith("install "))).toBe(true);
    expect(calls).not.toContain("install npm:@tintinweb/pi-subagents");
    expect(calls).not.toContain("install npm:@tintinweb/pi-tasks");
    expect(await readFile(settingsPath, "utf8")).toBe(existingSettings);
    for (const command of ["grill-me", "research-brief", "show-me"]) {
      const promptPath = join(promptsDirectory, `${command}.md`);
      expect((await lstat(promptPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(promptPath)).toBe(
        join(repositoryDir, "prompts", `${command}.md`),
      );
    }
  });
});

describe("setup managed-directory symlink reconciliation", () => {
  test("removes only dangling links owned by the matching managed source directory", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "supa-pi-setup-"));
    temporaryDirectories.push(temporaryDirectory);

    const home = join(temporaryDirectory, "home");
    const bin = join(temporaryDirectory, "bin");
    const targetDirectory = join(home, ".pi", "agent", "agents");
    const bunCallLog = join(temporaryDirectory, "bun-calls.log");
    await mkdir(targetDirectory, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeBunStub(bin);

    const piStub = join(bin, "pi");
    await writeFile(piStub, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(piStub, 0o755);

    const managedDanglingLink = join(
      targetDirectory,
      "removed-managed-agent.md",
    );
    const unrelatedDanglingLink = join(targetDirectory, "unrelated.md");
    const crossSectionDanglingLink = join(targetDirectory, "former-prompt.md");
    const prefixCollisionDanglingLink = join(targetDirectory, "user-owned.md");
    const validLink = join(targetDirectory, "valid-user-link.md");
    const realFile = join(targetDirectory, "notes.txt");
    const realDirectory = join(targetDirectory, "custom-agent");

    await symlink(
      join(repositoryDir, "agents", "removed-managed-agent.md"),
      managedDanglingLink,
    );
    await symlink(
      join(temporaryDirectory, "missing", "unrelated.md"),
      unrelatedDanglingLink,
    );
    await symlink(
      join(repositoryDir, "prompts", "removed-prompt.md"),
      crossSectionDanglingLink,
    );
    await symlink(
      join(repositoryDir, "agents-user", "removed.md"),
      prefixCollisionDanglingLink,
    );
    await symlink(join(repositoryDir, "AGENTS.global.md"), validLink);
    await writeFile(realFile, "keep me\n");
    await mkdir(realDirectory);

    const result = spawnSync("bash", [join(repositoryDir, "setup.sh")], {
      cwd: repositoryDir,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        BUN_CALL_LOG: bunCallLog,
      },
    });

    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(lstat(managedDanglingLink)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readlink(unrelatedDanglingLink)).toBe(
      join(temporaryDirectory, "missing", "unrelated.md"),
    );
    expect(await readlink(crossSectionDanglingLink)).toBe(
      join(repositoryDir, "prompts", "removed-prompt.md"),
    );
    expect(await readlink(prefixCollisionDanglingLink)).toBe(
      join(repositoryDir, "agents-user", "removed.md"),
    );
    expect(await readlink(validLink)).toBe(
      join(repositoryDir, "AGENTS.global.md"),
    );
    expect((await lstat(realFile)).isFile()).toBe(true);
    expect((await lstat(realDirectory)).isDirectory()).toBe(true);
  });
});
