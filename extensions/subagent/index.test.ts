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
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

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
