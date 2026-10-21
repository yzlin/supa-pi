// SupaPi additions: offline tests for the Apache-2.0 subagent adaptation; see extensions/subagent/NOTICE and LICENSE.upstream.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { isRecord, THINKING_LEVELS } from "./agents";
import subagentExtension from "./index";

let childConfig: string | undefined;
beforeEach(() => {
  childConfig = process.env.SUPA_PI_SUBAGENT_CONFIG;
  delete process.env.SUPA_PI_SUBAGENT_CONFIG;
});
afterEach(() => {
  if (childConfig !== undefined) {
    process.env.SUPA_PI_SUBAGENT_CONFIG = childConfig;
  }
});

test("native output schema and parallel contract; programmatic calls traverse parent hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "supa-subagent-tool-"));
  const provider = fauxProvider();
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate", {}), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "models-store.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  let observed = false;
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        subagentExtension(pi);
        pi.registerTool({
          name: "delegate",
          label: "Delegate",
          description: "programmatic consumer",
          parameters: Type.Object({}),
          async execute(_id, _params, _signal, _update, ctx) {
            const outcome = await ctx.executeTool("subagent", { task: "task" });
            expect(outcome.isError).toBe(true);
            return outcome.result;
          },
        });
        pi.on("tool_call", (event) => {
          if (event.toolName === "subagent") {
            observed = Boolean(event.parentToolCallId);
            return { block: true, reason: "offline hook proof" };
          }
          return;
        });
      },
    ],
  });
  await loader.reload();
  const flag = loader
    .getExtensions()
    .extensions.flatMap((extension) => [...extension.flags.values()])
    .find((item) => item.name === "attach-subagent");
  expect(flag).toMatchObject({ name: "attach-subagent", type: "string" });
  const tool = loader
    .getExtensions()
    .extensions.flatMap((extension) => [...extension.tools.values()])
    .find((item) => item.definition.name === "subagent")?.definition;
  expect(tool?.executionMode).toBe("parallel");
  if (
    !tool ||
    !("properties" in tool.parameters) ||
    !isRecord(tool.parameters.properties)
  ) {
    throw new Error("Missing tool parameter fields");
  }
  expect(tool.parameters.properties.thinking).toMatchObject({
    type: "string",
    enum: [...THINKING_LEVELS],
  });
  expect(tool.parameters.properties.thinking).not.toHaveProperty("anyOf");
  if (!tool.outputSchema) {
    throw new Error("Missing native outputSchema");
  }
  expect(
    Check(tool.outputSchema, {
      runId: "run",
      provider: "faux",
      model: "faux-1",
      thinking: "off",
      output: "text",
      structuredOutput: { ok: true },
      resultPath: "/evidence/result.json",
      sessionFile: "/evidence/session.jsonl",
    }),
  ).toBe(true);
  expect(
    Check(tool.parameters, {
      task: "task",
      agent: "worker",
      schema: { type: "object" },
    }),
  ).toBe(true);
  expect(Check(tool.parameters, { task: "task", background: true })).toBe(
    false,
  );
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    model: provider.getModel(),
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
  });
  try {
    await session.bindExtensions({ mode: "print" });
    await session.prompt("delegate");
    expect(observed).toBe(true);
  } finally {
    session.dispose();
  }
});

// Pi-internals guard: every extension's ctx.ui getter returns one mutable runner.uiContext; the parent FIFO wraps it in place.
function fakeUIContext(opened: string[]) {
  const pending: Array<(value: string | undefined) => void> = [];
  const ui: ExtensionUIContext = {
    select: async () => undefined,
    // Displace-and-orphan: each open replaces the visible dialog; only the newest can be answered.
    confirm: (title) =>
      new Promise<string | undefined>((resolve) => {
        opened.push(title);
        pending.splice(0, pending.length, resolve);
      }).then((value) => value === "Yes"),
    input: async () => undefined,
    notify: () => undefined,
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async () => {
      throw new Error("unused");
    },
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  };
  return {
    ui,
    answer(value: string) {
      const resolve = pending.pop();
      if (!resolve) {
        throw new Error("No visible dialog");
      }
      resolve(value);
    },
  };
}

// Identity only; reading the property directly trips unbound-method.
function confirmOf(ui: ExtensionUIContext): unknown {
  return Object.getOwnPropertyDescriptor(ui, "confirm")?.value;
}

async function bindSession(uiContext?: ExtensionUIContext) {
  const root = await mkdtemp(path.join(tmpdir(), "supa-subagent-ui-"));
  const provider = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "models-store.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const seen: Array<{ ui: ExtensionUIContext; hasUI: boolean }> = [];
  let confirmBeforeWrap: unknown;
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on("session_start", (_event, ctx) => {
          confirmBeforeWrap = confirmOf(ctx.ui);
          seen.push({ ui: ctx.ui, hasUI: ctx.hasUI });
        });
      },
      subagentExtension,
      (pi) => {
        pi.on("session_start", (_event, ctx) => {
          seen.push({ ui: ctx.ui, hasUI: ctx.hasUI });
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    model: provider.getModel(),
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
  });
  await session.bindExtensions(
    uiContext ? { uiContext, mode: "tui" } : { mode: "print" },
  );
  return { session, seen, confirmBeforeWrap };
}

test("parent session_start queues dialogs on the ctx.ui object shared by all extensions", async () => {
  const opened: string[] = [];
  const fake = fakeUIContext(opened);
  const { session, seen, confirmBeforeWrap } = await bindSession(fake.ui);
  try {
    const [first, last] = seen;
    if (!first || !last) {
      throw new Error("session_start not observed");
    }
    expect(first.hasUI).toBe(true);
    // Shared mutable object: the later extension sees the subagent wrap made after the earlier one ran.
    expect(last.ui).toBe(first.ui);
    expect(confirmOf(first.ui)).not.toBe(confirmBeforeWrap);
    const a = last.ui.confirm("first", "m");
    const b = first.ui.confirm("second", "m");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual(["first"]);
    fake.answer("Yes");
    expect(await a).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual(["first", "second"]);
    fake.answer("No");
    expect(await b).toBe(false);
  } finally {
    session.dispose();
  }
});

test("parent without UI leaves ctx.ui unwrapped", async () => {
  const { session, seen, confirmBeforeWrap } = await bindSession();
  try {
    expect(seen[0]?.hasUI).toBe(false);
    const last = seen[1];
    if (!last) {
      throw new Error("session_start not observed");
    }
    expect(confirmOf(last.ui)).toBe(confirmBeforeWrap);
  } finally {
    session.dispose();
  }
});
