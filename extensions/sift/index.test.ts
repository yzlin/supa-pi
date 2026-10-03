import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAgentDir } from "./config";
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

const JEV = { provider: "typesafe", id: "jev-latest" };
function selectModel(model: { provider: string; id: string } | undefined) {
  return () => Promise.resolve(model as never);
}

function runtime(
  extension = createSiftExtension({
    configStore: {
      load: async () => false,
      save: () => Promise.resolve(),
    },
    selectModel: selectModel(JEV),
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

function context(
  options: {
    cwd?: string;
    hasUI?: boolean;
    confirm?: boolean;
  } = {},
) {
  const notifications: string[] = [];
  const confirmTexts: string[] = [];
  return {
    cwd: options.cwd ?? process.cwd(),
    hasUI: options.hasUI ?? true,
    mode: options.hasUI === false ? "print" : "tui",
    modelRegistry: {},
    notifications,
    confirmTexts,
    ui: {
      notify: (message: string) => notifications.push(message),
      confirm: async (_title: string, message: string) => {
        confirmTexts.push(message);
        return options.confirm ?? true;
      },
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
    ).toEqual(["status", "enable", "disable"]);
  });

  it("fails while disabled and enable requires confirmation", async () => {
    const app = runtime();
    const ctx = context();
    expect(
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
    expect(
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
      selectModel: selectModel(JEV),
      createClient: () => ({
        judge: async () => ({ probability: 1, model: "typesafe/jev-latest" }),
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
    expect(
      interactive.tools[0].execute(
        "x",
        { query: "q", paths: ["a.txt"] },
        new AbortController().signal,
        undefined,
        context({ cwd }),
      ),
    ).rejects.toThrow("enable");
  });

  it("enable requires a Jev model and names it in consent", async () => {
    let enabled = false;
    const configStore = {
      load: async () => enabled,
      save: (value: boolean) => {
        enabled = value;
        return Promise.resolve();
      },
    };
    const missing = runtime(
      createSiftExtension({ configStore, selectModel: selectModel(undefined) }),
    );
    const missingCtx = context();
    await missing.commands.get("sift")?.handler("enable", missingCtx);
    expect(enabled).toBe(false);
    expect(missingCtx.confirmTexts).toEqual([]);
    expect(missingCtx.notifications.join(" ")).toContain(
      "Jev classifier model",
    );

    const openrouter = { provider: "openrouter", id: "typesafe/jev-1.13" };
    const app = runtime(
      createSiftExtension({
        configStore,
        selectModel: selectModel(openrouter),
      }),
    );
    const ctx = context();
    await app.commands.get("sift")?.handler("enable", ctx);
    expect(enabled).toBe(true);
    expect(ctx.confirmTexts[0]).toContain("openrouter/typesafe/jev-1.13");
    await app.commands.get("sift")?.handler("status", ctx);
    expect(ctx.notifications.at(-1)).toContain(
      "model=openrouter/typesafe/jev-1.13",
    );
    for (const removed of ["login", "logout"]) {
      await app.commands.get("sift")?.handler(removed, ctx);
      expect(ctx.notifications.at(-1)).toBe(
        "Usage: /sift [status|enable|disable]",
      );
    }
    expect(enabled).toBe(true);
  });

  it("supports safe status, successful output, and session reset", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sift-extension-"));
    await writeFile(join(cwd, "a.txt"), "ordinary content");
    let configEnabled = false;
    const extension = createSiftExtension({
      configStore: {
        load: async () => configEnabled,
        save: (value: boolean) => {
          configEnabled = value;
          return Promise.resolve();
        },
      },
      selectModel: selectModel(JEV),
      createClient: () => ({
        judge: async () => ({ probability: 0.8, model: "typesafe/jev-latest" }),
      }),
      env: {},
    });
    const app = runtime(extension);
    const ctx = context({ cwd });
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
    expect(ctx.notifications.at(-1)).toBe(
      "Sift enabled; model=typesafe/jev-latest; attempted=1, remaining=99; secret detection is incomplete.",
    );
    app.events.get("session_start")?.();
    const afterReset = await app.tools[0].execute(
      "x",
      { query: "q", paths: ["a.txt"] },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(afterReset.content[0].text).toContain("remaining=99");
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
        selectModel: selectModel(JEV),
        createClient: () => ({
          judge: (_query, path) => {
            seen.push(path);
            return Promise.resolve({
              probability: 0.5,
              model: "typesafe/jev-latest",
            });
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

  it("fails enabled tool calls without a Jev model before reading files", async () => {
    let clients = 0;
    const app = runtime(
      createSiftExtension({
        configStore: {
          load: async () => true,
          save: () => Promise.resolve(),
        },
        selectModel: selectModel(undefined),
        createClient: () => {
          clients++;
          return { judge: () => Promise.reject(new Error("unused")) };
        },
      }),
    );
    expect(
      app.tools[0].execute(
        "x",
        { query: "q", paths: ["a"] },
        new AbortController().signal,
        undefined,
        context({ hasUI: false }),
      ),
    ).rejects.toThrow("Jev classifier model");
    expect(clients).toBe(0);
  });

  it("fails closed when persisted enablement cannot be read", async () => {
    const failure = new Error("Sift config is invalid");
    const app = runtime(
      createSiftExtension({
        configStore: {
          load: () => Promise.reject(failure),
          save: () => Promise.resolve(),
        },
        selectModel: selectModel(JEV),
      }),
    );
    expect(
      app.commands.get("sift")?.handler("status", context({ hasUI: false })),
    ).rejects.toThrow("Sift config is invalid");
    expect(
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
        selectModel: selectModel(undefined),
      }),
    );
    await app.commands
      .get("sift")
      ?.handler("status", context({ hasUI: false }));
    expect(app.messages[0]?.message.content).toContain(
      "Sift disabled; model=none",
    );
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
      selectModel: selectModel(JEV),
      createClient: () => ({
        judge: async () => ({ probability: 1, model: "typesafe/jev-latest" }),
      }),
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
