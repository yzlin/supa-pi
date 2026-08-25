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
import { join, resolve } from "node:path";

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const repositoryDir = import.meta.dir;
const temporaryDirectories: string[] = [];

async function writeBunStub(
  bin: string,
  script = 'printf \'%s\\n\' "$*" >> "$BUN_CALL_LOG"\n'
) {
  const bunStub = join(bin, "bun");
  await writeFile(bunStub, `#!/usr/bin/env bash\n${script}`);
  await chmod(bunStub, 0o755);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
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
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$PI_CALL_LOG"\n'
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
      `install ${repositoryDir}`
    );
    expect(result.stdout).not.toContain("Linking prompts...");
  });

  test("bootstraps a fresh checkout before every manifest extension is loaded", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "supa-pi-setup-"));
    temporaryDirectories.push(temporaryDirectory);

    const checkout = join(temporaryDirectory, "checkout");
    const home = join(temporaryDirectory, "home");
    const bin = join(temporaryDirectory, "bin");
    await mkdir(checkout, { recursive: true });
    await mkdir(bin, { recursive: true });

    for (const path of [
      "extensions",
      "skills",
      "agents",
      "rules",
      "prompts",
      "package.json",
      "bun.lock",
      "AGENTS.global.md",
      "keybindings.json",
      "setup.sh",
    ]) {
      await cp(join(repositoryDir, path), join(checkout, path), {
        recursive: true,
      });
    }

    const piStub = join(bin, "pi");
    await writeFile(piStub, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(piStub, 0o755);

    const result = spawnSync("bash", [join(checkout, "setup.sh")], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status, result.error?.message ?? result.stderr).toBe(0);

    const agentDir = join(home, ".pi", "agent");
    const settingsPath = join(agentDir, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.packages = [checkout];
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    const loader = new DefaultResourceLoader({
      cwd: join(temporaryDirectory, "project"),
      agentDir,
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
    });
    await loader.reload();

    const manifest = JSON.parse(
      await readFile(join(checkout, "package.json"), "utf8")
    );
    const expectedPaths = manifest.pi.extensions.map((path: string) =>
      path.endsWith(".ts") || path.endsWith(".js")
        ? resolve(checkout, path)
        : resolve(checkout, path, "index.ts")
    );
    const loaded = loader.getExtensions();

    expect(loaded.errors).toEqual([]);
    expect(
      loaded.extensions.map((extension) => extension.resolvedPath)
    ).toEqual(expectedPaths);
  }, 30_000);

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
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$PI_CALL_LOG"\nif [ "$2" = "$REPOSITORY_DIR" ]; then echo "local package deployed"; fi\n'
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
      "install --frozen-lockfile --production"
    );
    expect((await readFile(callLog, "utf8")).split("\n")).toContain(
      `install ${repositoryDir}`
    );
    expect(
      result.stdout.indexOf("Installing locked supa-pi runtime dependencies...")
    ).toBeLessThan(result.stdout.indexOf("local package deployed"));
    expect(result.stdout.indexOf("local package deployed")).toBeLessThan(
      result.stdout.indexOf("Linking prompts...")
    );
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

    for (const command of ["grill-me", "research-brief", "show-me"]) {
      await symlink(
        join(repositoryDir, "prompts", `${command}.md`),
        join(promptsDirectory, `${command}.md`)
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
`
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
      `install ${repositoryDir}`
    );
    for (const command of ["grill-me", "research-brief", "show-me"]) {
      const promptPath = join(promptsDirectory, `${command}.md`);
      expect((await lstat(promptPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(promptPath)).toBe(
        join(repositoryDir, "prompts", `${command}.md`)
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
      "removed-managed-agent.md"
    );
    const unrelatedDanglingLink = join(targetDirectory, "unrelated.md");
    const crossSectionDanglingLink = join(targetDirectory, "former-prompt.md");
    const prefixCollisionDanglingLink = join(targetDirectory, "user-owned.md");
    const validLink = join(targetDirectory, "valid-user-link.md");
    const realFile = join(targetDirectory, "notes.txt");
    const realDirectory = join(targetDirectory, "custom-agent");

    await symlink(
      join(repositoryDir, "agents", "removed-managed-agent.md"),
      managedDanglingLink
    );
    await symlink(
      join(temporaryDirectory, "missing", "unrelated.md"),
      unrelatedDanglingLink
    );
    await symlink(
      join(repositoryDir, "prompts", "removed-prompt.md"),
      crossSectionDanglingLink
    );
    await symlink(
      join(repositoryDir, "agents-user", "removed.md"),
      prefixCollisionDanglingLink
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
    await expect(lstat(managedDanglingLink)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readlink(unrelatedDanglingLink)).toBe(
      join(temporaryDirectory, "missing", "unrelated.md")
    );
    expect(await readlink(crossSectionDanglingLink)).toBe(
      join(repositoryDir, "prompts", "removed-prompt.md")
    );
    expect(await readlink(prefixCollisionDanglingLink)).toBe(
      join(repositoryDir, "agents-user", "removed.md")
    );
    expect(await readlink(validLink)).toBe(
      join(repositoryDir, "AGENTS.global.md")
    );
    expect((await lstat(realFile)).isFile()).toBe(true);
    expect((await lstat(realDirectory)).isDirectory()).toBe(true);
  });
});
