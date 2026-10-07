// SupaPi additions: offline tests for the Apache-2.0 subagent adaptation; see extensions/subagent/NOTICE and LICENSE.upstream.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { parseAgent } from "./agents";
import { registerChildBootstrap } from "./child";
import { schemaHash, type ChildConfig, validateResult } from "./protocol";

async function fixture(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  tools = "none",
  extra?: (pi: ExtensionAPI) => void,
) {
  const root = await mkdtemp(path.join(tmpdir(), "supa-subagent-bootstrap-"));
  const provider = fauxProvider();
  provider.setResponses(responses);
  const model = provider.getModel();
  const runId = randomUUID();
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  const config: ChildConfig = {
    version: 1,
    runId,
    parentSessionId: randomUUID(),
    cwd: root,
    provider: model.provider,
    model: model.id,
    thinking: "off",
    trusted: false,
    agent: parseAgent(
      `---\nname: worker\ntools: ${tools}\nskills: false\n---\nROLE_SYSTEM_ONLY`,
      "worker.md",
    ),
    schema,
    schemaHash: schemaHash(schema),
  };
  const resultPath = path.join(root, "result.json");
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "models-store.json"),
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(provider.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        registerChildBootstrap(pi, config, resultPath);
        extra?.(pi);
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    model,
    modelRuntime: runtime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root, { id: runId }),
  });
  await session.bindExtensions({ mode: "print", shutdownHandler: () => {} });
  return { session, provider, config, resultPath };
}
test("tools:none retains report tool; invalid reports give feedback; one missing-final correction", async () => {
  const f = await fixture([
    (context) => {
      expect(
        JSON.stringify(
          context.messages.filter((message) => message.role === "system"),
        ),
      ).toContain("ROLE_SYSTEM_ONLY");
      expect(
        JSON.stringify(
          context.messages.filter((message) => message.role === "user"),
        ),
      ).not.toContain("ROLE_SYSTEM_ONLY");
      expect(
        context.messages
          .flatMap((message) =>
            message.role === "system" ? (message.toolsAdded ?? []) : [],
          )
          .map((tool) => tool.name),
      ).toEqual(["StructuredOutput"]);
      return fauxAssistantMessage("forgot report");
    },
    fauxAssistantMessage(fauxToolCall("StructuredOutput", { ok: "invalid" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("StructuredOutput", { ok: true }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(""),
  ]);
  try {
    await f.session.prompt("Fresh delegated task");
    const raw: unknown = JSON.parse(await readFile(f.resultPath, "utf8"));
    expect(validateResult(raw, f.config).structuredOutput).toEqual({
      ok: true,
    });
    expect(f.provider.state.callCount).toBe(4);
    expect(JSON.stringify(f.session.messages)).toContain("Validation failed");
  } finally {
    f.session.dispose();
  }
});
test("exactly one final continuation; no continuation after aborted/error outcome", async () => {
  for (const failure of ["missing", "error", "aborted"] as const) {
    const f = await fixture(
      failure === "missing"
        ? [
            fauxAssistantMessage("missing"),
            fauxAssistantMessage("still missing"),
          ]
        : [
            fauxAssistantMessage("", {
              stopReason: failure,
              errorMessage: `offline ${failure}`,
            }),
          ],
    );
    try {
      await f.session.prompt("task");
      const raw: unknown = JSON.parse(await readFile(f.resultPath, "utf8"));
      expect(validateResult(raw, f.config).status).toBe("failed");
      expect(f.provider.state.callCount).toBe(failure === "missing" ? 2 : 1);
    } finally {
      f.session.dispose();
    }
  }
});
test("deny policy blocks both direct and nested calls even if extension reactivates tools", async () => {
  let forbidden = 0;
  const f = await fixture(
    [
      fauxAssistantMessage(
        [fauxToolCall("forbidden", {}), fauxToolCall("nest", {})],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("StructuredOutput", { ok: true }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(""),
    ],
    "nest",
    (pi) => {
      pi.registerTool({
        name: "forbidden",
        exposure: "codemode",
        label: "Forbidden",
        description: "forbidden",
        parameters: Type.Object({}),
        async execute() {
          forbidden++;
          return { content: [{ type: "text", text: "unsafe" }], details: {} };
        },
      });
      pi.registerTool({
        name: "nest",
        label: "Nest",
        description: "nested",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          const result = await ctx.executeTool("forbidden", {});
          return result.result;
        },
      });
      pi.on("before_agent_start", () =>
        pi.setActiveTools(["forbidden", "nest", "StructuredOutput"]),
      );
    },
  );
  try {
    await f.session.prompt("task");
    expect(forbidden).toBe(0);
    expect(JSON.stringify(f.session.messages)).toContain("blocked");
  } finally {
    f.session.dispose();
  }
});

test("inherited delegation tools are neither declared nor listed as callable to nested tools", async () => {
  let delegated = 0;
  let checked = false;
  const f = await fixture(
    [
      (context) => {
        const names = context.messages
          .flatMap((message) =>
            message.role === "system" ? (message.toolsAdded ?? []) : [],
          )
          .map((tool) => tool.name);
        expect(names).not.toContain("Agent");
        return fauxAssistantMessage(fauxToolCall("nest", {}), {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage(fauxToolCall("StructuredOutput", { ok: true }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(""),
    ],
    "*",
    (pi) => {
      pi.registerTool({
        name: "Agent",
        label: "Old delegate",
        description: "must not be exposed",
        exposure: "codemode",
        parameters: Type.Object({}),
        async execute() {
          delegated++;
          return { content: [], details: {} };
        },
      });
      pi.registerTool({
        name: "nest",
        label: "Nest",
        description: "check child callable metadata",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
          expect(ctx.tools.map((tool) => tool.name)).not.toContain("Agent");
          const outcome = await ctx.executeTool("Agent", {});
          expect(outcome.isError).toBe(true);
          checked = true;
          return outcome.result;
        },
      });
      pi.on("before_agent_start", () =>
        pi.setActiveTools(["Agent", "nest", "StructuredOutput"]),
      );
    },
  );
  try {
    await f.session.prompt("task");
    expect(delegated).toBe(0);
    expect(checked).toBe(true);
  } finally {
    f.session.dispose();
  }
});
