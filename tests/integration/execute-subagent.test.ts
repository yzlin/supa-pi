import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import { Value } from "typebox/value";

import { LEDGER_ENTRY_TYPE } from "../../extensions/execute/ledger";
import { registerExecutionLedger } from "../../extensions/execute/runtime";
import {
  type Checkpoint,
  CheckpointOutputSchema,
  LedgerSchema,
  type WorkerReport,
  WorkerReportSchema,
} from "../../extensions/execute/schema";
import { isRecord } from "../../extensions/subagent/agents";
import subagentExtension from "../../extensions/subagent/index";

// This is additional boundary verification, not a model-behavior or live-provider evaluation.
test("native execution ledger binds an actual offline tmux child and awaits main verification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "supa-execute-native-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  await mkdir(path.join(agentDir, "agents"), { recursive: true });
  await mkdir(cwd);
  const report: WorkerReport = {
    status: "done",
    summary: "Inspected the empty workspace without edits.",
    filesTouched: [],
    validation: ["No modifications were requested."],
    followUps: [],
    blockers: [],
  };
  const fakePath = path.join(agentDir, "fake-provider.ts");
  await writeFile(
    fakePath,
    `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function(pi) {
  const provider = fauxProvider();
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('StructuredOutput', ${JSON.stringify(report)}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('offline complete')
  ]);
  pi.registerProvider(provider.provider);
}`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(agentDir, "agents", "executor.md"),
    `---\nname: executor\ntools: none\nskills: false\nextensions: [${JSON.stringify(fakePath)}]\n---\nInspect only the assigned empty workspace. Do not modify files.`,
    { mode: 0o600 },
  );
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  const provider = fauxProvider();
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("verify-execution-boundary", {}), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("parent complete"),
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
  });
  let verified = false;
  const sessionManager = SessionManager.inMemory(cwd, { id: randomUUID() });
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
        const authorize = registerExecutionLedger(pi);
        pi.registerTool({
          name: "verify-execution-boundary",
          label: "Verify execution boundary",
          description: "Offline test of native ledger and child integration",
          parameters: Type.Object({}),
          async execute(_id, _args, signal, _update, ctx) {
            // The command calls this same authorization owner; command packet behavior has separate regression tests.
            const invocationId = authorize(ctx);
            const checkpoint = async (input: Checkpoint) => {
              const outcome = await ctx.executeTool(
                "execute_checkpoint",
                input,
                { signal },
              );
              if (outcome.isError) {
                throw new Error(JSON.stringify(outcome.result.content));
              }
              const data = outcome.result.structuredContent;
              if (!Value.Check(CheckpointOutputSchema, data)) {
                throw new Error("Missing native checkpoint output");
              }
              return data;
            };
            await checkpoint({
              invocationId,
              action: "accept",
              plan: "Inspect an empty isolated target; no edits or external actions.",
              approval:
                "Offline test authorizes only a non-mutating fixture task.",
              assignments: [
                {
                  id: "inspect",
                  task: "Inspect this empty workspace. Do not modify files.",
                  scope: ["src"],
                  dependencies: [],
                },
              ],
            });
            const started = await checkpoint({
              invocationId,
              action: "start",
              assignmentId: "inspect",
            });
            const attemptId = started.ledger.assignments[0]?.attemptId;
            if (!attemptId || !started.dispatchPrefix) {
              throw new Error("Missing dispatch identity");
            }
            const child = await ctx.executeTool(
              "subagent",
              {
                agent: "executor",
                task: `${started.dispatchPrefix}\nInspect this empty workspace. Do not modify files.`,
                thinking: "off",
                schema: JSON.parse(JSON.stringify(WorkerReportSchema)),
              },
              { signal },
            );
            if (child.isError) {
              throw new Error(JSON.stringify(child.result.content));
            }
            const childData = child.result.structuredContent;
            if (
              !isRecord(childData) ||
              typeof childData.runId !== "string" ||
              typeof childData.resultPath !== "string"
            ) {
              throw new Error("Missing real child evidence");
            }
            const observed = await checkpoint({
              invocationId,
              action: "inspect",
            });
            const assignment = observed.ledger.assignments[0];
            expect(assignment?.status).toBe("running");
            expect(assignment?.report).toEqual(report);
            expect(assignment?.runId).toBe(childData.runId);
            expect(assignment?.toolCallId).toContain(`${_id}/`);
            const evidence: unknown = JSON.parse(
              await readFile(childData.resultPath, "utf8"),
            );
            expect(isRecord(evidence) && evidence.structuredOutput).toEqual(
              report,
            );
            expect(await readdir(cwd)).toEqual([]);
            const complete = await checkpoint({
              invocationId,
              action: "verify",
              assignmentId: "inspect",
              attemptId,
              passed: true,
              evidence: [
                "Main read the real child result and independently confirmed the workspace remained empty.",
              ],
              blockers: [],
            });
            expect(complete.ledger.assignments[0]?.status).toBe("completed");
            const entries = sessionManager
              .getBranch()
              .filter(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === LEDGER_ENTRY_TYPE,
              );
            const last = entries.at(-1);
            if (
              !last ||
              last.type !== "custom" ||
              !Value.Check(LedgerSchema, last.data)
            ) {
              throw new Error("Missing native session ledger entry");
            }
            expect(last.data.assignments[0]?.status).toBe("completed");
            verified = true;
            return {
              content: [{ type: "text", text: "Execution boundary verified." }],
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
      cwd,
      agentDir,
      model: provider.getModel(),
      modelRuntime,
      settingsManager,
      resourceLoader: loader,
      sessionManager,
    });
    dispose = () => session.dispose();
    await session.bindExtensions({ mode: "print" });
    await session.prompt("Run the isolated execution boundary test.");
    expect(verified).toBe(true);
  } finally {
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
}, 45_000);
