import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  resolveConfiguredServer,
  scaffoldGlobalConfig,
} from "./config";

function withTempHome<T>(
  run: (paths: { homeDir: string; cwd: string }) => Promise<T> | T
) {
  const previousHome = process.env.HOME;
  const rootDir = mkdtempSync(join(tmpdir(), "pi-lsp-config-test-"));
  const homeDir = join(rootDir, "home");
  const cwd = join(rootDir, "workspace");

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  process.env.HOME = homeDir;

  return Promise.resolve()
    .then(() => run({ homeDir, cwd }))
    .finally(() => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      rmSync(rootDir, { recursive: true, force: true });
    });
}

describe("lsp config", () => {
  it("scaffolds the global config at ~/.pi/agent/lsp.json", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const created = await scaffoldGlobalConfig(cwd);
      const configPath = join(homeDir, ".pi", "agent", "lsp.json");

      expect(created).toBe(true);

      const scaffolded = JSON.parse(readFileSync(configPath, "utf8")) as {
        lsp: Record<string, { command: string[]; extensions: string[] }>;
      };

      expect(Object.keys(scaffolded.lsp)).toEqual([
        "typescript",
        "vue",
        "svelte",
        "python",
        "go",
        "rust",
        "ruby",
      ]);
      expect(scaffolded.lsp.typescript).toEqual({
        command: ["typescript-language-server", "--stdio"],
        extensions: [
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          ".mts",
          ".cts",
        ],
      });
      expect(scaffolded.lsp.python).toEqual({
        command: ["pyright-langserver", "--stdio"],
        extensions: [".py", ".pyi"],
      });
    });
  });

  it("loads the global config from ~/.pi/agent/lsp.json", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const configPath = join(homeDir, ".pi", "agent", "lsp.json");
      mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ lsp: false }), "utf8");

      const config = await loadConfig(cwd);

      expect(config.globalDisabled).toBe(true);
    });
  });

  it("loads configured servers without probing command availability", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      const configPath = join(homeDir, ".pi", "agent", "lsp.json");
      mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          lsp: {
            missing: {
              command: ["definitely-not-installed-lsp"],
              extensions: [".foo"],
            },
          },
        }),
        "utf8"
      );

      const config = await loadConfig(cwd);

      expect(config.globalDisabled).toBe(false);
      expect(config.errors).toEqual([]);
      expect(config.servers).toEqual([
        {
          name: "missing",
          command: ["definitely-not-installed-lsp"],
          extensions: [".foo"],
          env: {},
          initializationOptions: {},
        },
      ]);
    });
  });

  it("caches command availability when resolving configured servers", () => {
    const availabilityCache = new Map<string, "global" | "npx" | null>();
    let probes = 0;
    const server = {
      name: "typescript",
      command: ["typescript-language-server", "--stdio"],
      extensions: [".ts"],
      env: {},
      initializationOptions: {},
    };

    const first = resolveConfiguredServer(
      server,
      "/workspace",
      availabilityCache,
      () => {
        probes++;
        return "npx";
      }
    );
    const second = resolveConfiguredServer(
      server,
      "/workspace",
      availabilityCache,
      () => {
        probes++;
        return "global";
      }
    );

    expect(probes).toBe(1);
    expect(first).toEqual({
      name: "typescript",
      command: "npx",
      args: ["--yes", "typescript-language-server", "--stdio"],
      extensions: [".ts"],
      env: {},
      initializationOptions: {},
    });
    expect(second).toEqual(first);
  });
});
