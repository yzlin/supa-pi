import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
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
import type { PublicReviewWorkflowInput } from "./public-workflow";
import {
  DEFAULT_REVIEWER_PANEL,
  DEFAULT_SYNTHESIZER_MODEL,
  DEFAULT_VERIFIER_MODEL,
  REVIEW_REPORT_MESSAGE_TYPE,
} from "./workflow";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
  content?: string;
  details?: unknown;
  message?: { role: string; content: string };
}

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
  execFileSync("git", ["init", "-q", testProjectCwd]);
  await fs.writeFile(path.join(testProjectCwd, "target.txt"), "original");
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
  const sessionManager = SessionManager.inMemory(testProjectCwd);
  for (const entry of entries) {
    if (entry.type === "custom_message") {
      sessionManager.appendCustomMessageEntry(
        entry.customType!,
        entry.content ?? "",
        true,
        entry.details
      );
    } else if (entry.type === "custom") {
      sessionManager.appendCustomEntry(entry.customType!, entry.data);
    } else if (entry.message) {
      sessionManager.appendMessage(entry.message as never);
    }
  }
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
      scopedModels: [] as Array<{
        model: { provider: string; id: string };
        thinkingLevel?: string;
      }>,
      modelRegistry: {
        find(provider: string, id: string) {
          return available(`${provider}/${id}`) ? { provider, id } : undefined;
        },
        hasConfiguredAuth() {
          return true;
        },
      },
      sessionManager,
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
  const tools = new Map<string, unknown>();
  const eventHandlers = new Map<
    string,
    (event: unknown, ctx: unknown) => unknown
  >();
  const preparedScripts: string[] = [];
  let commandContext: unknown;
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const sentMessages: Array<{
    message: Record<string, unknown>;
    options?: unknown;
  }> = [];
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
  const renderers = new Map<
    string,
    (
      message: unknown,
      options: { expanded: boolean; outputPad: number }
    ) => unknown
  >();
  return {
    commands,
    preparedScripts,
    appendedEntries,
    sentMessages,
    sentUserMessages,
    renderers,
    pi: {
      registerTool(definition: { name: string }) {
        tools.set(definition.name, definition);
      },
      exec: async (command: string, args: string[]) => exec(command, args),
      registerCommand(
        name: string,
        definition: {
          handler: (args: string, ctx: unknown) => Promise<void> | void;
        }
      ) {
        commands.set(name, {
          ...definition,
          handler(args, ctx) {
            commandContext = ctx;
            return definition.handler(args, ctx);
          },
        });
      },
      registerMessageRenderer(
        type: string,
        renderer: (
          message: unknown,
          options: { expanded: boolean; outputPad: number }
        ) => unknown
      ) {
        renderers.set(type, renderer);
      },
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        eventHandlers.set(name, handler);
      },
      appendEntry(type: string, data: unknown) {
        appendedEntries.push({ type, data });
      },
      sendMessage(message: Record<string, unknown>, options?: unknown) {
        sentMessages.push({ message, options });
      },
      sendUserMessage(content: string, options?: unknown) {
        sentUserMessages.push({ content, options });
        const encoded = content.split(
          "\nPrepared script (JSON string, inert data):\n"
        )[1];
        if (encoded) {
          const input = { script: JSON.parse(encoded) as string };
          const blocked = eventHandlers.get("tool_call")?.(
            {
              toolName: "SubagentWorkflow",
              toolCallId: `call-${preparedScripts.length}`,
              input,
            },
            commandContext
          );
          expect(blocked).toBeUndefined();
          preparedScripts.push(input.script);
        }
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
  execFileSync("git", ["init", "-q", cwd]);
  await fs.writeFile(path.join(cwd, "target.txt"), "original");
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
  it("keeps Astra reviewers and verifier while defaulting synthesis to Luna", () => {
    expect(DEFAULT_REVIEWER_PANEL).toEqual([
      { model: "openai-codex/gpt-6-astra", thinkingLevel: "medium" },
    ]);
    expect(DEFAULT_SYNTHESIZER_MODEL).toBe("openai-codex/gpt-6-luna");
    expect(DEFAULT_VERIFIER_MODEL).toBe("openai-codex/gpt-6-astra");
  });

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

  it("identifies invalid files and fields while allowing verifier overlap", async () => {
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
      expect((await resolveReviewConfig(cwd)).effective.verifierModel).toBe(
        "same/model"
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
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      ctx.cwd = cwd;
      reviewExtension(runtime.pi as never);

      await expect(
        runtime.commands.get("review")?.handler("", ctx as never)
      ).resolves.toBeUndefined();

      expect(preparedCalls(runtime)).toHaveLength(0);
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
        const runtime = changedFilesRuntime();
        const { ctx, notifications } = createCtx();
        ctx.cwd = cwd;
        reviewExtension(runtime.pi as never);

        await runtime.commands.get("review")?.handler(args, ctx as never);

        expect(preparedCalls(runtime)).toHaveLength(0);
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

  it("allows reviewer and verifier overlap across config layers", async () => {
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
      expect((await resolveReviewConfig(cwd)).effective).toEqual(
        expect.objectContaining({
          reviewerPanel: [{ model: TEST_VERIFIER, thinkingLevel: "high" }],
          verifierModel: TEST_VERIFIER,
        })
      );

      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      ctx.cwd = cwd;
      ctx.ui.confirm = async () => true;
      reviewExtension(runtime.pi as never);
      await runtime.commands
        .get("review")
        ?.handler("uncommitted --reviewers code-reviewer", ctx as never);

      expect(preparedCalls(runtime).map(({ model }) => model)).toEqual([
        TEST_VERIFIER,
      ]);
      expect(notifications.some(({ level }) => level === "error")).toBe(false);
    });
  });

  it("fails closed headlessly for an unapproved project hash with zero calls", async () => {
    await withReviewConfigSandbox(async (cwd) => {
      await writeReviewConfigField(
        await getProjectReviewConfigPath(cwd),
        "synthesizerModel",
        TEST_SYNTHESIZER
      );
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      ctx.cwd = cwd;
      ctx.hasUI = false;
      reviewExtension(runtime.pi as never);
      await runtime.commands
        .get("review")
        ?.handler("uncommitted --reviewers code-reviewer", ctx as never);

      expect(preparedCalls(runtime)).toHaveLength(0);
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

      expect(preparedCalls(runtime)).toHaveLength(1);
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

      expect(preparedCalls(runtime)).toHaveLength(0);
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

      expect(preparedCalls(runtime)).toHaveLength(1);
      expect(disclosure).toContain("reviewer test/flag-reviewer");
      expect(disclosure).toContain("verifier project/disclosed-verifier");
      expect(disclosure).not.toContain("project/hidden-reviewer");
      expect(
        await isProjectReviewConfigApproved(
          (await resolveReviewConfig(cwd)).project
        )
      ).toBe(false);

      await runtime.commands.get("review")?.handler("cancel", ctx);
      ctx.hasUI = false;
      await runtime.commands
        .get("review")
        ?.handler("uncommitted --reviewers code-reviewer", ctx as never);

      expect(preparedCalls(runtime)).toHaveLength(1);
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
      expect(preparedCalls(runtime)).toHaveLength(
        DEFAULT_REVIEWER_PANEL.length
      );
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

      expect(preparedCalls(runtime)).toHaveLength(1);
      expect(
        await isProjectReviewConfigApproved(
          (await resolveReviewConfig(cwd)).project
        )
      ).toBe(false);
    });
  });
});

describe.serial("/review command settings and disclosure", () => {
  it("passes the normal default panel and emits planned-call/provider disclosure", async () => {
    const runtime = changedFilesRuntime();
    const { ctx, notifications } = createCtx();
    reviewExtension(runtime.pi as never);
    await runtime.commands
      .get("review")
      ?.handler("uncommitted --reviewers code-reviewer", ctx as never);
    expect(
      preparedCalls(runtime)
        .map((call) => call.model)
        .sort()
    ).toEqual(DEFAULT_REVIEWER_PANEL.map((entry) => entry.model).sort());
    expect(
      notifications.some(
        ({ message }) =>
          message.includes("initial calls: 1 reviewer call") &&
          message.includes(
            "Possible structured-repair retries: up to 1 reviewer retry, plus up to 2 downstream retries when those stages run"
          ) &&
          message.includes(
            `Synthesizer: ${DEFAULT_SYNTHESIZER_MODEL}=medium`
          ) &&
          message.includes(`Verifier: ${DEFAULT_VERIFIER_MODEL}=medium`)
      )
    ).toBe(true);
    expect(reports(runtime)).toHaveLength(0);
    expect(runtime.sentUserMessages).toHaveLength(1);
  });

  it("parses CLI model=level panels, normalizes duplicate IDs to one run, and fixes downstream effort at medium", async () => {
    const runtime = changedFilesRuntime();
    const { ctx } = createCtx();
    reviewExtension(runtime.pi as never);
    await runtime.commands
      .get("review")
      ?.handler(
        "uncommitted --reviewers code-reviewer --reviewer-models test/alpha=low,test/alpha=xhigh,test/beta=minimal --synthesizer-model test/synth",
        ctx as never
      );
    expect(
      preparedCalls(runtime)
        .map(({ model, thinking }) => `${model}=${thinking}`)
        .sort()
    ).toEqual(["test/alpha=low", "test/beta=minimal"]);
  });

  it("keeps model-looking --extra values as review instructions", async () => {
    for (const extra of [
      "--synthesizer-model=should remain text",
      "--reviewer-models=should remain text",
    ]) {
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      reviewExtension(runtime.pi as never);

      await runtime.commands
        .get("review")
        ?.handler(
          `uncommitted --reviewers code-reviewer --extra "${extra}"`,
          ctx as never
        );

      expect(preparedCalls(runtime)).toHaveLength(
        DEFAULT_REVIEWER_PANEL.length
      );
      expect(preparedCalls(runtime)[0]?.prompt).toContain(
        `Additional user-provided review instruction:\n${extra}`
      );
      expect(
        notifications.some(({ message }) =>
          message.includes(`Synthesizer: ${DEFAULT_SYNTHESIZER_MODEL}=medium`)
        )
      ).toBe(true);
    }
  });

  it("ignores legacy model settings while retaining unrelated settings", async () => {
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

    expect(preparedCalls(runtime)).toHaveLength(DEFAULT_REVIEWER_PANEL.length);
    expect(preparedCalls(runtime)[0]?.prompt).toContain("legacy focus");
    expect(runtime.appendedEntries.at(-1)?.data).not.toHaveProperty(
      "reviewerPanel"
    );
  });

  it("resolves invocation-only verifier overrides against the CLI reviewer panel", async () => {
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

    expect(preparedCalls(runtime).map((call) => call.model)).toEqual([
      "test/alpha",
    ]);
    expect(notifications.some(({ level }) => level === "error")).toBe(false);
    expect(runtime.appendedEntries).not.toContainEqual({
      type: "review-settings",
      data: expect.objectContaining({ verifierModel: TEST_VERIFIER }),
    });
  });

  it("allows a verifier override matching the CLI reviewer panel", async () => {
    const runtime = changedFilesRuntime();
    const { ctx, notifications } = createCtx();
    reviewExtension(runtime.pi as never);

    await runtime.commands
      .get("review")
      ?.handler(
        `uncommitted --reviewers code-reviewer --reviewer-models ${TEST_VERIFIER}=high --verifier-model ${TEST_VERIFIER}`,
        ctx as never
      );

    expect(preparedCalls(runtime).map(({ model }) => model)).toEqual([
      TEST_VERIFIER,
    ]);
    expect(notifications.some(({ level }) => level === "error")).toBe(false);
  });

  it("ignores a legacy verifier override matching the default panel", async () => {
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

    expect(preparedCalls(runtime)).toHaveLength(DEFAULT_REVIEWER_PANEL.length);
    expect(
      notifications.some(({ message }) =>
        message.includes(`Verifier: ${DEFAULT_VERIFIER_MODEL}=medium`)
      )
    ).toBe(true);
    expect(runtime.appendedEntries).toContainEqual({
      type: "review-settings",
      data: expect.not.objectContaining({ verifierModel: expect.any(String) }),
    });
  });

  it("rejects off before handoff without leaving a pending review", async () => {
    const runtime = changedFilesRuntime();
    const { ctx, notifications } = createCtx();
    reviewExtension(runtime.pi as never);
    await runtime.commands
      .get("review")
      ?.handler(
        "uncommitted --reviewers code-reviewer --reviewer-models test/alpha=off",
        ctx as never
      );
    expect(runtime.sentUserMessages).toHaveLength(0);
    expect(
      notifications.some(({ message }) =>
        message.includes("choose minimal, low, medium, high, or xhigh")
      )
    ).toBe(true);
    await runtime.commands
      .get("review")
      ?.handler(
        "uncommitted --reviewers code-reviewer --reviewer-models test/alpha=low",
        ctx as never
      );
    expect(runtime.sentUserMessages).toHaveLength(1);
  });

  it("rejects malformed, empty, and over-four panels before model calls", async () => {
    for (const panel of [
      "",
      "test/a=weird",
      "test/a=low,test/b=low,test/c=low,test/d=low,test/e=low",
    ]) {
      const runtime = changedFilesRuntime();
      const { ctx, notifications } = createCtx();
      reviewExtension(runtime.pi as never);
      await runtime.commands
        .get("review")
        ?.handler(
          `uncommitted --reviewers code-reviewer --reviewer-models=${panel}`,
          ctx as never
        );
      expect(preparedCalls(runtime)).toHaveLength(0);
      expect(notifications.some(({ level }) => level === "error")).toBe(true);
    }
  });

  it("migrates persisted legacy settings to matrix defaults and retains legacy reviewer selection", async () => {
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
      preparedCalls(runtime)
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
    expect(preparedCalls(runtime)).toHaveLength(0);
    expect(runtime.appendedEntries).toHaveLength(0);
    expect(
      notifications.some(({ message }) => message.includes("not available"))
    ).toBe(true);
  });

  it("renders review-report messages and leaves /review-fix delegation behavior intact", async () => {
    const summary =
      "## Review Scope\n- scope\n\n## Verdict\n- needs attention\n\n## Findings\n- finding\n\n## Fix Queue\n1. fix\n\n## Human Reviewer Callouts (Non-Blocking)\n- none\n\n## Reviewer Coverage\n- code-reviewer: used";
    const runtime = createRuntime();
    const { ctx } = createCtx([
      {
        type: "custom_message",
        customType: REVIEW_REPORT_MESSAGE_TYPE,
        content: summary,
      },
    ]);
    reviewExtension(runtime.pi as never);
    expect(
      runtime.renderers.get(REVIEW_REPORT_MESSAGE_TYPE)?.(
        { content: "## report" },
        { expanded: false, outputPad: 1 }
      )
    ).toBeInstanceOf(Markdown);
    await runtime.commands
      .get("review-fix")
      ?.handler("keep scope", ctx as never);
    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain(
      "Use the `review-fix` skill behavior as canonical."
    );
    expect(message).not.toContain("<untrusted_review_report>");
    expect(message).toContain(
      "Report delivery: already present in active model context; not duplicated here."
    );
    expect(message).toContain(
      "<untrusted_review_fix_context>\n## Verdict\n- needs attention\n\n## Findings\n- finding\n\n## Fix Queue\n1. fix\n</untrusted_review_fix_context>"
    );
    expect(message).not.toContain("Human Reviewer Callouts");
    expect(message).not.toContain("Reviewer Coverage");
    expect(message).toContain("keep scope");
  });
});

function preparedPlans(runtime: ReturnType<typeof createRuntime>) {
  return runtime.preparedScripts.map((source) => {
    const line = source
      .split("\n")
      .find((value) => value.startsWith("const reviewInput = "))!;
    const plan = JSON.parse(
      line.slice("const reviewInput = ".length, -1)
    ) as PublicReviewWorkflowInput;
    expect(source).toContain('effort: "medium"');
    return plan;
  });
}

function preparedCalls(runtime: ReturnType<typeof createRuntime>) {
  return preparedPlans(runtime).flatMap((plan) =>
    plan.reviewers.flatMap((type) =>
      plan.reviewerPanel.map(({ model, thinkingLevel }) => ({
        type,
        model,
        thinking: thinkingLevel,
        prompt: plan.invocationPacket,
      }))
    )
  );
}

for (const failure of ["scope", "auth"]) {
  it(`preflights ${failure} before native handoff`, async () => {
    const runtime = changedFilesRuntime();
    const { ctx, notifications } = createCtx();
    if (failure === "scope") {
      ctx.scopedModels = [{ model: { provider: "other", id: "model" } }];
    } else {
      ctx.modelRegistry.hasConfiguredAuth = () => false;
    }
    reviewExtension(runtime.pi as never);
    await runtime.commands
      .get("review")
      ?.handler("uncommitted --reviewers code-reviewer", ctx);
    expect(runtime.sentUserMessages).toEqual([]);
    expect(
      notifications.some(({ message }) =>
        message.includes(
          failure === "scope"
            ? "outside the current model scope"
            : "authentication is not configured"
        )
      )
    ).toBe(true);
  });
}

it("locks explicit role/model/default downstream configuration into prepared source", async () => {
  const runtime = changedFilesRuntime();
  const { ctx } = createCtx();
  reviewExtension(runtime.pi as never);
  await runtime.commands
    .get("review")
    ?.handler(
      "uncommitted --reviewers code-reviewer,security-reviewer --reviewer-models test/alpha=high,test/beta=xhigh --synthesizer-model test/explicit-synth --verifier-model test/explicit-verify",
      ctx
    );
  expect(preparedPlans(runtime)[0]).toMatchObject({
    reviewers: ["code-reviewer", "security-reviewer"],
    reviewerPanel: [
      { model: "test/alpha", thinkingLevel: "high" },
      { model: "test/beta", thinkingLevel: "xhigh" },
    ],
    synthesizerModel: "test/explicit-synth",
    verifierModel: "test/explicit-verify",
  });
  expect(preparedCalls(runtime)).toHaveLength(4);
  await runtime.commands.get("review")?.handler("cancel", ctx);
  await runtime.commands
    .get("review")
    ?.handler("uncommitted --reviewers code-reviewer", ctx);
  expect(preparedPlans(runtime).at(-1)).toMatchObject({
    reviewerPanel: DEFAULT_REVIEWER_PANEL,
    synthesizerModel: DEFAULT_SYNTHESIZER_MODEL,
    verifierModel: DEFAULT_VERIFIER_MODEL,
  });
  expect(runtime.appendedEntries.at(-1)?.data).not.toHaveProperty(
    "reviewerPanel"
  );
});
