// SupaPi additions: offline tests for the Apache-2.0 subagent adaptation; see extensions/subagent/NOTICE and LICENSE.upstream.
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getPackageDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isRecord } from "./agents";
import { resolveAttachTarget } from "./attach";
import subagentExtension from "./index";
import { runSubagent, type SubagentUpdate } from "./runner";

test("isolated offline actual tmux/Pi child boundary: fresh task, role system, validated report and cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "supa-subagent-offline-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  await mkdir(path.join(agentDir, "agents"), { recursive: true });
  await mkdir(cwd);
  const fakePath = path.join(agentDir, "fake-provider.ts");
  await writeFile(
    fakePath,
    `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { VERSION, getPackageDir } from '@earendil-works/pi-coding-agent';
export default function(pi) {
 const config = JSON.parse(readFileSync(process.env.SUPA_PI_SUBAGENT_CONFIG, 'utf8'));
 pi.on('session_start', () => writeFileSync(path.join(path.dirname(process.env.SUPA_PI_SUBAGENT_CONFIG), 'child-pid.json'), JSON.stringify({pid: process.pid, version: VERSION, packageDir: getPackageDir()}), {mode:0o600}));
 const fake = fauxProvider();
 fake.setResponses([
 async context => {
  const systems = JSON.stringify(context.messages.filter(m => m.role === 'system'));
  const users = JSON.stringify(context.messages.filter(m => m.role === 'user'));
  if ((config.agent && !systems.includes('SMOKE_ROLE_BODY')) || systems.includes('PARENT_CONVERSATION_SECRET') || !users.includes('CHILD_TASK_ONLY') || users.includes('SMOKE_ROLE_BODY')) throw new Error('Fresh task/system role boundary failed');
  const tools = context.messages.flatMap(m => m.role === 'system' ? m.toolsAdded ?? [] : []).map(t => t.name);
  if (config.agent && tools.join(',') !== 'StructuredOutput') throw new Error('tools:none not enforced');
  if (users.includes('EXIT_WITHOUT_REPORT')) return new Promise(() => setTimeout(() => process.exit(7), 1500));
  if (users.includes('CANCEL_WAIT')) return new Promise(resolve => setTimeout(() => resolve(fauxAssistantMessage('too late')), 60000));
  await new Promise(resolve => setTimeout(resolve, 1500));
  return fauxAssistantMessage('missing final report');
 },
 fauxAssistantMessage(fauxToolCall('StructuredOutput', { ok: true }), { stopReason: 'toolUse' }),
 fauxAssistantMessage('offline complete')
 ]);
 pi.registerProvider(fake.provider);
}`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [fakePath],
      quietStartup: true,
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(agentDir, "agents", "smoke.md"),
    `---\nname: smoke\ntools: none\nextensions: [${JSON.stringify(fakePath)}]\nskills: false\n---\nSMOKE_ROLE_BODY`,
    { mode: 0o600 },
  );
  const cli = path.join(
    path.dirname(
      fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    ),
    "bundle",
    "cli.js",
  );
  const wrapper = path.join(root, "attach-bin");
  await mkdir(wrapper);
  const realTmux = spawnSync("which", ["tmux"], {
    encoding: "utf8",
  }).stdout.trim();
  if (!realTmux) {
    throw new Error("Missing tmux");
  }
  const attachLog = path.join(root, "attached-target.json");
  await writeFile(
    path.join(wrapper, "tmux"),
    `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if(args.includes('attach-session')) { writeFileSync(${JSON.stringify(attachLog)}, JSON.stringify(args)); process.exit(23); }
const result = spawnSync(${JSON.stringify(realTmux)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`,
    { mode: 0o700 },
  );
  const invokeAttach = (runId: string) =>
    spawnSync(
      process.execPath,
      [
        cli,
        "--no-extensions",
        "--extension",
        fileURLToPath(new URL("./index.ts", import.meta.url)),
        "--no-skills",
        "--no-context-files",
        "--no-session",
        "--no-approve",
        "--attach-subagent",
        runId,
      ],
      {
        cwd,
        env: {
          ...process.env,
          SUPA_PI_SUBAGENT_CONFIG: undefined,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PATH: `${wrapper}:${process.env.PATH}`,
          TMUX: undefined,
          TMUX_PANE: undefined,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldOffline = process.env.PI_OFFLINE;
  const oldSubagentConfig = process.env.SUPA_PI_SUBAGENT_CONFIG;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  // This fixture is a parent even when the test runner was launched by a reviewer child.
  delete process.env.SUPA_PI_SUBAGENT_CONFIG;
  const provider = fauxProvider();
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("native-delegate", {}), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("parent complete"),
  ]);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(provider.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  let captured!: { pi: ExtensionAPI; ctx: ExtensionContext };
  let nativeSucceeded = false;
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
        pi.registerTool({
          name: "native-delegate",
          label: "Native delegate",
          description: "Native success boundary",
          parameters: Type.Object({}),
          async execute(_id, _args, _signal, _update, ctx) {
            const outcome = await ctx.executeTool("subagent", {
              task: "CHILD_TASK_ONLY",
              agent: "smoke",
              thinking: "off",
              schema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
              },
            });
            expect(outcome.isError).toBe(false);
            const content = outcome.result.structuredContent;
            if (!isRecord(content)) {
              throw new Error("Missing native structuredContent");
            }
            expect(content.structuredOutput).toEqual({ ok: true });
            expect(typeof content.resultPath).toBe("string");
            nativeSucceeded = true;
            return outcome.result;
          },
        });
        pi.on("session_start", (_event, ctx) => {
          captured = { pi, ctx };
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: provider.getModel(),
    modelRuntime: runtime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd, { id: randomUUID() }),
  });
  try {
    await session.bindExtensions({ mode: "print" });
    session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "PARENT_CONVERSATION_SECRET" }],
      timestamp: Date.now(),
    });
    for (const agent of ["smoke", undefined]) {
      const updates: SubagentUpdate[] = [];
      const sockets = new Set<string>();
      let attached = false;
      const result = await runSubagent(
        captured.pi,
        captured.ctx,
        {
          task: "CHILD_TASK_ONLY",
          agent,
          thinking: "off",
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
        {
          onUpdate: (update) => {
            updates.push(update);
            if (!update.attachCommand) {
              return;
            }
            expect(update.attachCommand).toBe(
              `pi --attach-subagent ${update.runId}`,
            );
            const target = resolveAttachTarget(update.runId);
            sockets.add(target.socket);
            if (!attached) {
              const attachment = invokeAttach(update.runId);
              expect(attachment.status, attachment.stderr).toBe(23);
              expect(JSON.parse(readFileSync(attachLog, "utf8"))).toEqual([
                "-S",
                target.socket,
                "attach-session",
                "-t",
                target.session,
              ]);
              attached = true;
            }
          },
          signal: AbortSignal.timeout(25_000),
        },
      );
      expect(result.structuredOutput).toEqual({ ok: true });
      expect(result.agent).toEqual(agent);
      expect(result.sessionFile).toBeDefined();
      expect((await stat(result.resultPath)).mode % 512).toBe(0o600);
      const childRuntime = JSON.parse(
        await readFile(
          path.join(path.dirname(result.resultPath), "child-pid.json"),
          "utf8",
        ),
      );
      expect(childRuntime.version).toBe(VERSION);
      expect(childRuntime.packageDir).toBe(getPackageDir());
      const launcher = await readFile(
        path.join(path.dirname(result.resultPath), "launch.sh"),
        "utf8",
      );
      expect(launcher).toContain(
        agent === undefined
          ? path.join(getPackageDir(), "dist", "bundle", "cli.js")
          : `'${getPackageDir()}'`,
      );
      if (!result.sessionFile) {
        throw new Error("Missing child session");
      }
      expect((await stat(result.sessionFile)).mode % 512).toBe(0o600);
      const evidence = await readFile(result.sessionFile, "utf8");
      expect(evidence).toContain("subagent-report-correction");
      expect(evidence).not.toContain("PARENT_CONVERSATION_SECRET");
      expect(updates.some((update) => update.attachCommand)).toBe(true);
      expect(attached).toBe(true);
      expect(sockets.size).toBe(1);
      for (const socket of sockets) {
        const check = await captured.pi.exec("tmux", [
          "-S",
          socket,
          "list-sessions",
        ]);
        expect(check.code).not.toBe(0);
        expect(existsSync(path.dirname(socket))).toBe(false);
      }
      const finished = invokeAttach(result.runId);
      expect(finished.status).toBe(1);
      expect(finished.stderr).toContain("finished");
    }
    await session.prompt("Run the native delegate boundary.");
    expect(nativeSucceeded).toBe(true);
    const parentEvidence = path.join(
      agentDir,
      "subagents",
      createHash("sha256")
        .update(captured.ctx.sessionManager.getSessionId())
        .digest("hex")
        .slice(0, 24),
    );
    const exitUpdates: SubagentUpdate[] = [];
    let exitSocket: string | undefined;
    const exitSignal = AbortSignal.timeout(8000);
    await rejects(
      runSubagent(
        captured.pi,
        captured.ctx,
        { task: "CHILD_TASK_ONLY EXIT_WITHOUT_REPORT", thinking: "off" },
        {
          signal: exitSignal,
          onUpdate: (update) => {
            exitUpdates.push(update);
            if (update.attachCommand) {
              exitSocket = resolveAttachTarget(update.runId).socket;
            }
          },
        },
      ),
      /Child exited without reporting/,
    );
    expect(exitSignal.aborted).toBe(false);
    const exited = exitUpdates.at(-1);
    if (!exited?.attachCommand) {
      throw new Error("Missing exited child update");
    }
    const exitEvidence = path.join(parentEvidence, exited.runId);
    expect(
      JSON.parse(await readFile(path.join(exitEvidence, "ready.json"), "utf8")),
    ).toEqual({ runId: exited.runId });
    const failure: unknown = JSON.parse(
      await readFile(path.join(exitEvidence, "failure.json"), "utf8"),
    );
    if (!isRecord(failure)) {
      throw new Error("Missing failure evidence");
    }
    expect(failure.aborted).toBe(false);
    if (!exitSocket) {
      throw new Error("Missing exited child socket");
    }
    expect(existsSync(path.dirname(exitSocket))).toBe(false);
    const controller = new AbortController();
    let childPid: number | undefined;
    let cancelledSocket: string | undefined;
    const cancelled = runSubagent(
      captured.pi,
      captured.ctx,
      {
        task: "CHILD_TASK_ONLY CANCEL_WAIT",
        agent: "smoke",
        thinking: "off",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
      {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15_000),
        ]),
        onUpdate: (update) => {
          if (update.attachCommand) {
            cancelledSocket = resolveAttachTarget(update.runId).socket;
          }
          const file = path.join(
            parentEvidence,
            update.runId,
            "child-pid.json",
          );
          if (existsSync(file)) {
            const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
            if (!isRecord(raw) || typeof raw.pid !== "number") {
              throw new Error("Invalid child pid evidence");
            }
            childPid = raw.pid;
            controller.abort();
          }
        },
      },
    );
    await rejects(cancelled, /aborted/);
    expect(childPid).toBeDefined();
    if (!childPid) {
      throw new Error("Child did not start before cancellation");
    }
    const pid = childPid;
    expect(() => process.kill(pid, 0)).toThrow();
    if (!cancelledSocket) {
      throw new Error("Missing cancelled socket");
    }
    expect(existsSync(path.dirname(cancelledSocket))).toBe(false);
  } finally {
    session.dispose();
    if (oldSubagentConfig === undefined) {
      delete process.env.SUPA_PI_SUBAGENT_CONFIG;
    } else {
      process.env.SUPA_PI_SUBAGENT_CONFIG = oldSubagentConfig;
    }
    if (oldDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldDir;
    }
    if (oldOffline === undefined) {
      delete process.env.PI_OFFLINE;
    } else {
      process.env.PI_OFFLINE = oldOffline;
    }
  }
}, 60_000);
