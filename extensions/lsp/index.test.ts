import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import lspExtension from "./index";

const TEST_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

type LspOverlayComponent = {
  render(width: number): string[];
  handleInput(data: string): void;
};

function withTempHome<T>(
  run: (paths: { homeDir: string; cwd: string }) => Promise<T> | T
) {
  const previousHome = process.env.HOME;
  const rootDir = mkdtempSync(join(tmpdir(), "pi-lsp-index-test-"));
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

function createHarness(cwd: string, options?: { customUI?: boolean }) {
  const commands = new Map<
    string,
    {
      handler: (args: string, ctx: unknown) => Promise<void> | void;
      getArgumentCompletions?: (prefix: string) => unknown;
    }
  >();
  const notifications: Array<{ message: string; level: string }> = [];
  const renders: string[][] = [];
  let component: LspOverlayComponent | null = null;

  const pi = {
    registerCommand(
      name: string,
      definition: {
        handler: (args: string, ctx: unknown) => Promise<void> | void;
        getArgumentCompletions?: (prefix: string) => unknown;
      }
    ) {
      commands.set(name, definition);
    },
    registerTool() {},
    on() {},
  };

  const ctx = {
    cwd,
    hasUI: options?.customUI ?? false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setStatus() {},
      ...(options?.customUI
        ? {
            async custom(factory: any) {
              component = factory(
                {
                  requestRender() {},
                },
                TEST_THEME,
                {},
                () => {}
              );

              renders.push(component?.render(80) ?? []);
            },
          }
        : {}),
    },
  };

  lspExtension(pi as never);

  return {
    commands,
    command: commands.get("lsp"),
    notifications,
    renders,
    ctx,
    rerender(width = 80) {
      const next = component?.render(width) ?? [];
      renders.push(next);
      return next.join("\n");
    },
  };
}

describe("lsp command", () => {
  it("registers only the /lsp command with subcommand completions", async () => {
    await withTempHome(async ({ cwd }) => {
      const harness = createHarness(cwd);

      expect(harness.commands.has("lsp")).toBe(true);
      expect(harness.commands.has("lsp-restart")).toBe(false);
      expect(harness.command?.getArgumentCompletions).toBeFunction();
      expect(harness.command?.getArgumentCompletions?.(""))?.toEqual([
        {
          value: "status",
          label: "status",
          description: "Show LSP server status",
        },
        {
          value: "restart",
          label: "restart",
          description: "Restart all LSP servers",
        },
        {
          value: "help",
          label: "help",
          description: "Show LSP command help",
        },
      ]);
    });
  });

  it("uses status as the default subcommand", async () => {
    await withTempHome(async ({ cwd }) => {
      const harness = createHarness(cwd);

      await harness.command?.handler("", harness.ctx as never);

      expect(harness.notifications).toContainEqual({
        message: [
          "LSP Status:",
          "  No servers configured.",
          "  Add servers to ~/.pi/agent/lsp.json or .pi/lsp.json",
        ].join("\n"),
        level: "info",
      });
    });
  });

  it("shows configured servers without probing them during status", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
      writeFileSync(
        join(homeDir, ".pi", "agent", "lsp.json"),
        JSON.stringify({
          lsp: {
            rust: {
              command: ["rust-analyzer"],
              extensions: [".rs"],
            },
          },
        }),
        "utf8"
      );

      const harness = createHarness(cwd);

      await harness.command?.handler("status", harness.ctx as never);

      expect(harness.notifications).toContainEqual({
        message: [
          "LSP Status:",
          "  rust: configured (lazy probe) — handles .rs",
        ].join("\n"),
        level: "info",
      });
    });
  });

  it("renders a richer status overlay when custom UI is available", async () => {
    await withTempHome(async ({ homeDir, cwd }) => {
      mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
      writeFileSync(
        join(homeDir, ".pi", "agent", "lsp.json"),
        JSON.stringify({
          lsp: {
            rust: {
              command: ["rust-analyzer"],
              extensions: [".rs"],
            },
            typescript: {
              command: ["typescript-language-server", "--stdio"],
              extensions: [".ts", ".tsx"],
            },
          },
        }),
        "utf8"
      );

      const harness = createHarness(cwd, { customUI: true });

      await harness.command?.handler("status", harness.ctx as never);

      expect(harness.notifications).toEqual([]);
      expect(harness.renders).toHaveLength(1);

      const render = harness.renders[0]?.join("\n") ?? "";
      expect(render).toContain("Language Server Protocol");
      expect(render).toContain("configured 2");
      expect(render).toContain("lazy 2");
      expect(render).toContain("rust");
      expect(render).toContain("typescript");
      expect(render).toContain("command typescript-language-server --stdio");
      expect(render).toContain("enter/esc/q close");
    });
  });

  it("supports the restart subcommand", async () => {
    await withTempHome(async ({ cwd }) => {
      const harness = createHarness(cwd);

      await harness.command?.handler("restart", harness.ctx as never);

      expect(harness.notifications).toContainEqual({
        message: "LSP servers stopped. Will reinitialize on next tool use.",
        level: "info",
      });
    });
  });

  it("shows help for unknown subcommands", async () => {
    await withTempHome(async ({ cwd }) => {
      const harness = createHarness(cwd);

      await harness.command?.handler("wat", harness.ctx as never);

      expect(harness.notifications).toEqual([
        {
          message: "Unknown /lsp subcommand: wat",
          level: "warning",
        },
        {
          message: [
            "LSP commands:",
            "  /lsp           Show LSP server status",
            "  /lsp status    Show LSP server status",
            "  /lsp restart   Restart all LSP servers",
            "  /lsp help      Show this help",
            "",
            "Close: esc, enter, or q",
          ].join("\n"),
          level: "info",
        },
      ]);
    });
  });
});
