import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAgentDir } from "./credentials";
import { createSiftExtension } from "./index";

interface Command {
  handler: (args: string, ctx: TestContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string }>;
}
interface Tool {
  name: string;
  parameters: {
    properties: Record<
      string,
      {
        minLength?: number;
        maxLength?: number;
        items?: { minLength?: number; maxLength?: number };
        minItems?: number;
        maxItems?: number;
        uniqueItems?: boolean;
      }
    >;
    required?: string[];
    additionalProperties?: boolean;
  };
  renderResult: (
    result: { details?: unknown },
    options: { expanded?: boolean },
    theme: { fg: (_name: string, text: string) => string },
  ) => { render: (width: number) => string[] };
  execute: (
    id: string,
    params: { query: string; paths: string[] },
    signal: AbortSignal,
    update: unknown,
    ctx: TestContext,
  ) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
}
type TestContext = ReturnType<typeof context>;

function runtime(
  extension = createSiftExtension({
    configStore: {
      load: async () => false,
      save: () => Promise.resolve(),
    },
  }),
) {
  const tools: Tool[] = [];
  const commands = new Map<string, Command>();
  const events = new Map<string, () => void>();
  const messages: Array<{
    message: { content?: string };
    options?: { triggerTurn?: boolean };
  }> = [];
  extension({
    registerTool: (tool: Tool) => tools.push(tool),
    registerCommand: (name: string, command: Command) =>
      commands.set(name, command),
    on: (name: string, handler: () => void) => events.set(name, handler),
    sendMessage: (
      message: { content?: string },
      options?: { triggerTurn?: boolean },
    ) => messages.push({ message, options }),
  } as never);
  return { tools, commands, events, messages };
}
interface PromptComponent {
  render(width: number): string[];
}
interface PromptTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}
type CustomPrompt = (
  factory: (
    tui: unknown,
    theme: PromptTheme,
    keybindings: unknown,
    done: (value: string | undefined) => void,
  ) => PromptComponent,
) => Promise<string | undefined>;

function context(
  options: {
    cwd?: string;
    hasUI?: boolean;
    confirm?: boolean;
    custom?: CustomPrompt;
  } = {},
) {
  const notifications: string[] = [];
  return {
    cwd: options.cwd ?? process.cwd(),
    hasUI: options.hasUI ?? true,
    mode: options.hasUI === false ? "print" : "tui",
    notifications,
    ui: {
      notify: (message: string) => notifications.push(message),
      confirm: async () => options.confirm ?? true,
      custom: options.custom ?? (async () => undefined),
    },
  };
}

describe("sift extension", () => {
  it("registers exactly one strict public tool and one command with fixed actions", () => {
    const app = runtime();
    expect(app.tools).toHaveLength(1);
    expect(app.tools[0].name).toBe("sift_files");
    expect(Object.keys(app.tools[0].parameters.properties)).toEqual([
      "query",
      "paths",
    ]);
    expect(app.tools[0].parameters.required).toEqual(["query", "paths"]);
    expect(app.tools[0].parameters.additionalProperties).toBe(false);
    expect(app.tools[0].parameters.properties.query).toMatchObject({
      minLength: 1,
      maxLength: 2000,
    });
    expect(app.tools[0].parameters.properties.paths).toMatchObject({
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { minLength: 1, maxLength: 1000 },
    });
    expect([...app.commands.keys()]).toEqual(["sift"]);
    expect(
      app.commands
        .get("sift")
        ?.getArgumentCompletions?.("")
        .map((x) => x.value),
    ).toEqual(["login", "logout", "status", "enable", "disable"]);
  });

  it("fails while disabled and enable requires confirmation", async () => {
    const app = runtime();
    const ctx = context();
    await expect(
      app.tools[0].execute(
        "x",
        { query: "q", paths: ["a"] },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("enable");
    await app.commands
      .get("sift")
      ?.handler("enable", context({ confirm: false }));
    await expect(
      app.tools[0].execute(
        "x",
        { query: "q", paths: ["a"] },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("enable");
  });

  it("persists enablement globally and reuses it headlessly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sift-config-"));
    await writeFile(join(cwd, "a.txt"), "ordinary content");
    let enabled = false;
    const configStore = {
      load: async () => enabled,
      save: (value: boolean) => {
        enabled = value;
        return Promise.resolve();
      },
    };
    const dependencies = {
      configStore,
      credentialStore: {
        status: async () => ({ source: "stored", usable: true }) as const,
        resolve: async () => ({
          apiKey: "secret-key-123456",
          source: "stored" as const,
        }),
        save: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
      createClient: () => ({
        judge: async () => ({ probability: 1, model: "jev-latest" }),
      }),
      env: {},
    };

    const interactive = runtime(createSiftExtension(dependencies));
    await interactive.commands.get("sift")?.handler("enable", context());
    expect(enabled).toBe(true);

    const headless = runtime(createSiftExtension(dependencies));
    const result = await headless.tools[0].execute(
      "x",
      { query: "q", paths: ["a.txt"] },
      new AbortController().signal,
      undefined,
      context({ cwd, hasUI: false }),
    );
    expect(result.content[0].text).toContain("P(relevant)=1.000");

    await headless.commands
      .get("sift")
      ?.handler("disable", context({ hasUI: false }));
    expect(enabled).toBe(false);
    await expect(
      interactive.tools[0].execute(
        "x",
        { query: "q", paths: ["a.txt"] },
        new AbortController().signal,
        undefined,
        context({ cwd }),
      ),
    ).rejects.toThrow("enable");
  });

  it("explains which TypeSafe key to enter and where to get it", async () => {
    let prompt = "";
    const ctx = context({
      custom: (factory) => {
        const component = factory(
          {},
          {
            fg: (_name, text) => text,
            bold: (text) => text,
          },
          {},
          () => undefined,
        );
        prompt = component.render(100).join("\n");
        return Promise.resolve("");
      },
    });
    const app = runtime(
      createSiftExtension({
        configStore: {
          load: async () => false,
          save: () => Promise.resolve(),
        },
        credentialStore: {
          status: async () => ({ source: "missing", usable: false }) as const,
          resolve: () => Promise.reject(new Error("not used")),
          save: () => Promise.resolve(),
          clear: () => Promise.resolve(),
        },
        env: {},
      }),
    );

    await app.commands.get("sift")?.handler("login", ctx);

    const normalizedPrompt = prompt.replace(/\s+/g, " ");
    expect(normalizedPrompt).toContain("TypeSafe API key");
    expect(normalizedPrompt).toContain("console.typesafe.ai");
    expect(normalizedPrompt).toContain("API Keys");
    expect(normalizedPrompt).toContain("Input is hidden");
    expect(normalizedPrompt).toContain("Enter verifies and saves");
    expect(normalizedPrompt).toContain("Esc cancels");
  });

  it("supports verified login, safe status, successful output, logout, and session reset", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sift-extension-"));
    await writeFile(join(cwd, "a.txt"), "ordinary content");
    let saved = "";
    let configEnabled = false;
    const extension = createSiftExtension({
      configStore: {
        load: async () => configEnabled,
        save: (value: boolean) => {
          configEnabled = value;
          return Promise.resolve();
        },
      },
      credentialStore: {
        status: async () =>
          saved
            ? ({ source: "stored", usable: true } as const)
            : ({ source: "missing", usable: false } as const),
        resolve: async () => ({ apiKey: saved, source: "stored" as const }),
        save: (key: string) => {
          saved = key;
          return Promise.resolve();
        },
        clear: () => {
          saved = "";
          return Promise.resolve();
        },
      },
      readSecret: async () => "secret-key-123456",
      createClient: () => ({
        judge: async () => ({ probability: 0.8, model: "jev-latest" }),
      }),
      env: {},
    });
    const app = runtime(extension);
    const ctx = context({ cwd });
    await app.commands.get("sift")?.handler("login", ctx);
    expect(saved).toBe("secret-key-123456");
    expect(ctx.notifications.join(" ")).not.toContain(saved);
    await app.commands.get("sift")?.handler("enable", ctx);
    const result = await app.tools[0].execute(
      "x",
      { query: "q", paths: ["a.txt"] },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toContain("a.txt: P(relevant)=0.800");
    expect(result.content[0].text).toContain("remaining=99");
    const theme = { fg: (_name: string, text: string) => text };
    expect(
      app.tools[0]
        .renderResult(result, {}, theme)
        .render(120)
        .join("\n")
        .trimEnd(),
    ).toBe("1/1 judged; 99 remaining");
    const expanded = app.tools[0]
      .renderResult(result, { expanded: true }, theme)
      .render(120)
      .join("\n");
    expect(expanded).toContain("a.txt: P(relevant)=0.800");
    expect(expanded).not.toContain("ordinary content");
    await app.commands.get("sift")?.handler("status", ctx);
    expect(ctx.notifications.join(" ")).not.toContain(saved);
    app.events.get("session_start")?.();
    const afterReset = await app.tools[0].execute(
      "x",
      { query: "q", paths: ["a.txt"] },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(afterReset.content[0].text).toContain("remaining=99");
    await app.commands.get("sift")?.handler("logout", ctx);
    expect(saved).toBe("");
    expect(configEnabled).toBe(false);
  });

  it("renders mixed results without changing error or truncation text", () => {
    const app = runtime();
    const result = {
      details: {
        results: [
          { path: "full.txt", probability: 0 },
          { path: "large.txt", probability: 1, truncated: true },
          { path: "missing.txt", error: "File is unavailable" },
        ],
        attempted: 2,
        remaining: 98,
        limit: 100,
      },
    };
    const theme = { fg: (_name: string, text: string) => text };
    const lines = app.tools[0]
      .renderResult(result, { expanded: true }, theme)
      .render(120)
      .map((line) => line.trimEnd());
    expect(lines).toEqual([
      "full.txt: P(relevant)=0.000",
      "large.txt: P(relevant)=1.000 (truncated)",
      "missing.txt: error=File is unavailable",
      "2/3 judged; 98 remaining",
    ]);
  });

  it("uses canonical relative paths externally while preserving caller paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sift-path-"));
    const absolute = join(cwd, "nested.txt");
    await writeFile(absolute, "private file body");
    const seen: string[] = [];
    const app = runtime(
      createSiftExtension({
        configStore: {
          load: async () => true,
          save: () => Promise.resolve(),
        },
        credentialStore: {
          status: async () => ({ source: "stored", usable: true }) as const,
          resolve: async () => ({
            apiKey: "secret-key-123456",
            source: "stored" as const,
          }),
          save: () => Promise.resolve(),
          clear: () => Promise.resolve(),
        },
        createClient: () => ({
          judge: (_query, path) => {
            seen.push(path);
            return Promise.resolve({ probability: 0.5, model: "jev-latest" });
          },
        }),
      }),
    );
    const result = await app.tools[0].execute(
      "x",
      { query: "q", paths: [absolute] },
      new AbortController().signal,
      undefined,
      context({ cwd, hasUI: false }),
    );
    expect(seen).toEqual(["nested.txt"]);
    expect(seen[0]).not.toContain(homedir());
    expect(result.content[0].text).toContain(absolute);
  });

  it("does not expose arbitrary login verification errors", async () => {
    const secret = "provider-body-secret";
    const app = runtime(
      createSiftExtension({
        env: {},
        credentialStore: {
          status: async () => ({ source: "missing", usable: false }) as const,
          resolve: () => Promise.reject(new Error("unused")),
          save: () => Promise.resolve(),
          clear: () => Promise.resolve(),
        },
        readSecret: async () => "valid-key-1234567",
        createClient: () => ({
          judge: () => Promise.reject(new Error(secret)),
        }),
      }),
    );
    const ctx = context();
    await app.commands.get("sift")?.handler("login", ctx);
    expect(ctx.notifications.join(" ")).toBe(
      "TypeSafe credential verification failed (connection); authentication unchanged.",
    );
    expect(ctx.notifications.join(" ")).not.toContain(secret);
  });

  it("fails closed when persisted enablement cannot be read", async () => {
    const failure = new Error("Sift config is invalid");
    const app = runtime(
      createSiftExtension({
        configStore: {
          load: () => Promise.reject(failure),
          save: () => Promise.resolve(),
        },
        credentialStore: {
          status: async () => ({ source: "stored", usable: true }) as const,
          resolve: async () => ({
            apiKey: "secret-key-123456",
            source: "stored" as const,
          }),
          save: () => Promise.resolve(),
          clear: () => Promise.resolve(),
        },
      }),
    );
    await expect(
      app.commands.get("sift")?.handler("status", context({ hasUI: false })),
    ).rejects.toThrow("Sift config is invalid");
    await expect(
      app.tools[0].execute(
        "x",
        { query: "q", paths: ["a"] },
        new AbortController().signal,
        undefined,
        context({ hasUI: false }),
      ),
    ).rejects.toThrow("Sift config is invalid");
  });

  it("reports status headlessly without triggering a turn", async () => {
    const app = runtime(
      createSiftExtension({
        configStore: {
          load: async () => false,
          save: () => Promise.resolve(),
        },
        env: {},
        credentialStore: {
          status: async () => ({ source: "missing", usable: false }) as const,
          resolve: () => Promise.reject(new Error("unused")),
          save: () => Promise.resolve(),
          clear: () => Promise.resolve(),
        },
      }),
    );
    await app.commands
      .get("sift")
      ?.handler("status", context({ hasUI: false }));
    expect(app.messages[0]?.message.content).toContain("Sift disabled");
    expect(app.messages[0]?.options?.triggerTurn).toBe(false);
  });

  it("expands agent directories from the OS home", () => {
    expect(resolveAgentDir()).toBe(join(homedir(), ".pi", "agent"));
    expect(resolveAgentDir("~")).toBe(homedir());
    expect(resolveAgentDir("~/custom")).toBe(join(homedir(), "custom"));
  });

  it("honors persisted headless opt-in", async () => {
    const extension = createSiftExtension({
      configStore: {
        load: async () => true,
        save: () => Promise.resolve(),
      },
      env: {},
      credentialStore: {
        status: async () => ({ source: "stored", usable: true }) as const,
        resolve: async () => ({
          apiKey: "secret-key-123456",
          source: "stored" as const,
        }),
        save: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
      createClient: () => ({
        judge: async () => ({ probability: 1, model: "jev-latest" }),
      }),
      readSecret: async () => undefined,
    });
    const app = runtime(extension);
    const cwd = await mkdtemp(join(tmpdir(), "sift-headless-"));
    await writeFile(join(cwd, "a"), "safe");
    const result = await app.tools[0].execute(
      "x",
      { query: "q", paths: ["a"] },
      new AbortController().signal,
      undefined,
      context({ cwd, hasUI: false }),
    );
    expect(result.content[0].text).toContain("P(relevant)=1.000");
  });
});
