import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
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
        "https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnose"
      );
      expect(doc).toContain("LegendApp");
      expect(doc).toContain(
        "https://github.com/LegendApp/legend-skills/tree/main/diagnose"
      );
      expect(doc).toContain("5a4be517989496d0bc59520a93976360dd1bff51");
    }
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
