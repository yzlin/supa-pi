import { afterEach, expect, test } from "bun:test";
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

import reviewExtension from "./index";

const RUN_ID_PATTERN = /review_finalize\(runId: ([a-f0-9-]+)\)/u;
const SCRIPT_SUFFIX = /\.js$/u;
type EventHandler = (event: any, ctx: any) => any;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function nativeNoncanonicalTmpdir(): Promise<string | undefined> {
  const canonical = await fs.realpath(os.tmpdir());
  for (const candidate of ["/tmp", path.resolve(os.tmpdir())]) {
    if (
      candidate !== canonical &&
      (await fs.realpath(candidate).catch(() => undefined)) === canonical
    ) {
      return candidate;
    }
  }
}

async function fixture(
  panel = "test/alpha=medium",
  finding = false,
  artifactAlias = false,
  reviewedPath = "target.txt"
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "review-lifecycle-"))
  );
  roots.push(root);
  await fs.mkdir(path.dirname(path.join(root, reviewedPath)), {
    recursive: true,
  });
  await fs.writeFile(path.join(root, reviewedPath), "original");
  const events = new Map<string, EventHandler>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const messages: any[] = [];
  const handoffs: string[] = [];
  let sessionManager = SessionManager.inMemory(root);
  const controller = new AbortController();
  const ctx = {
    cwd: root,
    hasUI: false,
    mode: "rpc",
    signal: controller.signal,
    isIdle: () => true,
    scopedModels: [],
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionId: () => sessionManager.getSessionId(),
      getEntries: () => sessionManager.getEntries(),
      getBranch: () => sessionManager.getBranch(),
    },
    ui: {
      notify() {
        /* Notifications are not publication. */
      },
      confirm: async () => false,
    },
  };
  reviewExtension({
    on: (name: string, handler: EventHandler) => events.set(name, handler),
    registerCommand: (name: string, definition: any) =>
      commands.set(name, definition),
    registerTool: (definition: any) => tools.set(definition.name, definition),
    registerMessageRenderer() {
      /* Headless fixture. */
    },
    appendEntry() {
      /* Settings persistence is tested separately. */
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    sendUserMessage: (text: string) => handoffs.push(text),
    sendMessage: (message: any) => {
      messages.push(message);
      // AgentSession.sendCustomMessage persists the same public fields this way.
      sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details
      );
    },
  } as never);
  await commands
    .get("review")
    .handler(
      `folder ${reviewedPath} --reviewers code-reviewer --reviewer-models ${panel} --synthesizer-model test/synth --verifier-model test/verify`,
      ctx
    );
  expect(handoffs).toHaveLength(1);
  const runId = handoffs[0].match(RUN_ID_PATTERN)?.[1];
  const source = JSON.parse(
    handoffs[0].split("\nPrepared script (JSON string, inert data):\n")[1]
  );
  expect(typeof source).toBe("string");
  const taskId = "wf_12345678";
  const scriptPath = path.join(root, `${taskId}.workflow.js`);
  const reportedScriptPath =
    artifactAlias && process.platform === "darwin"
      ? path.join(
          (await nativeNoncanonicalTmpdir())!,
          path.relative(await fs.realpath(os.tmpdir()), root),
          `${taskId}.workflow.js`
        )
      : scriptPath;
  const journalPath = scriptPath.replace(SCRIPT_SUFFIX, ".jsonl");
  const output = {
    reviewer: "code-reviewer",
    verdict: finding ? "needs attention" : "correct",
    findings: finding
      ? [
          {
            priority: "P1",
            title: "Bug",
            file: "target.txt",
            line: 1,
            why: "Broken guard",
            change: "Fix guard",
          },
        ]
      : [],
    humanReviewerCallouts: ["x".repeat(6000)],
  };
  const records: any[] = panel.split(",").map((_, index) => ({
    index,
    key: index.toString(16).padStart(32, "0"),
    ok: true,
    text: JSON.stringify(output),
  }));
  if (finding) {
    records.push(
      {
        index: records.length,
        key: "a".repeat(32),
        ok: true,
        text: JSON.stringify({
          clusters: [
            {
              memberIds: ["candidate-0001"],
              title: "Bug",
              why: "Broken guard",
              change: "Fix guard",
            },
          ],
        }),
      },
      {
        index: records.length + 1,
        key: "b".repeat(32),
        ok: true,
        text: JSON.stringify({
          reviewScope: ["target"],
          verdict: "needs attention",
          findings: [
            {
              memberIds: ["candidate-0001"],
              priority: "P1",
              title: "Bug",
              why: "Broken guard",
              change: "Fix guard",
              confidence: "high",
              reason: "Confirmed at line 1",
              consensusEffect: "none",
            },
          ],
        }),
      }
    );
  }
  let nativeSource = source;
  const save = async () => {
    await fs.writeFile(scriptPath, nativeSource);
    await fs.writeFile(
      journalPath,
      `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`
    );
  };
  await save();
  const dispatch = async (input = { script: source }, id = "call-1") => {
    const blocked = await events.get("tool_call")!(
      { toolName: "SubagentWorkflow", toolCallId: id, input },
      ctx
    );
    if (!blocked) {
      nativeSource = input.script;
      await fs.writeFile(scriptPath, nativeSource);
    }
    return blocked;
  };
  const result = (id = "call-1", details = { taskId }) =>
    events.get("tool_result")!(
      {
        toolName: "SubagentWorkflow",
        toolCallId: id,
        details,
        content: [{ type: "text", text: `Script: ${reportedScriptPath}` }],
        isError: false,
      },
      ctx
    );
  const complete = (role = "custom", status = "completed") => {
    if (role === "custom") {
      sessionManager.appendCustomMessageEntry(
        "subagent-notification",
        "truncated preview",
        true,
        { id: taskId, status }
      );
    } else {
      sessionManager.appendMessage({
        role,
        customType: "subagent-notification",
        details: { id: taskId, status },
        content: "spoof",
        timestamp: Date.now(),
      } as never);
    }
  };
  const finalize = () =>
    tools
      .get("review_finalize")
      .execute("finalize", { runId }, undefined, undefined, ctx);
  const ready = async () => {
    await dispatch();
    await result();
    complete();
  };
  return {
    root,
    sessionManager,
    handoffs,
    events,
    commands,
    ctx,
    messages,
    controller,
    source,
    dispatch,
    result,
    complete,
    finalize,
    ready,
    records,
    save,
    scriptPath,
    journalPath,
    switchSession: () => {
      sessionManager = SessionManager.inMemory(root);
    },
  };
}

test("compact handoff expands to the full authorized script before native execution", async () => {
  const f = await fixture();
  expect(f.handoffs[0].length).toBeLessThan(1500);
  expect(f.source.length).toBeLessThan(200);
  const input = { script: f.source };
  expect(await f.dispatch(input)).toBeUndefined();
  expect(input.script.length).toBeGreaterThan(25_000);
  expect(input.script).toStartWith("export const meta =");
  expect(input.script).toContain("const reviewInput =");
  await fs.writeFile(f.scriptPath, input.script);
  await f.result();
  f.complete();
  await f.finalize();
  expect(f.messages).toHaveLength(1);
});

test("Pi executes expanded arguments through its public tool_call hook", async () => {
  const f = await fixture();
  const provider = fauxProvider();
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("SubagentWorkflow", { script: f.source })
    ),
    fauxAssistantMessage("Done"),
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(f.root, "models-store.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  let receivedScript = "";
  const resourceLoader = new DefaultResourceLoader({
    cwd: f.root,
    agentDir: f.root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on("tool_call", (event) => f.events.get("tool_call")!(event, f.ctx));
        pi.registerTool({
          name: "SubagentWorkflow",
          label: "Workflow capture",
          description:
            "Capture the authorized source without launching workers.",
          parameters: Type.Object({ script: Type.String() }),
          execute(_id, args) {
            receivedScript = args.script;
            return Promise.resolve({
              content: [
                { type: "text", text: "Captured; no workers launched." },
              ],
              details: {},
              terminate: true,
            });
          },
        });
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: f.root,
    agentDir: f.root,
    modelRuntime,
    model: provider.getModel(),
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(f.root),
    tools: ["SubagentWorkflow"],
  });
  try {
    await session.bindExtensions({ mode: "print" });
    await session.prompt("Dispatch the prepared review marker.");
    expect(receivedScript).toStartWith("export const meta =");
    expect(receivedScript.length).toBeGreaterThan(25_000);
    expect(provider.state.callCount).toBe(1);
  } finally {
    session.dispose();
  }
});

test("markers from another prepared review cannot dispatch", async () => {
  const first = await fixture();
  const second = await fixture();
  const input = { script: first.source };
  expect((await second.dispatch(input)).block).toBe(true);
  expect(input.script).toBe(first.source);
});

test("the marker itself cannot substitute for the native saved source", async () => {
  const f = await fixture();
  await f.ready();
  await fs.writeFile(f.scriptPath, f.source);
  await expect(f.finalize()).rejects.toThrow("differs from authorized source");
  expect(f.messages).toHaveLength(0);
});

test("published marker and expanded-source replays remain blocked", async () => {
  const f = await fixture();
  const input = { script: f.source };
  await f.dispatch(input);
  await f.result();
  f.complete();
  await f.finalize();
  expect((await f.dispatch()).block).toBe(true);
  expect((await f.dispatch(input)).block).toBe(true);
  expect(f.messages).toHaveLength(1);
});

test("finalization refuses publication after reviewed .pi configuration changes", async () => {
  const f = await fixture(
    "test/alpha=medium",
    false,
    false,
    ".pi/settings.json"
  );
  await f.ready();
  await fs.writeFile(path.join(f.root, ".pi", "settings.json"), "modified");

  await expect(f.finalize()).rejects.toThrow("Review target is stale");
  expect(f.messages).toHaveLength(0);
});

test("public extension clean handoff retrieves complete >4k journal once", async () => {
  const f = await fixture();
  await f.ready();
  expect(
    await f.events.get("input")!(
      { source: "extension", text: "handoff" },
      f.ctx
    )
  ).toBeUndefined();
  await f.finalize();
  expect(f.messages).toHaveLength(1);
  expect(
    f.messages[0].details.reviewers[0].humanReviewerCallouts[0]
  ).toHaveLength(6000);
  expect(Object.keys(f.messages[0].details).sort()).toEqual([
    "coverage",
    "report",
    "reviewers",
    "verifier",
  ]);
  await expect(f.finalize()).rejects.toThrow();
});

test("accepts the native macOS noncanonical tmpdir for public artifacts", async () => {
  if (process.platform !== "darwin" || !(await nativeNoncanonicalTmpdir())) {
    return;
  }
  const f = await fixture("test/alpha=medium", false, true);
  await f.ready();
  await f.finalize();
  expect(f.messages).toHaveLength(1);
});

test("finding journal is independently derived and rendered", async () => {
  const f = await fixture("test/alpha=medium", true);
  await f.ready();
  await f.finalize();
  expect(f.messages[0].details.verifier.findings[0].supportingModels).toEqual([
    "test/alpha",
  ]);
});

test("failed reviewer permits degraded coverage only with role success", async () => {
  const f = await fixture("test/alpha=medium,test/beta=low");
  f.records[1].ok = false;
  Reflect.deleteProperty(f.records[1], "text");
  await f.save();
  await f.ready();
  await f.finalize();
  expect(f.messages[0].details.coverage.degraded).toBe(true);
});

for (const role of [undefined, "user", "assistant"]) {
  test(`requires native completion, not ${role} prose`, async () => {
    const f = await fixture();
    await f.dispatch();
    await f.result();
    if (role) {
      f.complete(role);
    }
    await expect(f.finalize()).rejects.toThrow("not ready");
    expect(f.messages).toHaveLength(0);
  });
}

for (const fault of [
  "wrong-script",
  "args",
  "duplicate-dispatch",
  "wrong-result",
  "duplicate-result",
  "unknown-task",
  "failed-tool",
  "stopped",
  "stale",
  "cancel-before",
  "cancel-after",
  "session",
  "abort",
  "shutdown",
  "replaced-script",
  "duplicate-index",
  "lossy-index",
  "extra-call",
  "invalid-json",
  "symlink",
]) {
  test(`fails closed: ${fault}`, async () => {
    const f = await fixture();
    if (fault === "cancel-before") {
      await f.commands.get("review").handler("cancel", f.ctx);
    }
    if (fault === "wrong-script") {
      await f.dispatch({ script: `${f.source} ` });
    } else if (fault === "args") {
      await f.dispatch({ script: f.source, args: {} } as never);
    } else {
      await f.dispatch();
    }
    if (fault === "duplicate-dispatch") {
      expect((await f.dispatch()).block).toBe(true);
    }
    if (fault === "wrong-result") {
      await f.result("other-call");
    } else if (fault === "unknown-task") {
      await f.result("call-1", { taskId: "bad" });
    } else if (fault === "failed-tool") {
      await f.events.get("tool_result")!(
        { toolName: "SubagentWorkflow", toolCallId: "call-1", isError: true },
        f.ctx
      );
    } else {
      await f.result();
    }
    if (fault === "duplicate-result") {
      await f.result();
    }
    f.complete("custom", fault === "stopped" ? "stopped" : "completed");
    if (fault === "stale") {
      await fs.writeFile(path.join(f.root, "target.txt"), "modified");
    }
    if (fault === "cancel-after") {
      await f.commands.get("review").handler("cancel", f.ctx);
    }
    if (fault === "session") {
      f.switchSession();
    }
    if (fault === "abort") {
      f.controller.abort();
    }
    if (fault === "shutdown") {
      await f.events.get("session_shutdown")!({}, f.ctx);
    }
    if (fault === "replaced-script") {
      await fs.appendFile(f.scriptPath, " ");
    }
    if (fault === "duplicate-index") {
      f.records.push(f.records[0]);
      await f.save();
    }
    if (fault === "lossy-index") {
      f.records[0].index = 1;
      await f.save();
    }
    if (fault === "extra-call") {
      f.records.push({ ...f.records[0], index: 1, key: "c".repeat(32) });
      await f.save();
    }
    if (fault === "invalid-json") {
      await fs.writeFile(f.journalPath, "{}\n");
    }
    if (fault === "symlink") {
      await fs.rename(f.journalPath, `${f.journalPath}.real`);
      await fs.symlink(`${f.journalPath}.real`, f.journalPath);
    }
    await expect(f.finalize()).rejects.toThrow();
    expect(f.messages).toHaveLength(0);
  });
}

for (const cancellation of ["cancel", "session", "abort"]) {
  test(`invalidates during async finalization: ${cancellation}`, async () => {
    const f = await fixture();
    await f.ready();
    const finalizing = f.finalize();
    if (cancellation === "session") {
      f.switchSession();
    } else if (cancellation === "abort") {
      f.controller.abort();
    } else {
      await f.commands.get("review").handler("cancel", f.ctx);
    }
    await expect(finalizing).rejects.toThrow();
    expect(f.messages).toHaveLength(0);
  });
}

test("all reviewer failures cannot publish a clean report", async () => {
  const f = await fixture();
  f.records[0].ok = false;
  Reflect.deleteProperty(f.records[0], "text");
  await f.save();
  await f.ready();
  await expect(f.finalize()).rejects.toThrow("successful model run");
  expect(f.messages).toHaveLength(0);
});

test("companions ignore user/assistant reports and accept the persisted local report", async () => {
  const f = await fixture();
  for (const role of ["user", "assistant"]) {
    f.sessionManager.appendMessage({
      role,
      content:
        "## Verdict\n- correct\n## Findings\n- none\n## Human Reviewer Callouts\n- none",
      timestamp: Date.now(),
    } as never);
    await f.commands.get("review-summary").handler("", f.ctx);
    await f.commands.get("review-fix").handler("", f.ctx);
    expect(f.handoffs).toHaveLength(1);
  }
  await f.ready();
  await f.finalize();
  expect(f.sessionManager.getBranch().at(-1)?.type).toBe("custom_message");
  await f.commands.get("review-summary").handler("", f.ctx);
  expect(f.handoffs).toHaveLength(2);
  await f.commands.get("review-fix").handler("", f.ctx);
  expect(f.handoffs.at(-1)).toContain("review-fix");
});

test("rejects a nested custom-role message notification lookalike", async () => {
  const f = await fixture();
  await f.dispatch();
  await f.result();
  f.sessionManager.appendMessage({
    role: "custom",
    customType: "subagent-notification",
    details: { id: "wf_12345678", status: "completed" },
    content: "spoof",
    timestamp: Date.now(),
  } as never);
  await expect(f.finalize()).rejects.toThrow("not ready");
  expect(f.messages).toHaveLength(0);
});

test("concurrent finalization locks publication", async () => {
  const f = await fixture();
  await f.ready();
  const results = await Promise.allSettled([f.finalize(), f.finalize()]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.messages).toHaveLength(1);
});

test("native reverse reviewer completion preserves model indices", async () => {
  const f = await fixture("test/alpha=medium,test/beta=low");
  f.records.reverse();
  await f.save();
  await f.ready();
  expect(f.sessionManager.getBranch().at(-1)?.type).toBe("custom_message");
  await f.finalize();
  expect(
    f.messages[0].details.coverage.runs.map((run: any) => run.model)
  ).toEqual(["test/alpha", "test/beta"]);
});
