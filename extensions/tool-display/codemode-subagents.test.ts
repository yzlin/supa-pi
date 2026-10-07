import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import toolDisplayExtension from "./index";
import { cleanupToolDisplayTimers } from "./presentation";

test("native codemode events redraw real TUI subagent previews before child completion", async () => {
  initTheme("dark", false);
  const root = await mkdtemp(join(tmpdir(), "codemode-subagent-preview-"));
  const provider = fauxProvider();
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: "await tools.subagent({task: 'Inspect'});",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  let component: ToolExecutionComponent | undefined;
  let redraws = 0;
  const rendered = (width = 100) =>
    component?.render(width).map(stripVTControlCharacters).join("\n") ?? "";
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    extensionFactories: [
      createCodemodeExtension(),
      toolDisplayExtension,
      (pi) => {
        pi.registerTool({
          name: "subagent",
          label: "Fixture child",
          description: "Emit offline preview",
          parameters: Type.Object({ task: Type.String() }),
          async execute(_id, _args, _signal, onUpdate) {
            for (const [status, text] of [
              ["queued", "waiting for slot"],
              [
                "running",
                `old line\nlatest\u001b]52;c;SGVsbG8=\u0007 preview ${"x".repeat(2000)}`,
              ],
            ] as const) {
              onUpdate?.({
                content: [],
                details: {
                  status,
                  runId: "fixture-run",
                  attachCommand: "pi --attach-subagent fixture-run",
                  text,
                },
              });
              await sleep(0);
              expect(rendered()).toContain(`subagent ${status}: fixture-run`);
              expect(rendered()).toContain("pi --attach-subagent fixture-run");
              expect(rendered()).not.toContain("SGVsbG8=");
              expect(rendered()).not.toContain("\u0007");
            }
            expect(redraws).toBeGreaterThan(0);
            for (const width of [24, 60, 100]) {
              const rows = component?.render(width).slice(1) ?? [];
              expect(rows.map((line) => visibleWidth(line))).toEqual(
                rows.map(() => width),
              );
              expect(rows.length).toBeLessThan(30);
            }
            return {
              content: [{ type: "text", text: "child finished" }],
              details: undefined,
            };
          },
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
  await session.bindExtensions({ mode: "print", shutdownHandler() {} });
  session.setActiveToolsByName(["codemode", "subagent"]);
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "tool_execution_start" &&
      event.toolName === "codemode"
    ) {
      component = new ToolExecutionComponent(
        "codemode",
        event.toolCallId,
        event.args,
        {},
        session.extensionRunner.resolveToolRenderers(
          "codemode",
          () => undefined,
        ),
        {
          requestRender() {
            redraws += 1;
          },
        } as never,
        root,
      );
    }
    if (
      event.type === "tool_execution_update" &&
      event.toolName === "codemode"
    ) {
      component?.updateResult({ ...event.partialResult, isError: false }, true);
    }
    if (event.type === "tool_execution_end" && event.toolName === "codemode") {
      component?.updateResult(
        { ...event.result, isError: event.isError },
        false,
      );
    }
  });
  try {
    await session.prompt("Run the fixture.");
    expect(rendered()).not.toContain("subagent running: fixture-run");
    expect(rendered()).not.toContain("pi --attach-subagent fixture-run");
    const result = session.messages.findLast(
      (message) => message.role === "toolResult",
    );
    expect(result).toMatchObject({ role: "toolResult", isError: false });
  } finally {
    unsubscribe();
    session.dispose();
    cleanupToolDisplayTimers();
  }
});
