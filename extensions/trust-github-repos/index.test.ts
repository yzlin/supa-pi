import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  homedir as osHomedir,
  hostname as osHostname,
  tmpdir as osTmpdir,
} from "node:os";
import { dirname, join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProjectTrustContext,
  ProjectTrustHandler,
} from "@earendil-works/pi-coding-agent";

const originalHomeDir = osHomedir();
const originalHostname = osHostname();
const originalTmpdir = osTmpdir();
let currentHomeDir = originalHomeDir;
await mock.module("node:os", () => ({
  homedir: () => currentHomeDir,
  hostname: () => originalHostname,
  tmpdir: () => originalTmpdir,
}));
const { default: trustGitHubReposExtension } = await import("./index");

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
interface Notification {
  message: string;
  type?: "info" | "warning" | "error";
}
interface ExecOptions {
  stdout?: string;
  code?: number;
  throws?: boolean;
}

let testRootDir = "";
beforeEach(() => {
  testRootDir = mkdtempSync(join(originalTmpdir, "supa-pi-trust-github-"));
  currentHomeDir = join(testRootDir, "home");
});
afterEach(() => {
  currentHomeDir = originalHomeDir;
  execFileSync("trash", [testRootDir]);
});

function configPath(): string {
  return join(currentHomeDir, ".pi", "agent", "trust-github-repos.json");
}
function saveConfig(text: string): void {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), text);
}
function setupHarness(options: ExecOptions = {}) {
  let trustHandler: ProjectTrustHandler | undefined;
  let registeredCommand: Command | undefined;
  const exec = mock((_command: string, _args: string[], _options: unknown) => {
    if (options.throws) {
      return Promise.reject(new Error("git unavailable"));
    }
    return Promise.resolve({
      code: options.code ?? 0,
      stdout: options.stdout ?? "git@github.com:earendil-works/pi.git\n",
      stderr: "",
      killed: false,
    });
  });
  trustGitHubReposExtension({
    on(name: string, handler: ProjectTrustHandler) {
      expect(name).toBe("project_trust");
      trustHandler = handler;
    },
    registerCommand(name: string, command: Command) {
      expect(name).toBe("trust-github-repos");
      registeredCommand = command;
    },
    exec,
  } as unknown as ExtensionAPI);

  const notifications: Notification[] = [];
  const ctx: ProjectTrustContext = {
    cwd: testRootDir,
    mode: "tui",
    hasUI: true,
    ui: {
      select: () => Promise.resolve(undefined),
      confirm: () => Promise.resolve(false),
      input: () => Promise.resolve(undefined),
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };
  return {
    ctx,
    exec,
    notifications,
    trust() {
      if (!trustHandler) {
        throw new Error("project_trust handler missing");
      }
      return trustHandler({ type: "project_trust", cwd: testRootDir }, ctx);
    },
    get command(): Command {
      if (!registeredCommand) {
        throw new Error("trust-github-repos command missing");
      }
      return registeredCommand;
    },
    async run(args: string) {
      await this.command.handler(args, ctx as ExtensionCommandContext);
    },
  };
}

describe("GitHub remote parsing and trust", () => {
  it.each([
    "git@github.com:Example/repo.git",
    "github.com:example/repo.git/",
    "https://GITHUB.com/example/repo.git",
    "ssh://git@github.com/EXAMPLE/repo.git",
    "https://github.com/%65xample/repo.git/",
  ])("trusts supported remote %s without remembering", async (remote) => {
    saveConfig('{"owners":["example"]}');
    expect(await setupHarness({ stdout: remote }).trust()).toEqual({
      trusted: "yes",
    });
  });

  it("leaves local-file origins undecided even for a saved owner", async () => {
    saveConfig('{"owners":["tmp"]}');
    expect(
      await setupHarness({ stdout: "file://github.com/tmp/repo" }).trust(),
    ).toEqual({ trusted: "undecided" });
  });

  it.each([
    "http://github.com/o/r",
    "git://github.com/o/r",
    "git+ssh://git@github.com/o/r.git",
    "ftp://github.com/o/r",
    "custom://github.com/o/r",
  ])("leaves unsupported protocol origins undecided: %s", async (remote) => {
    saveConfig('{"owners":["o"]}');
    expect(await setupHarness({ stdout: remote }).trust()).toEqual({
      trusted: "undecided",
    });
  });

  it.each([
    "git@gitlab.com:example/repo.git",
    "https://github.com.evil.test/example/repo.git",
    "https://github.com/example/repo/extra",
    "git@github.com:example/repo/extra",
    "https://github.com/example",
    "https://github.com/%zz/repo",
    "not a remote",
  ])("rejects unsupported remote %s", async (remote) => {
    saveConfig('{"owners":["example"]}');
    expect(await setupHarness({ stdout: remote }).trust()).toEqual({
      trusted: "undecided",
    });
  });

  it("requires every origin URL to match and uses upstream git arguments", async () => {
    saveConfig('{"owners":["EXAMPLE","other"]}');
    const harness = setupHarness({
      stdout:
        "https://github.com/example/one.git\r\n git@github.com:other/two.git\n\n",
    });
    expect(await harness.trust()).toEqual({ trusted: "yes" });
    expect(harness.exec).toHaveBeenCalledWith(
      "git",
      ["remote", "get-url", "--all", "origin"],
      { cwd: testRootDir, timeout: 5000 },
    );
    expect(
      await setupHarness({
        stdout:
          "https://github.com/example/one\nhttps://github.com/unknown/two",
      }).trust(),
    ).toEqual({ trusted: "undecided" });
  });

  it.each([{ stdout: "" }, { code: 1 }, { throws: true }])(
    "leaves missing or failed origins undecided: %j",
    async (options) => {
      saveConfig('{"owners":["earendil-works"]}');
      expect(await setupHarness(options).trust()).toEqual({
        trusted: "undecided",
      });
    },
  );
});

describe("owners config", () => {
  it.each([undefined, '{"owners":[]}'])(
    "does not run git for missing/empty config %s",
    async (text) => {
      if (text !== undefined) {
        saveConfig(text);
      }
      const harness = setupHarness();
      expect(await harness.trust()).toEqual({ trusted: "undecided" });
      expect(harness.exec).not.toHaveBeenCalled();
      expect(harness.notifications).toEqual([]);
    },
  );

  it.each([
    "{bad",
    "null",
    "[]",
    "{}",
    '{"owners":"example"}',
    '{"owners":[7]}',
    '{"owners":["bad_owner"]}',
    '{"owners":["-bad"]}',
    JSON.stringify({ owners: ["x".repeat(40)] }),
  ])(
    "fails closed and refuses to overwrite malformed config %s",
    async (text) => {
      saveConfig(text);
      const harness = setupHarness();
      expect(await harness.trust()).toEqual({ trusted: "undecided" });
      expect(harness.exec).not.toHaveBeenCalled();
      expect(harness.notifications[0]?.type).toBe("error");
      expect(harness.notifications[0]?.message).toContain(configPath());
      for (const args of ["add example", "remove example", "list"]) {
        await harness.run(args);
        expect(harness.notifications.at(-1)?.type).toBe("error");
        expect(readFileSync(configPath(), "utf8")).toBe(text);
      }
      expect(await harness.command.getArgumentCompletions?.("remove ")).toEqual(
        [],
      );
    },
  );

  it("reports malformed config on stderr without UI", async () => {
    saveConfig("{bad");
    const harness = setupHarness();
    harness.ctx.hasUI = false;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await harness.trust()).toEqual({ trusted: "undecided" });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toContain(configPath());
      expect(harness.notifications).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("/trust-github-repos", () => {
  it("lists no owners by default without creating config", async () => {
    const harness = setupHarness();
    for (const args of ["", "list"]) {
      await harness.run(args);
      expect(harness.notifications.at(-1)?.message.toLowerCase()).toContain(
        "no trusted owners",
      );
      expect(harness.notifications.at(-1)?.message).toContain(configPath());
    }
    expect(existsSync(configPath())).toBe(false);
  });

  it("adds lowercased owners, sorts/dedupes, preserves unknown keys, and removes", async () => {
    const harness = setupHarness();
    await harness.run("add ZED");
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({
      owners: ["zed"],
    });
    saveConfig('{"owners":["zed","zed"],"note":{"keep":true}}');
    await harness.run("add EXAMPLE");
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({
      owners: ["example", "zed"],
      note: { keep: true },
    });
    expect(readFileSync(configPath(), "utf8").endsWith("\n")).toBe(true);
    expect(harness.notifications.at(-1)?.message).toContain("next Pi start");
    await harness.run("list");
    expect(harness.notifications.at(-1)?.message).toContain("example, zed");
    expect(harness.notifications.at(-1)?.message).toContain(configPath());
    await harness.run("add Example");
    expect(harness.notifications.at(-1)?.message).toContain("already");
    expect(harness.notifications.at(-1)?.message).toContain("next Pi start");
    await harness.run("remove EXAMPLE");
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({
      owners: ["zed"],
      note: { keep: true },
    });
    expect(harness.notifications.at(-1)?.message).toContain("next Pi start");
    await harness.run("remove example");
    expect(harness.notifications.at(-1)?.message).toContain("not present");
    expect(harness.notifications.at(-1)?.message).toContain("next Pi start");
    await harness.run("remove zed");
    expect(await harness.trust()).toEqual({ trusted: "undecided" });
    expect(harness.exec).not.toHaveBeenCalled();
  });

  it.each([
    "add bad_owner",
    "add -bad",
    "remove bad/owner",
    `add ${"x".repeat(40)}`,
    "add",
    "remove",
    "bogus",
    "add one two",
    "list extra",
  ])("rejects invalid arguments %s without writes", async (args) => {
    const harness = setupHarness();
    await harness.run(args);
    expect(harness.notifications.at(-1)?.type).toBe("error");
    expect(existsSync(configPath())).toBe(false);
  });

  it("accepts the stated owner length and character boundaries", async () => {
    const harness = setupHarness();
    for (const owner of ["0", "x".repeat(39), "a-"]) {
      await harness.run(`add ${owner}`);
      expect(harness.notifications.at(-1)?.type).toBe("info");
    }
  });

  it("completes subcommands and saved remove owners case-insensitively", async () => {
    const harness = setupHarness();
    const complete = harness.command.getArgumentCompletions;
    expect(await complete?.("")).toEqual(
      ["list", "add", "remove"].map((value) => ({ value, label: value })),
    );
    expect(await complete?.("re")).toEqual([
      { value: "remove", label: "remove" },
    ]);
    expect(await complete?.("remove ")).toEqual([]);
    await harness.run("add ZED");
    await harness.run("add example");
    expect(await complete?.("remove ")).toEqual(
      ["example", "zed"].map((owner) => ({
        value: `remove ${owner}`,
        label: owner,
      })),
    );
    expect(await complete?.("remove E")).toEqual([
      { value: "remove example", label: "example" },
    ]);
    expect(await complete?.("add ")).toEqual([]);
  });

  it("uses homedir at call time, not import time", async () => {
    const harness = setupHarness();
    currentHomeDir = join(testRootDir, "second-home");
    await harness.run("add example");
    expect(existsSync(configPath())).toBe(true);
    expect(
      existsSync(
        join(testRootDir, "home", ".pi", "agent", "trust-github-repos.json"),
      ),
    ).toBe(false);
  });
});

it("registers the directory entry in the existing manifest position", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
  ) as { pi: { extensions: string[] } };
  const entries = manifest.pi.extensions;
  expect(entries[entries.indexOf("./extensions/no-sleep.ts") + 1]).toBe(
    "./extensions/trust-github-repos",
  );
  expect(entries).not.toContain("./extensions/trust-github-repos.ts");
});
