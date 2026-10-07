import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
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
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ReviewRunController } from "../../extensions/review/lifecycle";
import type { ReviewWorkflowResult } from "../../extensions/review/workflow";
import { isRecord } from "../../extensions/subagent/agents";
import subagentExtension from "../../extensions/subagent/index";

// Actual tmux/Pi children; deterministic reports verify boundaries, not model review quality.
test("native review captures three actual offline children before single owned publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "supa-review-native-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  await mkdir(path.join(agentDir, "agents"), { recursive: true });
  await mkdir(cwd);
  await writeFile(path.join(cwd, "target.txt"), "Offline boundary fixture.\n");
  const reports: Record<string, unknown> = {
    "code-reviewer": {
      reviewer: "code-reviewer",
      verdict: "needs attention",
      findings: [
        {
          priority: "P2",
          title: "Offline fixture",
          file: "target.txt",
          line: 1,
          why: "This is a synthetic boundary fixture.",
          change: "Do not change the fixture.",
        },
      ],
      humanReviewerCallouts: [],
      notes: ["No actual code defect is claimed."],
    },
    "review-synthesizer": {
      clusters: [
        {
          memberIds: ["candidate-0001"],
          title: "Offline fixture",
          why: "This is a synthetic boundary fixture.",
          change: "Do not change the fixture.",
        },
      ],
    },
    "review-verifier": {
      reviewScope: ["target snapshot"],
      verdict: "correct",
      findings: [],
    },
  };
  for (const [role, report] of Object.entries(reports)) {
    const providerPath = path.join(agentDir, `${role}-provider.ts`);
    await writeFile(
      providerPath,
      `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
  const provider = fauxProvider({ models: [{ id: 'faux-1', reasoning: true }] });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('StructuredOutput', ${JSON.stringify(report)}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('offline complete')
  ]);
  pi.registerProvider(provider.provider);
}`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(agentDir, "agents", `${role}.md`),
      `---\nname: ${role}\ntools: none\nskills: false\nextensions: [${JSON.stringify(providerPath)}]\n---\nThis is an offline boundary fixture. Do not modify files. Submit the configured structured report.`,
      { mode: 0o600 },
    );
  }
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  const controller = new ReviewRunController();
  const published: ReviewWorkflowResult[] = [];
  const captures: Array<{ agent: string; runId: string; resultPath: string }> =
    [];
  let verified = false;
  let dispose: (() => void) | undefined;
  try {
    const provider = fauxProvider({
      models: [{ id: "faux-1", reasoning: true }],
    });
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("verify-review-boundary", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Done"),
    ]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: path.join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(provider.provider);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const model = provider.getModel();
    const modelId = `${model.provider}/${model.id}`;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          subagentExtension(pi);
          pi.on("tool_result", (event) => {
            if (event.toolName !== "subagent") {
              return;
            }
            const result = event.structuredContent;
            if (
              event.isError ||
              !isRecord(result) ||
              typeof result.agent !== "string" ||
              typeof result.runId !== "string" ||
              typeof result.resultPath !== "string"
            ) {
              return;
            }
            expect(event.parentToolCallId).toBeDefined();
            captures.push({
              agent: result.agent,
              runId: result.runId,
              resultPath: result.resultPath,
            });
          });
          pi.registerTool({
            name: "verify-review-boundary",
            label: "Review boundary",
            description: "Isolated review integration verification",
            parameters: Type.Object({}),
            async execute(_id, _args, signal, _update, ctx) {
              const prepared = await controller.prepare(
                ctx,
                { type: "folder", paths: ["target.txt"] },
                {
                  scopeHint: "target snapshot",
                  invocationPacket:
                    "Inspect target.txt. This is a boundary fixture, not a real defect report.",
                  reviewers: ["code-reviewer"],
                  reviewerPanel: [{ model: modelId, thinkingLevel: "medium" }],
                  synthesizerModel: modelId,
                  verifierModel: modelId,
                },
                signal,
              );
              await controller.run(prepared.id, ctx, signal);
              expect(published).toEqual([]);
              expect(captures.map((capture) => capture.agent)).toEqual(
                Object.keys(reports),
              );
              expect(
                new Set(captures.map((capture) => capture.runId)).size,
              ).toBe(3);
              for (const capture of captures) {
                const evidence: unknown = JSON.parse(
                  await readFile(capture.resultPath, "utf8"),
                );
                expect(isRecord(evidence) && evidence.structuredOutput).toEqual(
                  reports[capture.agent],
                );
                expect((await stat(capture.resultPath)).mode % 0o1000).toBe(
                  0o600,
                );
              }
              await controller.finalize(
                prepared.id,
                ctx,
                (result) => {
                  published.push(result);
                },
                signal,
              );
              expect(published).toHaveLength(1);
              expect(published[0]?.verifier.verdict).toBe("correct");
              expect(published[0]?.verifier.findings).toEqual([]);
              await rejects(
                controller.finalize(
                  prepared.id,
                  ctx,
                  () => {
                    throw new Error("Duplicate publication");
                  },
                  signal,
                ),
                /replayed/,
              );
              expect(await readdir(cwd)).toEqual(["target.txt"]);
              expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(
                "Offline boundary fixture.\n",
              );
              verified = true;
              return {
                content: [{ type: "text", text: "Review boundary verified." }],
                details: {},
              };
            },
          });
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    dispose = () => session.dispose();
    await session.bindExtensions({ mode: "print" });
    await session.prompt("Run the isolated review integration boundary.");
    if (!verified) {
      throw new Error(
        JSON.stringify(
          session.messages.filter((message) => message.role === "toolResult"),
        ),
      );
    }
  } finally {
    controller.cancel();
    await controller.settle();
    dispose?.();
    if (previousDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousDirectory;
    }
    if (previousOffline === undefined) {
      delete process.env.PI_OFFLINE;
    } else {
      process.env.PI_OFFLINE = previousOffline;
    }
  }
}, 60_000);
