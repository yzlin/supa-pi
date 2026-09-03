import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import promptCommandsExtension, {
  buildPromptCommandMessage,
  createPromptCommandsExtension,
} from "./index";

const expectedMessages = {
  "grill-me": (args: string) =>
    `Use the \`grill-me\` wrapper skill as canonical for this explicit command.\n\nPlan:\n${args}`,
  "research-brief": (args: string) =>
    `Research the following topic in strict evidence mode:\n\n${args}\n\nRequirements:\n- Do not guess.\n- Cite every factual claim.\n- Prefer primary or official sources.\n- Quote relevant passages before analyzing documents.\n- Separate verified facts from inferences.\n- If evidence is missing or conflicting, say so clearly.\n\nOutput:\n1. Short answer\n2. Evidence\n3. Open uncertainties\n4. Sources`,
  "show-me": (args: string) =>
    `Use the \`showing-me\` skill as canonical for this explicit command.\n\nTopic:\n${args}`,
} as const;

type CommandName = keyof typeof expectedMessages;

const rawArgument =
  "  # Heading 'one' and \"two\"\n\n    - nested item\n      - child\n\n```ts\nconst quote = 'raw';\n```\n\ntrailing spaces stay   \n\n  ";
const image: ImageContent = {
  type: "image",
  data: "aGVsbG8=",
  mimeType: "image/png",
};
const temporaryDirectories: string[] = [];
const activeSessions: Array<{
  extensionRunner: {
    emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<void>;
  };
  dispose(): void;
}> = [];

afterEach(async () => {
  for (const session of activeSessions.splice(0)) {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createSession(
  inputEvents: unknown[],
  extension: (pi: ExtensionAPI) => void = promptCommandsExtension
) {
  const directory = await mkdtemp(join(tmpdir(), "prompt-commands-"));
  temporaryDirectories.push(directory);
  const observer = (pi: ExtensionAPI) => {
    pi.on("input", (event) => {
      inputEvents.push(event);
      return { action: "continue" };
    });
  };
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [observer, extension],
    additionalPromptTemplatePaths: [
      join(import.meta.dir, "..", "..", "prompts"),
    ],
  });
  await loader.reload();
  const result = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(directory),
    settingsManager: SettingsManager.inMemory(),
  });
  activeSessions.push(
    result.session as unknown as (typeof activeSessions)[number]
  );
  return { loader, session: result.session };
}

describe("raw prompt pipeline commands", () => {
  it("round-trips rich raw arguments without trimming or tokenizing", () => {
    for (const name of Object.keys(expectedMessages) as CommandName[]) {
      expect(buildPromptCommandMessage(name, rawArgument)).toBe(
        expectedMessages[name](rawArgument)
      );
    }
  });

  it("preserves RPC input metadata and images while queueing a streaming prompt", async () => {
    const inputEvents: unknown[] = [];
    const { session } = await createSession(inputEvents);
    const queued: unknown[] = [];
    const agent = session.agent as unknown as {
      steer(message: unknown): void;
    };
    agent.steer = (message) => queued.push(message);
    (session as unknown as { _isAgentRunActive: boolean })._isAgentRunActive =
      true;

    await session.prompt(`/show-me ${rawArgument}`, {
      images: [image],
      source: "rpc",
      streamingBehavior: "steer",
    });

    expect(inputEvents).toEqual([
      expect.objectContaining({
        text: `/show-me ${rawArgument}`,
        images: [image],
        source: "rpc",
        streamingBehavior: "steer",
      }),
    ]);
    expect(queued).toEqual([
      expect.objectContaining({
        content: [
          { type: "text", text: expectedMessages["show-me"](rawArgument) },
          image,
        ],
      }),
    ]);
    session.dispose();
  });

  it("honors prompt-template opt-out and extension-origin literal messages", async () => {
    const inputEvents: unknown[] = [];
    const { session } = await createSession(inputEvents);
    const queued: unknown[] = [];
    const agent = session.agent as unknown as {
      steer(message: unknown): void;
    };
    agent.steer = (message) => queued.push(message);
    (session as unknown as { _isAgentRunActive: boolean })._isAgentRunActive =
      true;

    for (const text of [
      `/show-me ${rawArgument}`,
      `/grill-me\n${rawArgument}`,
    ]) {
      await session.prompt(text, {
        expandPromptTemplates: false,
        images: [image],
        source: "rpc",
        streamingBehavior: "steer",
      });
    }
    await session.sendUserMessage(
      [{ type: "text", text: `/research-brief\t${rawArgument}` }, image],
      { deliverAs: "steer" }
    );

    const literalTexts = [
      `/show-me ${rawArgument}`,
      `/grill-me\n${rawArgument}`,
      `/research-brief\t${rawArgument}`,
    ];
    expect(inputEvents).toEqual([
      expect.objectContaining({
        text: literalTexts[0],
        images: [image],
        source: "rpc",
        streamingBehavior: "steer",
      }),
      expect.objectContaining({
        text: literalTexts[1],
        images: [image],
        source: "rpc",
        streamingBehavior: "steer",
      }),
      expect.objectContaining({
        text: literalTexts[2],
        images: [image],
        source: "extension",
        streamingBehavior: "steer",
      }),
    ]);
    expect(
      queued.map(
        (message) =>
          (message as { content: Array<{ text?: string }> }).content[0]?.text
      )
    ).toEqual(literalTexts);
    expect(
      queued.map(
        (message) =>
          (message as { content: Array<{ type: string }> }).content[1]
      )
    ).toEqual([image, image, image]);
    session.dispose();
  });

  it("keeps direct steer and followUp queue paths multiline-safe and image-safe", async () => {
    const { session } = await createSession([]);
    const steering: unknown[] = [];
    const followUps: unknown[] = [];
    const agent = session.agent as unknown as {
      steer(message: unknown): void;
      followUp(message: unknown): void;
    };
    agent.steer = (message) => steering.push(message);
    agent.followUp = (message) => followUps.push(message);

    await session.steer(`/grill-me ${rawArgument}`, [image]);
    await session.followUp(`/research-brief ${rawArgument}`, [image]);

    expect(steering).toEqual([
      expect.objectContaining({
        content: [
          { type: "text", text: expectedMessages["grill-me"](rawArgument) },
          image,
        ],
      }),
    ]);
    expect(followUps).toEqual([
      expect.objectContaining({
        content: [
          {
            type: "text",
            text: expectedMessages["research-brief"](rawArgument),
          },
          image,
        ],
      }),
    ]);
    session.dispose();
  });

  it("preserves native newline and tab delimiters across prompt, steer, and followUp", async () => {
    for (const name of Object.keys(expectedMessages) as CommandName[]) {
      for (const delimiter of ["\n", "\t"]) {
        const argument = `${delimiter}  indented\n\n    child`;
        const invocation = `/${name}${argument}`;
        const expected = expectedMessages[name](argument.slice(1));
        const inputEvents: unknown[] = [];
        const { session } = await createSession(inputEvents);
        const prompted: unknown[] = [];
        const steering: unknown[] = [];
        const followUps: unknown[] = [];
        const agent = session.agent as unknown as {
          steer(message: unknown): void;
          followUp(message: unknown): void;
        };
        agent.steer = (message) => prompted.push(message);
        (
          session as unknown as { _isAgentRunActive: boolean }
        )._isAgentRunActive = true;
        await session.prompt(invocation, { streamingBehavior: "steer" });
        agent.steer = (message) => steering.push(message);
        agent.followUp = (message) => followUps.push(message);
        await session.steer(invocation);
        await session.followUp(invocation);

        const textOf = (messages: unknown[]) =>
          (messages[0] as { content: Array<{ text?: string }> }).content[0]
            ?.text;
        expect(textOf(prompted)).toBe(expected);
        expect(textOf(steering)).toBe(expected);
        expect(textOf(followUps)).toBe(expected);
        expect(inputEvents).toEqual([
          expect.objectContaining({ text: invocation }),
        ]);
        session.dispose();
      }
    }
  });

  it("restores queue methods after shutdown and uses a new owner's current transformer", async () => {
    const prototype = AgentSession.prototype as unknown as {
      steer: unknown;
      followUp: unknown;
    };
    const originalPrompt = (
      AgentSession.prototype as unknown as { prompt: unknown }
    ).prompt;
    const originalSteer = prototype.steer;
    const originalFollowUp = prototype.followUp;
    const old = await createSession(
      [],
      createPromptCommandsExtension((text) => `old:${text}`)
    );
    expect(
      (AgentSession.prototype as unknown as { prompt: unknown }).prompt
    ).not.toBe(originalPrompt);
    expect(prototype.steer).not.toBe(originalSteer);

    const current = await createSession(
      [],
      createPromptCommandsExtension((text) => `current:${text}`)
    );
    const currentQueued: unknown[] = [];
    (
      current.session.agent as unknown as { steer(message: unknown): void }
    ).steer = (message) => currentQueued.push(message);
    await current.session.steer("/show-me topic");
    expect(
      (currentQueued[0] as { content: Array<{ text?: string }> }).content[0]
        ?.text
    ).toBe("current:/show-me topic");

    await (
      current.session as unknown as {
        extensionRunner: {
          emit(event: {
            type: "session_shutdown";
            reason: "reload";
          }): Promise<void>;
        };
      }
    ).extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    current.session.dispose();
    expect(prototype.steer).not.toBe(originalSteer);

    const oldQueued: unknown[] = [];
    (old.session.agent as unknown as { steer(message: unknown): void }).steer =
      (message) => oldQueued.push(message);
    await old.session.steer("/show-me topic");
    expect(
      (oldQueued[0] as { content: Array<{ text?: string }> }).content[0]?.text
    ).toBe("old:/show-me topic");
    await (
      old.session as unknown as {
        extensionRunner: {
          emit(event: {
            type: "session_shutdown";
            reason: "quit";
          }): Promise<void>;
        };
      }
    ).extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    old.session.dispose();
    expect(
      (AgentSession.prototype as unknown as { prompt: unknown }).prompt
    ).toBe(originalPrompt);
    expect(prototype.steer).toBe(originalSteer);
    expect(prototype.followUp).toBe(originalFollowUp);

    const noOwner = await createSession([], () => {
      // Deliberately no prompt-command owner.
    });
    const untransformed: unknown[] = [];
    (
      noOwner.session.agent as unknown as { steer(message: unknown): void }
    ).steer = (message) => untransformed.push(message);
    await noOwner.session.steer("/show-me topic");
    expect(
      (untransformed[0] as { content: Array<{ text?: string }> }).content[0]
        ?.text
    ).not.toStartWith("current:");
    noOwner.session.dispose();
  });

  it("restores its prompt wrapper after an outer wrapper unlinks", async () => {
    const prototype = AgentSession.prototype as unknown as {
      prompt: (text: string, options?: unknown) => Promise<void>;
    };
    const originalPrompt = prototype.prompt;
    const { session } = await createSession([]);
    const promptCommandsPrompt = prototype.prompt;
    const outerPrompt = function outerPrompt(
      this: AgentSession,
      text: string,
      options?: unknown
    ) {
      return promptCommandsPrompt.call(this, text, options);
    };
    prototype.prompt = outerPrompt;

    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "reload",
    });
    session.dispose();
    expect(prototype.prompt).toBe(outerPrompt);

    prototype.prompt = promptCommandsPrompt;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(prototype.prompt).toBe(originalPrompt);
  });

  it("keeps all three prompt templates functional when extensions are disabled or fail to load", async () => {
    for (const additionalExtensionPaths of [
      [],
      [join(import.meta.dir, "missing-extension.ts")],
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "prompt-commands-"));
      temporaryDirectories.push(directory);
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: SettingsManager.inMemory(),
        noExtensions: true,
        additionalExtensionPaths,
        additionalPromptTemplatePaths: [
          join(import.meta.dir, "..", "..", "prompts"),
        ],
      });
      await loader.reload();
      expect(loader.getExtensions().errors.length > 0).toBe(
        additionalExtensionPaths.length > 0
      );
      const result = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(directory),
        settingsManager: SettingsManager.inMemory(),
      });
      activeSessions.push(
        result.session as unknown as (typeof activeSessions)[number]
      );
      const queued: unknown[] = [];
      (
        result.session.agent as unknown as { steer(message: unknown): void }
      ).steer = (message) => queued.push(message);

      for (const name of Object.keys(expectedMessages) as CommandName[]) {
        await result.session.steer(`/${name} first\n  second`);
      }

      expect(
        queued.map(
          (message) =>
            (message as { content: Array<{ text?: string }> }).content[0]?.text
        )
      ).toEqual(
        (Object.keys(expectedMessages) as CommandName[]).map((name) =>
          expectedMessages[name]("first second")
        )
      );
      expect(
        queued.every(
          (message) =>
            !(
              message as { content: Array<{ text?: string }> }
            ).content[0]?.text?.includes("prompt-pipeline command")
        )
      ).toBe(true);
      result.session.dispose();
    }
  });

  it("exposes all three names as queueable prompt templates, not extension commands", async () => {
    const { loader, session } = await createSession([]);
    const prompts = loader
      .getPrompts()
      .prompts.filter(({ name }) => Object.hasOwn(expectedMessages, name));

    expect(prompts.map(({ name }) => name)).toEqual(
      Object.keys(expectedMessages) as CommandName[]
    );
    for (const name of Object.keys(expectedMessages) as CommandName[]) {
      await expect(
        session.steer(`/${name} ${rawArgument}`)
      ).resolves.toBeUndefined();
    }
    session.dispose();
  });
});
