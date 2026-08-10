import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import diagnoseExtension, { buildDiagnoseCommandMessage } from "./index";

type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

interface CommandDefinition {
  handler: CommandHandler;
}

interface Notification {
  message: string;
  level: string;
}

interface SentUserMessage {
  content: string;
  options?: unknown;
}

const DIAGNOSE_INVOCATION_PREAMBLE =
  "Use the `diagnose` skill behavior as canonical.\n\nDiagnose invocation packet:";
const HITL_LOOP_SCRIPT = join(
  import.meta.dir,
  "..",
  "..",
  "skills",
  "diagnose",
  "scripts",
  "hitl-loop.template.sh"
);

function expectedDiagnoseCommandMessage(request: string): string {
  return `${DIAGNOSE_INVOCATION_PREAMBLE}\n- Diagnosis request: ${request}`;
}

function createMockCtx(isIdle = true) {
  const notifications: Notification[] = [];

  return {
    notifications,
    ctx: {
      isIdle: () => isIdle,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  };
}

function createMockPiRuntime() {
  const commands = new Map<string, CommandDefinition>();
  const sentUserMessages: SentUserMessage[] = [];

  return {
    commands,
    sentUserMessages,
    pi: {
      registerCommand(name: string, definition: CommandDefinition) {
        commands.set(name, definition);
      },
      sendUserMessage(content: string, options?: unknown) {
        sentUserMessages.push({ content, options });
      },
    },
  };
}

function getCommandHandler(
  commands: Map<string, CommandDefinition>,
  name: string
): CommandHandler {
  const command = commands.get(name);

  if (!command) {
    throw new Error(`Expected /${name} to be registered`);
  }

  return command.handler;
}

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8").trim();
}

function readPackageJson(): { pi: { extensions: string[] } } {
  return JSON.parse(readRepoFile("package.json"));
}

describe("diagnose command", () => {
  it("registers the diagnose extension in package.json", () => {
    const packageJson = readPackageJson();

    expect(packageJson.pi.extensions).toContain("./extensions/diagnose");
  });

  it("registers /diagnose", () => {
    const runtime = createMockPiRuntime();

    diagnoseExtension(runtime.pi as never);

    expect([...runtime.commands.keys()]).toEqual(["diagnose"]);
  });

  it("builds a diagnosis invocation packet with the supplied request", () => {
    const message = buildDiagnoseCommandMessage("  export button crashes  ");

    expect(message).toBe(
      expectedDiagnoseCommandMessage("export button crashes")
    );
  });

  it("builds a current-session invocation packet when args are empty", () => {
    const message = buildDiagnoseCommandMessage("   ");

    expect(message).toBe(expectedDiagnoseCommandMessage("current session"));
  });

  it("sends the diagnose prompt immediately when idle", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    diagnoseExtension(runtime.pi as never);
    const handler = getCommandHandler(runtime.commands, "diagnose");

    await handler("export button crashes", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildDiagnoseCommandMessage("export button crashes"),
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("queues the diagnose prompt as a follow-up when busy", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx(false);

    diagnoseExtension(runtime.pi as never);
    const handler = getCommandHandler(runtime.commands, "diagnose");

    await handler("export button crashes", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildDiagnoseCommandMessage("export button crashes"),
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toContainEqual({
      message: "Queued /diagnose as a follow-up",
      level: "info",
    });
  });

  it("keeps durable upstream credits in the diagnose docs", () => {
    const skill = readRepoFile("skills", "diagnose", "SKILL.md");
    const readme = readRepoFile("extensions", "diagnose", "README.md");

    for (const doc of [skill, readme]) {
      expect(doc).toContain("Matt Pocock");
      expect(doc).toContain("MIT");
      expect(doc).toContain(
        "https://github.com/mattpocock/skills/blob/694fa30311e02c2639942308513555e61ee84a6f/skills/engineering/diagnose/SKILL.md"
      );
      expect(doc).toContain("694fa30311e02c2639942308513555e61ee84a6f");
      expect(doc).toContain(
        "https://github.com/mattpocock/skills/tree/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/engineering/diagnosing-bugs"
      );
      expect(doc).toContain("84fdeffd12f2ee307994d1eb6feb48173b6e0502");
      expect(doc).toContain("LegendApp");
      expect(doc).toContain(
        "https://github.com/LegendApp/legend-skills/tree/main/diagnose"
      );
      expect(doc).toContain("5a4be517989496d0bc59520a93976360dd1bff51");
    }
  });

  it("locks the red-capable feedback-loop gate and reproduction playbook", () => {
    const skill = readRepoFile("skills", "diagnose", "SKILL.md");
    const reproductionLoops = readRepoFile(
      "skills",
      "diagnose",
      "references",
      "reproduction-loops.md"
    );
    const hitlLoop = readRepoFile(
      "skills",
      "diagnose",
      "scripts",
      "hitl-loop.template.sh"
    );

    expect(skill).toContain(
      "[references/reproduction-loops.md](references/reproduction-loops.md)"
    );
    expect(skill).toContain("one command");
    expect(skill).toContain("already run");
    for (const criterion of [
      "Red-capable",
      "Deterministic",
      "Fast",
      "Agent-runnable",
    ]) {
      expect(skill).toContain(criterion);
    }
    expect(reproductionLoops).toContain("Failing test");
    expect(reproductionLoops).toContain("Differential or bisection loop");
    expect(reproductionLoops).toContain("Discovery amplification is not proof");
    expect(reproductionLoops).toContain("scripts/hitl-loop.template.sh");
    expect(reproductionLoops).toContain(
      "Pi's bash executor has no interactive stdin"
    );
    expect(reproductionLoops).toContain("private directory");
    expect(reproductionLoops).toContain("path literally");
    expect(reproductionLoops).toContain("removes them after consuming");
    expect(reproductionLoops).toContain(
      "a placeholder, or any other shell expression"
    );
    expect(hitlLoop).toContain("Never capture secrets");
    expect(hitlLoop).toContain("--- Captured ---");
  });

  it("derives and consumes a private HITL observation handoff", () => {
    const runId = `diag-test-${process.pid}`;
    const handoffDirectory = `/tmp/supa-pi-diagnose-${process.getuid()}-${runId}`;
    const observationFile = join(handoffDirectory, "observation.txt");
    const injectedFile = join(tmpdir(), `supa-pi-hitl-injected-${process.pid}`);
    const observation = `redacted'; touch ${injectedFile}; printf '`;
    rmSync(handoffDirectory, { force: true, recursive: true });
    rmSync(injectedFile, { force: true });
    mkdirSync(handoffDirectory, { mode: 0o700 });
    writeFileSync(observationFile, observation);

    try {
      const result = spawnSync(
        "bash",
        [HITL_LOOP_SCRIPT, "--reproduced", "y", "--run-id", runId],
        { input: "", encoding: "utf8" }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("REPRODUCED=y");
      expect(result.stdout).toContain(`OBSERVATION=${observation}`);
      expect(existsSync(injectedFile)).toBe(false);
      expect(existsSync(observationFile)).toBe(false);
      expect(existsSync(handoffDirectory)).toBe(false);
    } finally {
      rmSync(handoffDirectory, { force: true, recursive: true });
      rmSync(injectedFile, { force: true });
    }
  });

  it("rejects and preserves a multiline HITL observation handoff", () => {
    const runId = `diag-multiline-${process.pid}`;
    const handoffDirectory = `/tmp/supa-pi-diagnose-${process.getuid()}-${runId}`;
    const observationFile = join(handoffDirectory, "observation.txt");
    const malformedObservation = "first\n\nthird\n";
    rmSync(handoffDirectory, { force: true, recursive: true });
    mkdirSync(handoffDirectory, { mode: 0o700 });
    writeFileSync(observationFile, malformedObservation);

    try {
      const result = spawnSync("bash", [
        HITL_LOOP_SCRIPT,
        "--reproduced",
        "y",
        "--run-id",
        runId,
      ]);

      expect(result.status).toBe(2);
      expect(readFileSync(observationFile, "utf8")).toBe(malformedObservation);
    } finally {
      rmSync(handoffDirectory, { force: true, recursive: true });
    }
  });

  it("rejects and preserves an unrelated caller-selected observation file", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "supa-pi-hitl-"));
    const unrelatedFile = join(temporaryDirectory, "important.txt");
    writeFileSync(unrelatedFile, "keep this unchanged\n");

    try {
      const result = spawnSync("bash", [
        HITL_LOOP_SCRIPT,
        "--reproduced",
        "y",
        "--observation-file",
        unrelatedFile,
      ]);

      expect(result.status).toBe(2);
      expect(readFileSync(unrelatedFile, "utf8")).toBe("keep this unchanged\n");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("isolates and consumes concurrent HITL observation handoffs", async () => {
    const runIds = ["a", "b"].map(
      (suffix) => `diag-concurrent-${process.pid}-${suffix}`
    );
    const handoffDirectories = runIds.map(
      (runId) => `/tmp/supa-pi-diagnose-${process.getuid()}-${runId}`
    );
    const observationFiles = handoffDirectories.map((directory) =>
      join(directory, "observation.txt")
    );
    const observations = ["redacted observation A", "redacted observation B"];
    for (const [index, path] of observationFiles.entries()) {
      rmSync(handoffDirectories[index] ?? "", { force: true, recursive: true });
      mkdirSync(handoffDirectories[index] ?? "", { mode: 0o700 });
      writeFileSync(path, observations[index] ?? "");
    }

    try {
      const outputs = await Promise.all(
        runIds.map(
          (runId) =>
            new Promise<string>((resolve, reject) => {
              const child = spawn("bash", [
                HITL_LOOP_SCRIPT,
                "--reproduced",
                "y",
                "--run-id",
                runId,
              ]);
              let stdout = "";
              let stderr = "";
              child.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
              });
              child.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
              });
              child.on("error", reject);
              child.on("close", (code) => {
                if (code === 0) {
                  resolve(stdout);
                } else {
                  reject(new Error(stderr));
                }
              });
            })
        )
      );

      expect(outputs[0]).toContain(`OBSERVATION=${observations[0]}`);
      expect(outputs[0]).not.toContain(observations[1]);
      expect(outputs[1]).toContain(`OBSERVATION=${observations[1]}`);
      expect(outputs[1]).not.toContain(observations[0]);
      for (const path of observationFiles) {
        expect(existsSync(path)).toBe(false);
      }
      for (const directory of handoffDirectories) {
        expect(existsSync(directory)).toBe(false);
      }
    } finally {
      for (const directory of handoffDirectories) {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  });

  it("requires a visible candidate checkpoint and post-fix prevention review", () => {
    const skill = readRepoFile("skills", "diagnose", "SKILL.md");

    expect(skill).toContain(
      "Show the ranked candidate table in the main thread before probing"
    );
    expect(skill).toContain("Candidate | Evidence for/against | Prediction");
    expect(skill).toContain("After `Fix: Verified`");
    expect(skill).toContain("/improve-codebase-architecture");
  });

  it("locks the explicit post-Proven fix gate in the canonical skill", () => {
    const skill = readRepoFile("skills", "diagnose", "SKILL.md");

    expect(skill).toContain("Diagnosis: Proven | Incomplete");
    expect(skill).toContain("Fix: Verified | Failed | Not attempted");
    expect(skill).toContain(
      "Incomplete` never offers, recommends, or applies a fix"
    );
    expect(skill).toContain("Approve scoped fix");
    expect(skill).toContain("Stop and clean probes");
    expect(skill).toContain("do not use `multiSelect`");
    expect(skill).toContain("Invocation wording");
    expect(skill).toContain(
      "If the questionnaire cannot be used, do not infer approval or edit the fix; report the blocked gate and print both exact choices `Approve scoped fix` and `Stop and clean probes` verbatim."
    );
    expect(skill).toContain("requires a new proposal and the same gate again");
  });

  it("requires cleanup before every terminal incomplete report", () => {
    const skill = readRepoFile("skills", "diagnose", "SKILL.md");
    const instrumentation = readRepoFile(
      "skills",
      "diagnose",
      "references",
      "instrumentation.md"
    );

    for (const document of [skill, instrumentation]) {
      expect(document).toContain(
        "terminal `Diagnosis: Incomplete` / `Fix: Not attempted` report"
      );
      expect(document).toContain("explicit");
      expect(document).toContain("retain");
    }
  });

  it("locks explicit-only activation and invocation-scoped probe authorization", () => {
    const skill = readRepoFile("skills", "diagnose", "SKILL.md");
    const instrumentation = readRepoFile(
      "skills",
      "diagnose",
      "references",
      "instrumentation.md"
    );

    expect(skill).toContain(
      "Do not activate it for an ordinary bug report, debugging request, or fix request."
    );
    expect(skill).toContain(
      "do not ask a second consent question for those probes"
    );
    expect(skill).toContain("Separate user approval remains mandatory");
    expect(instrumentation).toContain(
      "An explicit Diagnose invocation already authorizes reversible, behavior-neutral temporary probes"
    );
    expect(instrumentation).not.toContain("Before requesting scoped consent");
  });

  it("keeps operational instrumentation guidance linked from the skill", () => {
    const skill = readRepoFile("skills", "diagnose", "SKILL.md");
    const instrumentation = readRepoFile(
      "skills",
      "diagnose",
      "references",
      "instrumentation.md"
    );

    expect(skill).toContain(
      "[references/instrumentation.md](references/instrumentation.md)"
    );
    expect(instrumentation).toContain("Default deny every field");
    expect(instrumentation).toContain(
      "Never collect secrets, tokens, credentials"
    );
  });
});
