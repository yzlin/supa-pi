import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
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
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ReviewRunController } from "./lifecycle";
import { outcome, plan, reviewer } from "./test-fixtures";
import type { ReviewWorkflowResult } from "./workflow";

test("public SDK nested subagent outcomes bind a blocking owned review with native hooks and progress", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-native-"));
  await fs.writeFile(path.join(root, "target.txt"), "original");
  const provider = fauxProvider();
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("review-boundary", {}), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done"),
  ]);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "models-store.json"),
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(provider.provider);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const sessionManager = SessionManager.inMemory(root);
  const hooks: string[] = [];
  const progress: string[] = [];
  const reports: ReviewWorkflowResult[] = [];
  const controller = new ReviewRunController();
  const input = {
    ...plan,
    reviewerPanel: [
      {
        model: `${provider.getModel().provider}/${provider.getModel().id}`,
        thinkingLevel: "medium" as const,
      },
    ],
  };
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on("tool_call", (event) => {
          if (event.toolName === "subagent") {
            hooks.push(event.parentToolCallId ?? "missing");
          }
        });
        pi.registerTool({
          name: "subagent",
          label: "Native-shaped child",
          description: "Offline mock of the subagent result contract",
          executionMode: "parallel",
          parameters: Type.Object(
            {
              agent: Type.String(),
              task: Type.String(),
              model: Type.String(),
              thinking: Type.String(),
              schema: Type.Record(Type.String(), Type.Unknown()),
            },
            { additionalProperties: false },
          ),
          execute(_id, params, _signal, onUpdate) {
            onUpdate?.({
              content: [{ type: "text", text: "running child pane" }],
              details: {},
            });
            const result = outcome(
              { ...params, thinking: "medium" },
              reviewer("code-reviewer", []),
            ).result;
            return Promise.resolve(result);
          },
        });
        pi.registerTool({
          name: "review-boundary",
          label: "Review boundary",
          description:
            "Offline test of blocking review with native child calls",
          parameters: Type.Object({}),
          async execute(_id, _params, signal, _update, ctx) {
            const prepared = await controller.prepare(
              ctx,
              { type: "folder", paths: ["target.txt"] },
              input,
              signal,
            );
            await controller.run(prepared.id, ctx, signal, (update) => {
              for (const part of update.content) {
                if (part.type === "text") {
                  progress.push(part.text);
                }
              }
            });
            await controller.finalize(
              prepared.id,
              ctx,
              (report) => {
                reports.push(report);
              },
              signal,
            );
            return {
              content: [{ type: "text", text: "Review report published." }],
              details: {},
            };
          },
        });
      },
    ],
  });
  let dispose: (() => void) | undefined;
  try {
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      model: provider.getModel(),
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager,
    });
    dispose = () => session.dispose();
    await session.bindExtensions({ mode: "print" });
    await session.prompt("Run the offline review boundary.");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).not.toBe("missing");
    expect(progress).toEqual(["running child pane"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.verifier.verdict).toBe("correct");
    expect(provider.state.callCount).toBe(2);
  } finally {
    dispose?.();
    controller.cancel();
    await controller.settle();
    await fs.rm(root, { recursive: true, force: true });
  }
});
