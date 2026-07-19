import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Markdown } from "@earendil-works/pi-tui";

import {
  approveProjectReviewConfig,
  getGlobalReviewConfigPath,
  getProjectReviewConfigPath,
  getReviewTrustPath,
  isProjectReviewConfigApproved,
  resolveReviewConfig,
  writeReviewConfigField,
} from "./config";
import reviewExtension from "./index";
import {
  assertVerifierModelPolicy,
  DEFAULT_REVIEWER_PANEL,
  DEFAULT_SYNTHESIZER_MODEL,
  DEFAULT_VERIFIER_MODEL,
  REVIEW_REPORT_MESSAGE_TYPE,
  REVIEW_WORKFLOW_CONCURRENCY,
  type ReviewerAgent,
  type ReviewPanelEntry,
  type ReviewWorkflowProgressUpdate,
  renderReviewReport,
  runReviewWorkflow,
  type VerifierJsonContract,
} from "./workflow";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
  content?: string;
  details?: unknown;
  message?: { role: string; content: string };
}

const TEST_PANEL: ReviewPanelEntry[] = [
  { model: "test/alpha", thinkingLevel: "low" },
  { model: "test/beta", thinkingLevel: "xhigh" },
];
const TEST_SYNTHESIZER = "test/synth";
const TEST_VERIFIER = "test/verify";
const MODEL_CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}]/u;
let testRoot = "";
let testProjectCwd = "";
let originalHome: string | undefined;

beforeAll(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "supa-pi-review-tests-"));
  testProjectCwd = path.join(testRoot, "project");
  await fs.mkdir(path.join(testProjectCwd, ".pi"), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = path.join(testRoot, "home");
});

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await fs.rm(testRoot, { recursive: true, force: true });
});

function createCtx(
  entries: SessionEntry[] = [],
  available: (model: string) => boolean = () => true
) {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  return {
    notifications,
    statuses,
    widgets,
    ctx: {
      cwd: testProjectCwd,
      hasUI: true,
      mode: "rpc",
      isIdle: () => true,
      signal: undefined,
      modelRegistry: {
        find(provider: string, id: string) {
          return available(`${provider}/${id}`) ? { provider, id } : undefined;
        },
        hasConfiguredAuth() {
          return true;
        },
      },
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => entries,
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        setStatus(key: string, text: string | undefined) {
          statuses.push({ key, text });
        },
        setWidget(key: string, content: string[] | undefined) {
          widgets.push({ key, content });
        },
        onTerminalInput: () => () => undefined,
        select: async () => null,
        editor: async () => null,
        custom: async () => null,
        confirm: async (_title: string, _message: string) => false,
      },
    },
  };
}

interface AgentCall {
  type: string;
  prompt: string;
  options: Record<string, unknown>;
  model?: string;
  thinking?: string;
}

type AgentReply =
  | unknown
  | { output?: unknown; status?: string; error?: string };

function captureStructuredOutput(
  options: Record<string, unknown>,
  value: unknown
) {
  if (value === undefined) {
    return;
  }
  const tools = options.customTools as
    | Array<{ name: string; execute: (id: string, value: unknown) => unknown }>
    | undefined;
  tools
    ?.find((tool) => tool.name === "structured_output")
    ?.execute("test", value);
}

function installManager(
  reply: (call: AgentCall, index: number) => AgentReply = defaultReply
) {
  const calls: AgentCall[] = [];
  const records = new Map<string, Record<string, unknown>>();
  let index = 0;
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("pi-subagents:manager")
  ] = {
    spawn(
      _pi: unknown,
      _ctx: unknown,
      type: string,
      prompt: string,
      options: Record<string, unknown>
    ) {
      const resolved = options.model as
        | { provider?: string; id?: string }
        | undefined;
      const call: AgentCall = {
        type,
        prompt,
        options,
        model: resolved ? `${resolved.provider}/${resolved.id}` : undefined,
        thinking: options.thinkingLevel as string | undefined,
      };
      calls.push(call);
      const id = `agent-${++index}`;
      let response: AgentReply;
      try {
        response = reply(call, index - 1);
      } catch (error) {
        response = { status: "failed", error: String(error) };
      }
      const envelope =
        typeof response === "object" &&
        response !== null &&
        ("output" in response || "status" in response || "error" in response)
          ? (response as { output?: unknown; status?: string; error?: string })
          : { output: response };
      captureStructuredOutput(options, envelope.output);
      records.set(id, {
        id,
        type,
        status: envelope.status ?? "completed",
        error: envelope.error,
        result: JSON.stringify(envelope.output ?? null),
        promise: Promise.resolve(),
        toolUses: 1,
      });
      return id;
    },
    getRecord(id: string) {
      return records.get(id);
    },
    abort() {
      return true;
    },
  };
  return calls;
}

function reviewerOutput(
  reviewer: ReviewerAgent,
  findings: Array<{
    priority: "P0" | "P1" | "P2" | "P3";
    title: string;
    file: string;
    line: number;
    why: string;
    change: string;
  }> = [],
  callouts: string[] = []
) {
  return {
    reviewer,
    verdict: findings.length ? "needs attention" : "correct",
    findings,
    humanReviewerCallouts: callouts,
    notes: [],
  };
}

function candidateIds(prompt: string): string[] {
  return [...prompt.matchAll(/"candidateId": "([^"]+)"/g)].map(
    (match) => match[1]
  );
}

function expectClosedSchemas(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      expectClosedSchemas(item);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "object") {
    expect(record.additionalProperties).toBe(false);
  }
  for (const nested of Object.values(record)) {
    expectClosedSchemas(nested);
  }
}

function defaultReply(call: AgentCall): unknown {
  if (call.type === "review-synthesizer") {
    return {
      clusters: candidateIds(call.prompt).map((id) => ({
        memberIds: [id],
        title: `Cluster ${id}`,
        why: "Evidence needs verification.",
        change: "Apply the candidate fix.",
      })),
    };
  }
  if (call.type === "review-verifier") {
    return {
      reviewScope: ["current changes"],
      verdict: "correct",
      findings: [],
    };
  }
  return reviewerOutput(call.type as ReviewerAgent);
}

function workflowInput(overrides: Record<string, unknown> = {}) {
  return {
    cwd: process.cwd(),
    scopeHint: "current changes",
    invocationPacket: "Review invocation packet",
    reviewers: ["code-reviewer"] as ReviewerAgent[],
    reviewerPanel: TEST_PANEL,
    synthesizerModel: TEST_SYNTHESIZER,
    verifierModel: TEST_VERIFIER,
    ...overrides,
  };
}

function createRuntime(
  exec: (
    command: string,
    args: string[]
  ) => { stdout: string; code: number; stderr?: string } = () => ({
    stdout: "",
    code: 0,
  })
) {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> | void }
  >();
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const sentMessages: Array<{
    message: Record<string, unknown>;
    options?: unknown;
  }> = [];
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
  const renderers = new Map<string, (message: unknown) => unknown>();
  return {
    commands,
    appendedEntries,
    sentMessages,
    sentUserMessages,
    renderers,
    pi: {
      exec: async (command: string, args: string[]) => exec(command, args),
      registerCommand(
        name: string,
        definition: {
          handler: (args: string, ctx: unknown) => Promise<void> | void;
        }
      ) {
        commands.set(name, definition);
      },
      registerMessageRenderer(
        type: string,
        renderer: (message: unknown) => unknown
      ) {
        renderers.set(type, renderer);
      },
      on() {
        // Session events are not needed by this command-level mock.
      },
      appendEntry(type: string, data: unknown) {
        appendedEntries.push({ type, data });
      },
      sendMessage(message: Record<string, unknown>, options?: unknown) {
        sentMessages.push({ message, options });
      },
      sendUserMessage(content: string, options?: unknown) {
        sentUserMessages.push({ content, options });
      },
    },
  };
}

function changedFilesRuntime() {
  return createRuntime((_command, args) => {
    if (args.join(" ") === "status --porcelain --untracked-files=all") {
      return { stdout: " M src/change.ts\n", code: 0 };
    }
    return { stdout: "", code: 0 };
  });
}

function reports(runtime: ReturnType<typeof createRuntime>) {
  return runtime.sentMessages.filter(
    ({ message }) => message.customType === REVIEW_REPORT_MESSAGE_TYPE
  );
}

async function withReviewConfigSandbox(
  run: (cwd: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supa-pi-review-"));
  const oldHome = process.env.HOME;
  process.env.HOME = path.join(root, "home");
  const cwd = path.join(root, "project");
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  try {
    await run(cwd);
  } finally {
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe.serial("review model config", () => {
  it("layers each field as flags, project, global, then defaults", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      await writeReviewConfigField(
        getGlobalReviewConfigPath(),
        "reviewerPanel",
        [{ model: "global/reviewer", thinkingLevel: "low" }]
      );
      await writeReviewConfigField(
        getGlobalReviewConfigPath(),
        "synthesizerModel",
        "global/synth"
      );
      const projectPath = await getProjectReviewConfigPath(cwd);
      await writeReviewConfigField(
        projectPath,
        "verifierModel",
        "project/verify"
      );

      const layered = await resolveReviewConfig(cwd);
      expect(layered.effective).toEqual({
        reviewerPanel: [{ model: "global/reviewer", thinkingLevel: "low" }],
        synthesizerModel: "global/synth",
        verifierModel: "project/verify",
      });
      const explicit = await resolveReviewConfig(cwd, {
        synthesizerModel: "flag/synth",
      });
      expect(explicit.effective.synthesizerModel).toBe("flag/synth");
      expect(explicit.effective.verifierModel).toBe("project/verify");
    });
  });

  it("blank clearing reveals lower layers and removes an empty config file", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const globalPath = getGlobalReviewConfigPath();
      const projectPath = await getProjectReviewConfigPath(cwd);
      await writeReviewConfigField(
        globalPath,
        "synthesizerModel",
        "global/synth"
      );
      await writeReviewConfigField(
        projectPath,
        "synthesizerModel",
        "project/synth"
      );
      await writeReviewConfigField(projectPath, "synthesizerModel", undefined);

      expect((await resolveReviewConfig(cwd)).effective.synthesizerModel).toBe(
        "global/synth"
      );
      expect(await fs.stat(projectPath).catch(() => null)).toBeNull();
    });
  });

  it("identifies invalid files and fields and rejects final verifier conflicts", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projectPath = await getProjectReviewConfigPath(cwd);
      await fs.writeFile(projectPath, '{"accidentalBehavior":true}');
      await expect(resolveReviewConfig(cwd)).rejects.toThrow(
        `${projectPath} field 'accidentalBehavior'`
      );
      await fs.writeFile(
        projectPath,
        JSON.stringify({
          reviewerPanel: [{ model: "same/model", thinkingLevel: "high" }],
          verifierModel: "same/model",
        })
      );
      await expect(resolveReviewConfig(cwd)).rejects.toThrow(
        "field 'verifierModel'"
      );
      await fs.writeFile(
        projectPath,
        JSON.stringify({ synthesizerModel: "provider/model\nspoof" })
      );
      await expect(resolveReviewConfig(cwd)).rejects.toThrow(
        "without whitespace"
      );
      for (const unsafeModel of [
        "provider/model\u001b",
        "provider/model\u202e",
      ]) {
        await fs.writeFile(
          projectPath,
          JSON.stringify({ synthesizerModel: unsafeModel })
        );
        await expect(resolveReviewConfig(cwd)).rejects.toThrow(
          "control, or Unicode format characters"
        );
      }
    });
  });

  it("reports malformed project config from the interactive selector without model calls", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projectPath = await getProjectReviewConfigPath(cwd);
      await fs.writeFile(projectPath, '{"synthesizerModel":');
      const calls = installManager();
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      ctx.cwd = cwd;
      reviewExtension(runtime.pi as never);

      await expect(
        runtime.commands.get("review")?.handler("", ctx as never)
      ).resolves.toBeUndefined();

      expect(calls).toHaveLength(0);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        message: expect.stringContaining(
          `Invalid review config ${projectPath} field '$': malformed JSON (`
        ),
        level: "error",
      });
    });
  });

  it("rejects unsafe invocation model IDs without rendering controls or making calls", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      for (const args of [
        "uncommitted --reviewers code-reviewer --synthesizer-model test/model\u001b",
        "uncommitted --reviewers code-reviewer --verifier-model test/model\u202e",
      ]) {
        const calls = installManager();
        const runtime = changedFilesRuntime();
        const { ctx, notifications } = createCtx();
        ctx.cwd = cwd;
        reviewExtension(runtime.pi as never);

        await runtime.commands.get("review")?.handler(args, ctx as never);

        expect(calls).toHaveLength(0);
        expect(
          notifications.some(({ message }) =>
            message.includes("control, or Unicode format characters")
          )
        ).toBe(true);
        expect(
          notifications.every(
            ({ message }) => !MODEL_CONTROL_OR_FORMAT_RE.test(message)
          )
        ).toBe(true);
      }
    });
  });

  it("approves exact canonical project path/hash and requires reapproval after changes", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projectPath = await getProjectReviewConfigPath(cwd);
      await writeReviewConfigField(
        projectPath,
        "synthesizerModel",
        "one/model"
      );
      const first = (await resolveReviewConfig(cwd)).project;
      expect(await isProjectReviewConfigApproved(first)).toBe(false);
      await approveProjectReviewConfig(first);
      expect(await isProjectReviewConfigApproved(first)).toBe(true);

      await writeReviewConfigField(
        projectPath,
        "synthesizerModel",
        "two/model"
      );
      const changed = (await resolveReviewConfig(cwd)).project;
      expect(await isProjectReviewConfigApproved(changed)).toBe(false);
      await fs.writeFile(
        projectPath,
        JSON.stringify({ synthesizerModel: "three/model" })
      );
      await expect(approveProjectReviewConfig(changed)).rejects.toThrow(
        "changed before approval"
      );
      const trust = JSON.parse(await fs.readFile(getReviewTrustPath(), "utf8"));
      expect(JSON.stringify(trust)).not.toContain("one/model");
    });
  });

  it("rejects project writes through a symlinked .pi directory", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const globalPath = getGlobalReviewConfigPath();
      await writeReviewConfigField(
        globalPath,
        "synthesizerModel",
        "global/original"
      );
      await fs.rm(path.join(cwd, ".pi"), { recursive: true });
      await fs.mkdir(path.dirname(globalPath), { recursive: true });
      await fs.symlink(path.dirname(globalPath), path.join(cwd, ".pi"));

      await expect(
        writeReviewConfigField(
          await getProjectReviewConfigPath(cwd),
          "synthesizerModel",
          "project/escaped"
        )
      ).rejects.toThrow("symlinked directory");
      expect(JSON.parse(await fs.readFile(globalPath, "utf8"))).toEqual({
        synthesizerModel: "global/original",
      });
    });
  });

  it("preserves distinct fields written concurrently to one config", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projectPath = await getProjectReviewConfigPath(cwd);
      await Promise.all([
        writeReviewConfigField(
          projectPath,
          "synthesizerModel",
          "project/synth"
        ),
        writeReviewConfigField(projectPath, "verifierModel", "project/verify"),
      ]);

      expect(JSON.parse(await fs.readFile(projectPath, "utf8"))).toEqual({
        synthesizerModel: "project/synth",
        verifierModel: "project/verify",
      });
    });
  });

  it("preserves concurrent approvals for distinct projects", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projects = [cwd, `${cwd}-two`];
      await fs.mkdir(path.join(projects[1], ".pi"), { recursive: true });
      const layers = await Promise.all(
        projects.map(async (project, index) => {
          await writeReviewConfigField(
            await getProjectReviewConfigPath(project),
            "synthesizerModel",
            `project/model-${index}`
          );
          return (await resolveReviewConfig(project)).project;
        })
      );

      await Promise.all(layers.map(approveProjectReviewConfig));
      expect(
        await Promise.all(layers.map(isProjectReviewConfigApproved))
      ).toEqual([true, true]);
    });
  });

  it("lets a direct verifier flag repair a stored cross-layer conflict", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      await writeReviewConfigField(
        getGlobalReviewConfigPath(),
        "reviewerPanel",
        [{ model: TEST_VERIFIER, thinkingLevel: "high" }]
      );
      await writeReviewConfigField(
        await getProjectReviewConfigPath(cwd),
        "verifierModel",
        TEST_VERIFIER
      );
      await expect(resolveReviewConfig(cwd)).rejects.toThrow("conflicts");

      const calls = installManager();
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      ctx.cwd = cwd;
      ctx.ui.confirm = async () => true;
      reviewExtension(runtime.pi as never);
      await runtime.commands
        .get("review")
        ?.handler(
          "uncommitted --reviewers code-reviewer --verifier-model test/repaired",
          ctx as never
        );

      expect(calls.map(({ model }) => model)).toEqual([TEST_VERIFIER]);
      expect(notifications.some(({ level }) => level === "error")).toBe(false);
    });
  });

  it("keeps model configuration reachable for a cross-layer conflict", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      await writeReviewConfigField(
        getGlobalReviewConfigPath(),
        "reviewerPanel",
        [{ model: TEST_VERIFIER, thinkingLevel: "high" }]
      );
      await writeReviewConfigField(
        await getProjectReviewConfigPath(cwd),
        "verifierModel",
        TEST_VERIFIER
      );
      const runtime = changedFilesRuntime();
      const { ctx } = createCtx();
      ctx.cwd = cwd;
      const selections = ["configureReviewModels", null];
      let editorPrompt = "";
      ctx.ui.custom = async () => selections.shift() as never;
      ctx.ui.select = async () => "Set project verifier model";
      ctx.ui.editor = ((prompt: string) => {
        editorPrompt = prompt;
        return Promise.resolve("test/repaired");
      }) as never;
      reviewExtension(runtime.pi as never);

      await runtime.commands.get("review")?.handler("", ctx as never);

      expect(editorPrompt).toBe(
        `Enter project verifier model (provider/model; blank clears):\nCurrent: ${TEST_VERIFIER}`
      );
      expect((await resolveReviewConfig(cwd)).effective.verifierModel).toBe(
        "test/repaired"
      );
    });
  });

  it("fails closed headlessly for an unapproved project hash with zero calls", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      await writeReviewConfigField(
        await getProjectReviewConfigPath(cwd),
        "synthesizerModel",
        TEST_SYNTHESIZER
      );
      const calls = installManager();
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      ctx.cwd = cwd;
      ctx.hasUI = false;
      reviewExtension(runtime.pi as never);
      await runtime.commands
        .get("review")
        ?.handler("uncommitted --reviewers code-reviewer", ctx as never);

      expect(calls).toHaveLength(0);
      expect(
        notifications.some(({ message }) => message.includes("unapproved"))
      ).toBe(true);
    });
  });

  it("allows a fully masked unapproved project config headlessly without writing trust", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projectPath = await getProjectReviewConfigPath(cwd);
      await writeReviewConfigField(projectPath, "reviewerPanel", [
        { model: "project/reviewer", thinkingLevel: "high" },
      ]);
      await writeReviewConfigField(
        projectPath,
        "synthesizerModel",
        "project/synth"
      );
      await writeReviewConfigField(
        projectPath,
        "verifierModel",
        "project/verify"
      );
      const calls = installManager();
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      ctx.cwd = cwd;
      ctx.hasUI = false;
      reviewExtension(runtime.pi as never);

      await runtime.commands
        .get("review")
        ?.handler(
          "uncommitted --reviewers code-reviewer --reviewer-models test/flag-reviewer=high --synthesizer-model test/flag-synth --verifier-model test/flag-verify",
          ctx as never
        );

      expect(calls).toHaveLength(1);
      expect(notifications.some(({ level }) => level === "error")).toBe(false);
      expect(
        await isProjectReviewConfigApproved(
          (await resolveReviewConfig(cwd)).project
        )
      ).toBe(false);
      await expect(fs.readFile(getReviewTrustPath(), "utf8")).rejects.toThrow();
    });
  });

  it("fails closed headlessly when an unapproved project field is only partially masked", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projectPath = await getProjectReviewConfigPath(cwd);
      await writeReviewConfigField(
        projectPath,
        "synthesizerModel",
        "project/synth"
      );
      await writeReviewConfigField(
        projectPath,
        "verifierModel",
        "project/verify"
      );
      const calls = installManager();
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      ctx.cwd = cwd;
      ctx.hasUI = false;
      reviewExtension(runtime.pi as never);

      await runtime.commands
        .get("review")
        ?.handler(
          "uncommitted --reviewers code-reviewer --synthesizer-model test/flag-synth",
          ctx as never
        );

      expect(calls).toHaveLength(0);
      expect(
        notifications.some(({ message }) => message.includes("unapproved"))
      ).toBe(true);
      expect(
        await isProjectReviewConfigApproved(
          (await resolveReviewConfig(cwd)).project
        )
      ).toBe(false);
    });
  });

  it("keeps partial-mask interactive consent one-shot and later headless review blocked", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projectPath = await getProjectReviewConfigPath(cwd);
      await writeReviewConfigField(projectPath, "reviewerPanel", [
        { model: "project/hidden-reviewer", thinkingLevel: "high" },
      ]);
      await writeReviewConfigField(
        projectPath,
        "verifierModel",
        "project/disclosed-verifier"
      );
      const calls = installManager();
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      ctx.cwd = cwd;
      let disclosure = "";
      ctx.ui.confirm = (_title: string, message: string) => {
        disclosure = message;
        return Promise.resolve(true);
      };
      reviewExtension(runtime.pi as never);

      await runtime.commands
        .get("review")
        ?.handler(
          "uncommitted --reviewers code-reviewer --reviewer-models test/flag-reviewer=high",
          ctx as never
        );

      expect(calls).toHaveLength(1);
      expect(disclosure).toContain("reviewer test/flag-reviewer");
      expect(disclosure).toContain("verifier project/disclosed-verifier");
      expect(disclosure).not.toContain("project/hidden-reviewer");
      expect(
        await isProjectReviewConfigApproved(
          (await resolveReviewConfig(cwd)).project
        )
      ).toBe(false);

      ctx.hasUI = false;
      await runtime.commands
        .get("review")
        ?.handler("uncommitted --reviewers code-reviewer", ctx as never);

      expect(calls).toHaveLength(1);
      expect(
        notifications.some(({ message }) => message.includes("unapproved"))
      ).toBe(true);
      expect(
        await isProjectReviewConfigApproved(
          (await resolveReviewConfig(cwd)).project
        )
      ).toBe(false);
    });
  });

  it("shows exact effective models for consent and selector project saves approve", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projectPath = await getProjectReviewConfigPath(cwd);
      await writeReviewConfigField(
        projectPath,
        "synthesizerModel",
        TEST_SYNTHESIZER
      );
      const calls = installManager();
      const runtime = changedFilesRuntime();
      const { ctx } = createCtx();
      ctx.cwd = cwd;
      let disclosure = "";
      ctx.ui.confirm = (_title: string, message: string) => {
        disclosure = message;
        return Promise.resolve(true);
      };
      reviewExtension(runtime.pi as never);
      await runtime.commands
        .get("review")
        ?.handler("uncommitted --reviewers code-reviewer", ctx as never);
      expect(calls).toHaveLength(DEFAULT_REVIEWER_PANEL.length);
      expect(disclosure).toContain(`synthesizer ${TEST_SYNTHESIZER}`);
      expect(disclosure).toContain("provider: test");
      expect(
        await isProjectReviewConfigApproved(
          (await resolveReviewConfig(cwd)).project
        )
      ).toBe(true);

      await writeReviewConfigField(
        projectPath,
        "synthesizerModel",
        "test/changed"
      );
      expect(
        await isProjectReviewConfigApproved(
          (await resolveReviewConfig(cwd)).project
        )
      ).toBe(false);
      const selectorRuntime = createRuntime();
      const selectorCtx = createCtx().ctx;
      selectorCtx.cwd = cwd;
      const selections = [
        "configureReviewModels",
        "configureReviewModels",
        null,
      ];
      const modelSelections = [
        "Set global verifier model",
        "Set project synthesizer model",
      ];
      const editorPrompts: string[] = [];
      selectorCtx.ui.custom = async () => selections.shift() as never;
      selectorCtx.ui.select = ((_title: string, options: string[]) => {
        const selection = modelSelections.shift();
        expect(options).toContain(selection);
        return Promise.resolve(selection);
      }) as never;
      selectorCtx.ui.editor = ((prompt: string) => {
        editorPrompts.push(prompt);
        return Promise.resolve(
          editorPrompts.length === 1 ? null : "test/saved"
        );
      }) as never;
      reviewExtension(selectorRuntime.pi as never);
      await selectorRuntime.commands
        .get("review")
        ?.handler("", selectorCtx as never);
      expect(
        await isProjectReviewConfigApproved(
          (await resolveReviewConfig(cwd)).project
        )
      ).toBe(true);
      expect(editorPrompts).toEqual([
        `Enter global verifier model (provider/model; blank clears):\nDefault: ${DEFAULT_VERIFIER_MODEL}`,
        "Enter project synthesizer model (provider/model; blank clears):\nCurrent: test/changed",
      ]);
    });
  });

  it("leaves a selector write unapproved when untouched project fields are not confirmed", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projectPath = await getProjectReviewConfigPath(cwd);
      await writeReviewConfigField(
        projectPath,
        "synthesizerModel",
        "test/existing-synth"
      );
      await writeReviewConfigField(
        projectPath,
        "verifierModel",
        "test/existing-verifier"
      );
      const runtime = createRuntime();
      const { ctx, notifications } = createCtx();
      ctx.cwd = cwd;
      const selections = ["configureReviewModels", null];
      ctx.ui.custom = async () => selections.shift() as never;
      ctx.ui.select = async () => "Set project synthesizer model";
      ctx.ui.editor = async () => "test/saved-synth";
      let disclosure = "";
      ctx.ui.confirm = (_title: string, message: string) => {
        disclosure = message;
        return Promise.resolve(false);
      };
      reviewExtension(runtime.pi as never);

      await runtime.commands.get("review")?.handler("", ctx as never);

      const resolved = await resolveReviewConfig(cwd);
      expect(resolved.project.config.synthesizerModel).toBe("test/saved-synth");
      expect(resolved.project.config.verifierModel).toBe(
        "test/existing-verifier"
      );
      expect(await isProjectReviewConfigApproved(resolved.project)).toBe(false);
      expect(disclosure).toContain("synthesizer test/saved-synth");
      expect(disclosure).toContain("verifier test/existing-verifier");
      expect(
        notifications.some(({ message }) =>
          message.includes("project models remain unapproved")
        )
      ).toBe(true);
    });
  });

  it("does not persist trust when direct flags mask project model fields", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      const projectPath = await getProjectReviewConfigPath(cwd);
      await writeReviewConfigField(projectPath, "reviewerPanel", [
        { model: "project/reviewer", thinkingLevel: "high" },
      ]);
      await writeReviewConfigField(
        projectPath,
        "synthesizerModel",
        "project/synth"
      );
      await writeReviewConfigField(
        projectPath,
        "verifierModel",
        "project/verify"
      );
      const calls = installManager();
      const runtime = changedFilesRuntime();
      const { ctx } = createCtx();
      ctx.cwd = cwd;
      ctx.ui.confirm = async () => true;
      reviewExtension(runtime.pi as never);

      await runtime.commands
        .get("review")
        ?.handler(
          "uncommitted --reviewers code-reviewer --reviewer-models test/flag-reviewer=high --synthesizer-model test/flag-synth --verifier-model test/flag-verify",
          ctx as never
        );

      expect(calls).toHaveLength(1);
      expect(
        await isProjectReviewConfigApproved(
          (await resolveReviewConfig(cwd)).project
        )
      ).toBe(false);
    });
  });
});

describe.serial("multi-model review orchestration", () => {
  it("uses the default two-model panel with per-model thinking and accurate progress totals", async () => {
    const calls = installManager();
    const { ctx } = createCtx();
    const progress: ReviewWorkflowProgressUpdate[] = [];
    const result = await runReviewWorkflow({} as never, ctx as never, {
      ...workflowInput(),
      reviewerPanel: undefined,
      synthesizerModel: undefined,
      verifierModel: undefined,
      onProgress: (update) => progress.push(update),
    });

    expect(
      calls
        .map(({ type, model, thinking }) => `${type}:${model}=${thinking}`)
        .sort()
    ).toEqual(
      DEFAULT_REVIEWER_PANEL.map(
        (entry) => `code-reviewer:${entry.model}=high`
      ).sort()
    );
    expect(result.coverage.configuredPanelSize).toBe(2);
    expect(result.coverage.callPlan.reviewerRuns).toHaveLength(2);
    expect(progress.every(({ text }) => !text.includes("/4"))).toBe(true);
    expect(progress.at(-1)?.text).toContain("Reviewers 2/2");
    for (const { envelope } of progress) {
      const reviewerLabels = envelope.agentCalls
        .map((call) => call.label)
        .filter(
          (label): label is string =>
            typeof label === "string" && label.startsWith("code-reviewer · ")
        );
      expect(new Set(reviewerLabels).size).toBe(reviewerLabels.length);
    }
  });

  it("preflights reviewer, synthesizer, verifier availability and overlap before any call", async () => {
    for (const input of [
      workflowInput({ verifierModel: "test/alpha" }),
      workflowInput({ synthesizerModel: "missing/model" }),
    ]) {
      const calls = installManager();
      const { ctx } = createCtx([], (model) => model !== "missing/model");
      await expect(
        runReviewWorkflow({} as never, ctx as never, input as never)
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
    expect(() => assertVerifierModelPolicy("test/alpha", TEST_PANEL)).toThrow(
      "conflicts"
    );
  });

  it("caps role×model reviewer execution globally at four", async () => {
    let active = 0;
    let maximum = 0;
    let serial = 0;
    const records = new Map<string, Record<string, unknown>>();
    (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("pi-subagents:manager")
    ] = {
      spawn(
        _pi: unknown,
        _ctx: unknown,
        type: string,
        _prompt: string,
        options: Record<string, unknown>
      ) {
        const id = `agent-${++serial}`;
        active += 1;
        maximum = Math.max(maximum, active);
        const output = reviewerOutput(type as ReviewerAgent);
        const record: Record<string, unknown> = { id, type, status: "running" };
        record.promise = new Promise<void>((resolve) =>
          setTimeout(() => {
            captureStructuredOutput(options, output);
            record.status = "completed";
            record.result = JSON.stringify(output);
            active -= 1;
            resolve();
          }, 20)
        );
        records.set(id, record);
        return id;
      },
      getRecord: (id: string) => records.get(id),
      abort: () => true,
    };
    const { ctx } = createCtx();
    await runReviewWorkflow(
      {} as never,
      ctx as never,
      workflowInput({
        reviewers: ["code-reviewer", "security-reviewer", "database-reviewer"],
        reviewerPanel: [
          ...TEST_PANEL,
          { model: "test/gamma", thinkingLevel: "medium" },
        ],
      }) as never
    );
    expect(maximum).toBe(REVIEW_WORKFLOW_CONCURRENCY);
  });

  it("repairs a reviewer once with its originating model and effort", async () => {
    const calls = installManager((call, index) => {
      if (call.type === "code-reviewer" && index === 0) {
        return { nope: true };
      }
      return defaultReply(call);
    });
    const { ctx } = createCtx();
    const result = await runReviewWorkflow(
      {} as never,
      ctx as never,
      workflowInput({ reviewerPanel: [TEST_PANEL[0]] }) as never
    );
    expect(result.reviewerOutputs).toHaveLength(1);
    expect(
      calls.slice(0, 2).map(({ model, thinking }) => ({ model, thinking }))
    ).toEqual([
      { model: "test/alpha", thinking: "low" },
      { model: "test/alpha", thinking: "low" },
    ]);
    expect(calls[1]?.prompt).toContain(
      "previous structured review submission failed validation"
    );
  });

  it("continues after partial model failure when every role succeeds and marks degraded coverage", async () => {
    const calls = installManager((call) =>
      call.type === "code-reviewer" && call.model === "test/alpha"
        ? { status: "failed", error: "provider unavailable" }
        : defaultReply(call)
    );
    const { ctx } = createCtx();
    const result = await runReviewWorkflow(
      {} as never,
      ctx as never,
      workflowInput({
        reviewers: ["code-reviewer", "security-reviewer"],
      }) as never
    );
    expect(calls.filter((call) => call.type.endsWith("reviewer"))).toHaveLength(
      4
    );
    expect(result.coverage.degraded).toBe(true);
    expect(result.report).toContain("Degraded: yes");
    expect(result.report).toContain("code-reviewer · `test/alpha`: failed");
  });

  it("stops when a reviewer role has no successful model run", async () => {
    const calls = installManager((call) =>
      call.type === "security-reviewer"
        ? { status: "failed", error: "down" }
        : defaultReply(call)
    );
    const { ctx } = createCtx();
    await expect(
      runReviewWorkflow(
        {} as never,
        ctx as never,
        workflowInput({
          reviewers: ["code-reviewer", "security-reviewer"],
        }) as never
      )
    ).rejects.toThrow("security-reviewer");
    expect(calls.some((call) => call.type === "review-synthesizer")).toBe(
      false
    );
  });

  it("takes the empty-finding fast path, skipping downstream calls and retaining coverage/call plan", async () => {
    const calls = installManager();
    const { ctx } = createCtx();
    const result = await runReviewWorkflow(
      {} as never,
      ctx as never,
      workflowInput() as never
    );
    expect(calls).toHaveLength(2);
    expect(result.candidates).toEqual([]);
    expect(result.clusters).toEqual([]);
    expect(result.coverage.callPlan.synthesizer).toBeUndefined();
    expect(result.coverage.callPlan.verifier).toBeUndefined();
    expect(result.report).toContain("Code looks good");
    expect(result.report).toContain("code-reviewer · `test/alpha`: used");
  });

  it("enforces synthesizer closed schema and exact-once losslessness, repairs once, then succeeds", async () => {
    let synthCount = 0;
    const calls = installManager((call) => {
      if (call.type.endsWith("reviewer")) {
        return reviewerOutput(call.type as ReviewerAgent, [
          {
            priority: "P2",
            title: "Bug",
            file: "src/a.ts",
            line: 2,
            why: "Breaks.",
            change: "Fix it.",
          },
        ]);
      }
      if (call.type === "review-synthesizer") {
        synthCount += 1;
        return synthCount === 1
          ? { clusters: [], extra: true }
          : {
              clusters: [
                {
                  memberIds: candidateIds(call.prompt),
                  title: "Bug",
                  why: "Breaks.",
                  change: "Fix it.",
                },
              ],
            };
      }
      return defaultReply(call);
    });
    const { ctx } = createCtx();
    const result = await runReviewWorkflow(
      {} as never,
      ctx as never,
      workflowInput({ reviewerPanel: [TEST_PANEL[0]] }) as never
    );
    expect(result.clusters[0]?.memberIds).toEqual(["candidate-0001"]);
    const synthesizerCalls = calls.filter(
      (call) => call.type === "review-synthesizer"
    );
    expect(synthesizerCalls).toHaveLength(2);
    expect(synthesizerCalls[0]?.thinking).toBe("high");
    const structuredTool = (
      synthesizerCalls[0]?.options.customTools as
        | Array<{ name: string; parameters: unknown }>
        | undefined
    )?.find((tool) => tool.name === "structured_output");
    expect(structuredTool).toBeDefined();
    expectClosedSchemas(structuredTool?.parameters);
  });

  it("fails after one lossy synthesizer repair", async () => {
    const calls = installManager((call) => {
      if (call.type.endsWith("reviewer")) {
        return reviewerOutput(call.type as ReviewerAgent, [
          {
            priority: "P2",
            title: "Bug",
            file: "a.ts",
            line: 1,
            why: "Bad.",
            change: "Fix.",
          },
        ]);
      }
      if (call.type === "review-synthesizer") {
        return { clusters: [] };
      }
      return defaultReply(call);
    });
    const { ctx } = createCtx();
    await expect(
      runReviewWorkflow(
        {} as never,
        ctx as never,
        workflowInput({ reviewerPanel: [TEST_PANEL[0]] }) as never
      )
    ).rejects.toThrow("after one structured repair retry");
    expect(
      calls.filter((call) => call.type === "review-synthesizer")
    ).toHaveLength(2);
  });

  it("derives lossless clusters, multi-location provenance, distinct-model support, eligible denominator, ordering, and verifier corrections", async () => {
    const findingsByModel: Record<
      string,
      ReturnType<typeof reviewerOutput>["findings"]
    > = {
      "test/alpha": [
        {
          priority: "P2",
          title: "Guard bug",
          file: "src/a.ts",
          line: 10,
          why: "Rejects valid users.",
          change: "Restore guard.",
        },
        {
          priority: "P1",
          title: "Similar impact",
          file: "src/b.ts",
          line: 20,
          why: "Rejects valid users.",
          change: "Change caller.",
        },
      ],
      "test/beta": [
        {
          priority: "P3",
          title: "Same guard",
          file: "src/a.ts",
          line: 14,
          why: "Guard rejects users.",
          change: "Restore guard.",
        },
        {
          priority: "P1",
          title: "Another issue",
          file: "src/c.ts",
          line: 4,
          why: "Crashes.",
          change: "Handle null.",
        },
      ],
    };
    const calls = installManager((call) => {
      if (call.type.endsWith("reviewer")) {
        return reviewerOutput(
          call.type as ReviewerAgent,
          findingsByModel[call.model ?? ""] ?? []
        );
      }
      if (call.type === "review-synthesizer") {
        return {
          clusters: [
            {
              memberIds: ["candidate-0001", "candidate-0003"],
              title: "Guard bug",
              why: "Same root.",
              change: "Restore guard.",
            },
            {
              memberIds: ["candidate-0002"],
              title: "Caller bug",
              why: "Different root.",
              change: "Change caller.",
            },
            {
              memberIds: ["candidate-0004"],
              title: "Null bug",
              why: "Null crash.",
              change: "Handle null.",
            },
          ],
        };
      }
      if (call.type === "review-verifier") {
        return {
          reviewScope: ["curated fixture"],
          verdict: "needs attention",
          findings: [
            {
              memberIds: ["candidate-0001", "candidate-0003"],
              priority: "P1",
              title: "Corrected guard wording",
              why: "Verified guard failure.",
              change: "Restore the valid branch.",
              confidence: "high",
              reason: "The changed guard rejects valid input.",
              consensusEffect: "raised-one-level",
            },
            {
              memberIds: ["candidate-0002", "candidate-0004"],
              priority: "P1",
              title: "Verifier merged evidence",
              why: "Both paths fail.",
              change: "Fix both paths.",
              confidence: "medium",
              reason: "Both cited paths are reachable.",
              consensusEffect: "none",
            },
          ],
        };
      }
      return defaultReply(call);
    });
    const { ctx } = createCtx();
    const progress: string[] = [];
    const result = await runReviewWorkflow(
      {} as never,
      ctx as never,
      workflowInput({
        onProgress: (update: ReviewWorkflowProgressUpdate) =>
          progress.push(update.text),
      }) as never
    );
    expect(result.clusters.map((cluster) => cluster.memberIds)).toEqual([
      ["candidate-0001", "candidate-0003"],
      ["candidate-0002"],
      ["candidate-0004"],
    ]);
    const first = result.verifier.findings[0];
    expect(first?.title).toBe("Corrected guard wording");
    expect(first?.locations).toEqual([
      { file: "src/a.ts", line: 10 },
      { file: "src/a.ts", line: 14 },
    ]);
    expect(first?.supportingModels).toEqual(["test/alpha", "test/beta"]);
    expect(first?.modelReviewerRoles).toEqual({
      "test/alpha": ["code-reviewer"],
      "test/beta": ["code-reviewer"],
    });
    expect(first?.supportCount).toBe(2);
    expect(first?.eligibleModelCount).toBe(2);
    expect(first?.consensusEffect).toBe("raised-one-level");
    expect(result.report.indexOf("Corrected guard wording")).toBeLessThan(
      result.report.indexOf("Verifier merged evidence")
    );
    expect(calls.map((call) => call.type)).toEqual([
      "code-reviewer",
      "code-reviewer",
      "review-synthesizer",
      "review-verifier",
    ]);
    expect(
      calls.find((call) => call.type === "review-verifier")?.thinking
    ).toBe("high");
    expect(
      progress.some((text) => text.includes("Synthesizing findings"))
    ).toBe(true);
    expect(progress.some((text) => text.includes("Verifying findings"))).toBe(
      true
    );
  });

  it("uses successful models for each represented role as the finding denominator", async () => {
    const calls = installManager((call) => {
      if (call.type === "security-reviewer" && call.model === "test/beta") {
        return { status: "failed", error: "down" };
      }
      if (call.type === "security-reviewer") {
        return reviewerOutput("security-reviewer", [
          {
            priority: "P2",
            title: "Auth",
            file: "auth.ts",
            line: 1,
            why: "Bypass.",
            change: "Check auth.",
          },
        ]);
      }
      if (call.type.endsWith("reviewer")) {
        return reviewerOutput(call.type as ReviewerAgent);
      }
      if (call.type === "review-synthesizer") {
        return {
          clusters: [
            {
              memberIds: ["candidate-0001"],
              title: "Auth",
              why: "Bypass.",
              change: "Check auth.",
            },
          ],
        };
      }
      if (call.type === "review-verifier") {
        return {
          reviewScope: ["auth"],
          verdict: "needs attention",
          findings: [
            {
              memberIds: ["candidate-0001"],
              priority: "P2",
              title: "Auth",
              why: "Bypass.",
              change: "Check auth.",
              confidence: "high",
              reason: "The auth branch bypasses checks.",
              consensusEffect: "none",
            },
          ],
        };
      }
      return defaultReply(call);
    });
    const { ctx } = createCtx();
    const result = await runReviewWorkflow(
      {} as never,
      ctx as never,
      workflowInput({
        reviewers: ["code-reviewer", "security-reviewer"],
      }) as never
    );
    expect(result.verifier.findings[0]?.eligibleModels).toEqual(["test/alpha"]);
    expect(result.verifier.findings[0]?.supportCount).toBe(1);
    expect(result.verifier.findings[0]?.eligibleModelCount).toBe(1);
    expect(calls).toHaveLength(6);
  });

  it("rejects unknown/repeated verifier member IDs, repairs once, and supports split/merge groups", async () => {
    let verifierCount = 0;
    const calls = installManager((call) => {
      if (call.type.endsWith("reviewer")) {
        return reviewerOutput(call.type as ReviewerAgent, [
          {
            priority: "P2",
            title: "Bug",
            file: `${call.model}.ts`,
            line: 1,
            why: "Bad.",
            change: "Fix.",
          },
        ]);
      }
      if (call.type === "review-synthesizer") {
        return {
          clusters: [
            {
              memberIds: candidateIds(call.prompt),
              title: "Merged",
              why: "Maybe same.",
              change: "Fix.",
            },
          ],
        };
      }
      if (call.type === "review-verifier") {
        verifierCount += 1;
        if (verifierCount === 1) {
          return {
            reviewScope: ["fixture"],
            verdict: "needs attention",
            findings: [
              {
                memberIds: ["candidate-0001", "candidate-0001", "unknown"],
                priority: "P2",
                title: "Invalid",
                why: "Bad.",
                change: "Fix.",
                confidence: "medium",
                reason: "The cited code is faulty.",
                consensusEffect: "none",
              },
            ],
          };
        }
        return {
          reviewScope: ["fixture"],
          verdict: "needs attention",
          findings: [
            {
              memberIds: ["candidate-0001"],
              priority: "P2",
              title: "Split one",
              why: "Bad.",
              change: "Fix.",
              confidence: "medium",
              reason: "The first cited path is faulty.",
              consensusEffect: "none",
            },
            {
              memberIds: ["candidate-0002"],
              priority: "P2",
              title: "Split two",
              why: "Bad.",
              change: "Fix.",
              confidence: "medium",
              reason: "The second cited path is faulty.",
              consensusEffect: "none",
            },
          ],
        };
      }
      return defaultReply(call);
    });
    const { ctx } = createCtx();
    const result = await runReviewWorkflow(
      {} as never,
      ctx as never,
      workflowInput() as never
    );
    expect(
      result.verifier.findings.map((finding) => finding.memberIds)
    ).toEqual([["candidate-0001"], ["candidate-0002"]]);
    expect(
      calls.filter((call) => call.type === "review-verifier")
    ).toHaveLength(2);
    expect(calls.at(-1)?.prompt).toContain(
      "previous verifier structured submission failed validation"
    );
  });

  it("filters low confidence and sanitizes report-controlled Markdown", () => {
    const report: VerifierJsonContract = {
      reviewScope: ["scope\n## forged"],
      verdict: "needs attention",
      findings: [
        {
          priority: "P1",
          title: "High\n## forged",
          file: "src/a`b.ts",
          line: 2,
          sourceReviewer: "code-reviewer",
          confidence: "high",
          reason: "Evidence\n- forged",
          why: "Bad\ntext",
          change: "Fix\ntext",
          consensusEffect: "none",
        },
        {
          priority: "P0",
          title: "Low hidden",
          file: "src/low.ts",
          line: 1,
          sourceReviewer: "code-reviewer",
          confidence: "low",
          reason: "Weak.",
          why: "Maybe.",
          change: "Inspect.",
        },
      ],
      humanReviewerCallouts: ["callout\n## forged"],
      reviewerCoverage: {
        "code-reviewer": "used",
        "security-reviewer": "not used",
        "database-reviewer": "not used",
        "performance-reviewer": "not used",
      },
    };
    const rendered = renderReviewReport(report);
    expect(rendered).toContain("High \\#\\# forged");
    expect(rendered).toContain("src/a'b.ts");
    expect(rendered).not.toContain("Low hidden");
    expect(rendered.match(/^## Findings$/gm)).toHaveLength(1);
  });

  it("stops queued reviewer jobs from launching after cancellation", async () => {
    const calls: string[] = [];
    const records = new Map<string, Record<string, unknown>>();
    (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("pi-subagents:manager")
    ] = {
      spawn(
        _pi: unknown,
        _ctx: unknown,
        type: string,
        _prompt: string,
        _options: Record<string, unknown>
      ) {
        calls.push(type);
        const id = `queued-${calls.length}`;
        records.set(id, {
          id,
          type,
          status: "running",
          promise: new Promise(() => undefined),
          toolUses: 0,
        });
        return id;
      },
      getRecord(id: string) {
        return records.get(id);
      },
      abort() {
        return true;
      },
    };
    const controller = new AbortController();
    const { ctx } = createCtx();
    const run = runReviewWorkflow({} as never, ctx as never, {
      ...workflowInput({
        reviewers: ["code-reviewer", "security-reviewer"],
        reviewerPanel: [
          ...TEST_PANEL,
          { model: "test/gamma", thinkingLevel: "high" },
        ],
      }),
      signal: controller.signal,
    });
    while (calls.length < REVIEW_WORKFLOW_CONCURRENCY) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    controller.abort();

    await expect(run).rejects.toThrow("cancelled");
    expect(calls).toHaveLength(REVIEW_WORKFLOW_CONCURRENCY);
  });

  it("repairs then rejects forged one-model consensus", async () => {
    const finding = {
      priority: "P2" as const,
      title: "One-model issue",
      file: "src/one-model.ts",
      line: 3,
      why: "It breaks.",
      change: "Fix it.",
    };
    const calls = installManager((call) => {
      if (call.type === "code-reviewer") {
        return reviewerOutput("code-reviewer", [finding]);
      }
      if (call.type === "review-synthesizer") {
        return defaultReply(call);
      }
      const id = candidateIds(call.prompt)[0];
      return {
        reviewScope: ["current changes"],
        verdict: "needs attention",
        findings: [
          {
            memberIds: [id],
            priority: "P2",
            title: finding.title,
            why: finding.why,
            change: finding.change,
            confidence: "high",
            reason: "Changed code confirms the issue.",
            consensusEffect: "raised-one-level",
          },
        ],
      };
    });
    const { ctx } = createCtx();

    await expect(
      runReviewWorkflow({} as never, ctx as never, {
        ...workflowInput(),
        reviewerPanel: [TEST_PANEL[0]],
      })
    ).rejects.toThrow("invalid structured output after one structured repair");
    expect(
      calls.filter((call) => call.type === "review-verifier")
    ).toHaveLength(2);
  });

  it("rejects registered models without configured authentication before calls", async () => {
    const calls = installManager();
    const { ctx } = createCtx();
    ctx.modelRegistry.hasConfiguredAuth = () => false;

    await expect(
      runReviewWorkflow({} as never, ctx as never, workflowInput())
    ).rejects.toThrow("authentication is not configured");
    expect(calls).toEqual([]);
  });

  it("stores and renders only stable failure categories", async () => {
    const secret = "sk-live-super-secret";
    installManager((call) => {
      if (call.type === "code-reviewer" && call.model === "test/alpha") {
        return { status: "failed", error: `provider exploded: ${secret}` };
      }
      return defaultReply(call);
    });
    const { ctx } = createCtx();

    const result = await runReviewWorkflow(
      {} as never,
      ctx as never,
      workflowInput()
    );

    expect(result.coverage.runs[0]?.error).toBe("Agent run failed.");
    expect(JSON.stringify(result.coverage)).not.toContain(secret);
    expect(result.report).not.toContain(secret);
    expect(result.report).toContain("Agent run failed.");
  });

  it("isolates only synthesizer spawns", async () => {
    const finding = {
      priority: "P2" as const,
      title: "Isolation issue",
      file: "src/isolation.ts",
      line: 4,
      why: "It breaks.",
      change: "Fix it.",
    };
    const calls = installManager((call) =>
      call.type === "code-reviewer"
        ? reviewerOutput("code-reviewer", [finding])
        : defaultReply(call)
    );
    const { ctx } = createCtx();

    await runReviewWorkflow({} as never, ctx as never, workflowInput());

    expect(
      calls.find((call) => call.type === "review-synthesizer")?.options.isolated
    ).toBe(true);
    expect(
      calls.filter((call) => call.type === "code-reviewer")[0]?.options.isolated
    ).toBe(false);
    expect(
      calls.find((call) => call.type === "review-verifier")?.options.isolated
    ).toBe(false);
  });
});

describe.serial("/review command settings and disclosure", () => {
  it("passes the normal default panel and emits planned-call/provider disclosure", async () => {
    const calls = installManager();
    const runtime = changedFilesRuntime();
    const { ctx, notifications } = createCtx();
    reviewExtension(runtime.pi as never);
    await runtime.commands
      .get("review")
      ?.handler("uncommitted --reviewers code-reviewer", ctx as never);
    expect(calls.map((call) => call.model).sort()).toEqual(
      DEFAULT_REVIEWER_PANEL.map((entry) => entry.model).sort()
    );
    expect(
      notifications.some(
        ({ message }) =>
          message.includes("initial calls: 2 reviewer calls") &&
          message.includes(
            "Possible structured-repair retries: up to 2 reviewer retries, plus up to 2 downstream retries when those stages run"
          ) &&
          message.includes(`Synthesizer: ${DEFAULT_SYNTHESIZER_MODEL}=high`) &&
          message.includes(`Verifier: ${DEFAULT_VERIFIER_MODEL}=high`)
      )
    ).toBe(true);
    expect(reports(runtime)).toHaveLength(1);
  });

  it("parses CLI model=level panels, normalizes duplicate IDs to one run, and fixes downstream effort at high", async () => {
    const calls = installManager();
    const runtime = changedFilesRuntime();
    const { ctx } = createCtx();
    reviewExtension(runtime.pi as never);
    await runtime.commands
      .get("review")
      ?.handler(
        "uncommitted --reviewers code-reviewer --reviewer-models test/alpha=low,test/alpha=xhigh,test/beta=off --synthesizer-model test/synth",
        ctx as never
      );
    expect(
      calls.map(({ model, thinking }) => `${model}=${thinking}`).sort()
    ).toEqual(["test/alpha=low", "test/beta=off"]);
  });

  it("keeps model-looking --extra values as review instructions", async () => {
    for (const extra of [
      "--synthesizer-model=should remain text",
      "--reviewer-models=should remain text",
    ]) {
      const calls = installManager();
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      reviewExtension(runtime.pi as never);

      await runtime.commands
        .get("review")
        ?.handler(
          `uncommitted --reviewers code-reviewer --extra "${extra}"`,
          ctx as never
        );

      expect(calls).toHaveLength(DEFAULT_REVIEWER_PANEL.length);
      expect(calls[0]?.prompt).toContain(
        `Additional user-provided review instruction:\n${extra}`
      );
      expect(
        notifications.some(({ message }) =>
          message.includes(`Synthesizer: ${DEFAULT_SYNTHESIZER_MODEL}=high`)
        )
      ).toBe(true);
    }
  });

  it("ignores legacy model settings while retaining unrelated settings", async () => {
    const calls = installManager();
    const runtime = changedFilesRuntime();
    const { ctx } = createCtx([
      {
        type: "custom",
        customType: "review-settings",
        data: {
          customInstructions: "legacy focus",
          selectedReviewers: ["code-reviewer"],
          reviewerPanel: [{ model: "missing/model", thinkingLevel: "high" }],
          synthesizerModel: "missing/model",
          verifierModel: "missing/model",
        },
      },
    ]);
    reviewExtension(runtime.pi as never);

    await runtime.commands
      .get("review")
      ?.handler("uncommitted --reviewers code-reviewer", ctx as never);

    expect(calls).toHaveLength(DEFAULT_REVIEWER_PANEL.length);
    expect(calls[0]?.prompt).toContain("legacy focus");
    expect(runtime.appendedEntries.at(-1)?.data).not.toHaveProperty(
      "reviewerPanel"
    );
  });

  it("resolves invocation-only verifier overrides against the CLI reviewer panel", async () => {
    const calls = installManager();
    const runtime = changedFilesRuntime();
    const { ctx, notifications } = createCtx([
      {
        type: "custom",
        customType: "review-settings",
        data: {
          reviewerPanel: [{ model: TEST_VERIFIER, thinkingLevel: "high" }],
        },
      },
    ]);
    reviewExtension(runtime.pi as never);

    await runtime.commands
      .get("review")
      ?.handler(
        `uncommitted --reviewers code-reviewer --reviewer-models test/alpha=high --verifier-model ${TEST_VERIFIER}`,
        ctx as never
      );

    expect(calls.map((call) => call.model)).toEqual(["test/alpha"]);
    expect(notifications.some(({ level }) => level === "error")).toBe(false);
    expect(runtime.appendedEntries).not.toContainEqual({
      type: "review-settings",
      data: expect.objectContaining({ verifierModel: TEST_VERIFIER }),
    });
  });

  it("rejects a verifier override that conflicts with the CLI reviewer panel", async () => {
    const calls = installManager();
    const runtime = changedFilesRuntime();
    const { ctx, notifications } = createCtx();
    reviewExtension(runtime.pi as never);

    await runtime.commands
      .get("review")
      ?.handler(
        `uncommitted --reviewers code-reviewer --reviewer-models ${TEST_VERIFIER}=high --verifier-model ${TEST_VERIFIER}`,
        ctx as never
      );

    expect(calls).toHaveLength(0);
    expect(
      notifications.some(
        ({ message, level }) =>
          level === "error" && message.includes("conflicts with reviewer panel")
      )
    ).toBe(true);
  });

  it("migrates a legacy verifier override that conflicts with the default panel", async () => {
    const calls = installManager();
    const runtime = changedFilesRuntime();
    const { ctx, notifications } = createCtx([
      {
        type: "custom",
        customType: "review-settings",
        data: { verifierModel: DEFAULT_REVIEWER_PANEL[0]?.model },
      },
    ]);
    reviewExtension(runtime.pi as never);

    await runtime.commands
      .get("review")
      ?.handler("uncommitted --reviewers code-reviewer", ctx as never);

    expect(calls).toHaveLength(DEFAULT_REVIEWER_PANEL.length);
    expect(
      notifications.some(({ message }) =>
        message.includes(`Verifier: ${DEFAULT_VERIFIER_MODEL}=high`)
      )
    ).toBe(true);
    expect(runtime.appendedEntries).toContainEqual({
      type: "review-settings",
      data: expect.not.objectContaining({ verifierModel: expect.any(String) }),
    });
  });

  it("rejects malformed, empty, and over-four panels before model calls", async () => {
    for (const panel of [
      "",
      "test/a=weird",
      "test/a=low,test/b=low,test/c=low,test/d=low,test/e=low",
    ]) {
      const calls = installManager();
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      reviewExtension(runtime.pi as never);
      await runtime.commands
        .get("review")
        ?.handler(
          `uncommitted --reviewers code-reviewer --reviewer-models=${panel}`,
          ctx as never
        );
      expect(calls).toHaveLength(0);
      expect(notifications.some(({ level }) => level === "error")).toBe(true);
    }
  });

  it("migrates persisted legacy settings to matrix defaults and retains legacy reviewer selection", async () => {
    const calls = installManager();
    const runtime = changedFilesRuntime();
    const { ctx } = createCtx([
      {
        type: "custom",
        customType: "review-settings",
        data: {
          selectedReviewers: ["security-reviewer"],
          reviewerSelectionMode: "manual",
        },
      },
    ]);
    reviewExtension(runtime.pi as never);
    await runtime.commands
      .get("review")
      ?.handler("uncommitted --reviewers security-reviewer", ctx as never);
    expect(
      calls
        .filter((call) => call.type === "security-reviewer")
        .map((call) => call.model)
        .sort()
    ).toEqual(DEFAULT_REVIEWER_PANEL.map((entry) => entry.model).sort());
    expect(runtime.appendedEntries.at(-1)?.data).toEqual({
      customInstructions: undefined,
      selectedReviewers: ["security-reviewer"],
      reviewerSelectionMode: "manual",
    });
  });

  it("rejects unavailable CLI models before paid calls", async () => {
    const calls = installManager();
    const runtime = changedFilesRuntime();
    const { ctx, notifications } = createCtx(
      [],
      (model) => model !== "missing/model"
    );
    reviewExtension(runtime.pi as never);
    await runtime.commands
      .get("review")
      ?.handler(
        "uncommitted --reviewers code-reviewer --reviewer-models missing/model=high",
        ctx as never
      );
    expect(calls).toHaveLength(0);
    expect(runtime.appendedEntries).toHaveLength(0);
    expect(
      notifications.some(({ message }) => message.includes("not available"))
    ).toBe(true);
  });

  it("renders review-report messages and leaves /review-fix delegation behavior intact", async () => {
    installManager();
    const summary =
      "## Review Scope\n- scope\n\n## Verdict\n- needs attention\n\n## Findings\n- finding\n\n## Fix Queue\n1. fix\n\n## Human Reviewer Callouts (Non-Blocking)\n- none\n\n## Reviewer Coverage\n- code-reviewer: used";
    const runtime = createRuntime();
    const { ctx } = createCtx([
      { type: "message", message: { role: "assistant", content: summary } },
    ]);
    reviewExtension(runtime.pi as never);
    expect(
      runtime.renderers.get(REVIEW_REPORT_MESSAGE_TYPE)?.({
        content: "## report",
      })
    ).toBeInstanceOf(Markdown);
    await runtime.commands
      .get("review-fix")
      ?.handler("keep scope", ctx as never);
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "Use the `review-fix` skill behavior as canonical."
    );
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "<untrusted_review_report>"
    );
    expect(runtime.sentUserMessages[0]?.content).toContain("keep scope");
  });
});

describe("durable structured contracts", () => {
  it("keeps synthesizer/verifier agents aligned and non-caveman", () => {
    for (const name of ["review-synthesizer", "review-verifier"]) {
      const text = readFileSync(
        path.join(process.cwd(), "agents", `${name}.md`),
        "utf8"
      );
      expect(text).toContain("caveman: false");
      expect(text).toContain("structured_output");
    }
    const synthesizer = readFileSync(
      path.join(process.cwd(), "agents/review-synthesizer.md"),
      "utf8"
    );
    expect(synthesizer).toContain("tools: none");
    expect(synthesizer).toContain(
      "Every input candidate ID must appear in exactly one cluster"
    );
    const verifier = readFileSync(
      path.join(process.cwd(), "agents/review-verifier.md"),
      "utf8"
    );
    expect(verifier).toContain("consensusEffect");
    expect(verifier).toContain("Omitted IDs are rejected candidates");
  });
});
