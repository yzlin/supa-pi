import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { createSkillRouterExtension } from "./index";

const roots: string[] = [];
const JEV = { provider: "typesafe", id: "jev-latest" };
const SKILL_NAME = "router-contract-proof";
const SKILL_BODY = "ROUTER_CONTRACT_BODY";
const CATALOG = `<available_skills>\n<skill>\n<name>${SKILL_NAME}</name>\n<description>Proves the public skill routing contract.</description>\n<location>`;

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "skill-router-contract-"),
  );
  roots.push(root);
  const skillDirectory = path.join(root, "skills", SKILL_NAME);
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(
    path.join(skillDirectory, "SKILL.md"),
    `---\nname: ${SKILL_NAME}\ndescription: Proves the public skill routing contract.\n---\n\n${SKILL_BODY}\n`,
  );
  return root;
}

type InlineExtension = NonNullable<
  ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]
>[number];

async function makeSession(
  root: string,
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  extensionFactory: InlineExtension | InlineExtension[],
) {
  const provider = fauxProvider();
  provider.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "models-store.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
    retry: { enabled: false },
    enableSkillCommands: true,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: Array.isArray(extensionFactory)
      ? extensionFactory
      : [extensionFactory],
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => skill.name === SKILL_NAME),
    }),
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model: provider.getModel(),
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
  });
  await session.bindExtensions({ mode: "print" });
  return { provider, session };
}

test("mutable prompt options suppress native catalog while injection and /skill remain public", async () => {
  const root = await makeRoot();
  const requests: Context[] = [];
  const responses = ["ordinary", "explicit"].map(
    (reply) => (context: Context) => {
      requests.push(structuredClone(context));
      return fauxAssistantMessage(reply);
    },
  );
  const { provider, session } = await makeSession(root, responses, (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.skills = [];
      return {
        message: {
          customType: "skill-router-contract",
          content: `Selected skill instructions:\n${SKILL_BODY}`,
          display: false,
        },
      };
    });
  });
  try {
    await session.prompt("Use the appropriate workflow.");
    await session.prompt(`/skill:${SKILL_NAME} explicit argument`);

    expect(provider.state.callCount).toBe(2);
    const ordinaryRequest = JSON.stringify(requests[0]?.messages);
    const explicitRequest = JSON.stringify(requests[1]?.messages);
    expect(ordinaryRequest).not.toContain(SKILL_NAME);
    expect(ordinaryRequest).toContain(SKILL_BODY);
    expect(explicitRequest).not.toContain(`<name>${SKILL_NAME}</name>`);
    expect(explicitRequest).toContain(SKILL_BODY);
    expect(explicitRequest).toContain("explicit argument");
  } finally {
    session.dispose();
  }
});

test("real router composes safely with forced-prompt appenders in either registration order", async () => {
  const root = await makeRoot();
  const routerState = () => {
    let calls = 0;
    const router = createSkillRouterExtension({
      agentDir: root,
      env: {},
      configStore: {
        load: async () => true,
        save: async () => undefined,
      },
      selectModel: async () => JEV as never,
      createClient: () => ({
        judgeBatch: (candidates) => {
          calls++;
          return Promise.resolve({
            scores: new Map(candidates.map((candidate) => [candidate.id, 1])),
          });
        },
      }),
    });
    return { router, calls: () => calls };
  };
  const appender = (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\nOPAQUE_APPENDER`,
    }));
  };

  const firstRequests: Context[] = [];
  const first = routerState();
  const firstSession = await makeSession(
    root,
    [
      (context) => {
        firstRequests.push(structuredClone(context));
        return fauxAssistantMessage("first");
      },
    ],
    [first.router, appender],
  );
  try {
    await firstSession.session.prompt("route this", { source: "interactive" });
    const visible = JSON.stringify(firstRequests[0]);
    expect(first.calls()).toBe(1);
    expect(visible).toContain("OPAQUE_APPENDER");
    expect(visible).toContain(SKILL_BODY);
    expect(visible).not.toContain(`<name>${SKILL_NAME}</name>`);
  } finally {
    firstSession.session.dispose();
  }

  const secondRequests: Context[] = [];
  const second = routerState();
  const secondSession = await makeSession(
    root,
    [
      (context) => {
        secondRequests.push(structuredClone(context));
        return fauxAssistantMessage("second");
      },
    ],
    [appender, second.router],
  );
  try {
    await secondSession.session.prompt("route this", { source: "interactive" });
    const visible = JSON.stringify(secondRequests[0]);
    expect(second.calls()).toBe(0);
    expect(visible).toContain("OPAQUE_APPENDER");
    expect(visible).toContain(`<name>${SKILL_NAME}</name>`);
    expect(visible).not.toContain("Selected skill instructions");
  } finally {
    secondSession.session.dispose();
  }
});

test("real router anchors transformed repeated queued fallbacks through tools, settling, and a fresh turn", async () => {
  const root = await makeRoot();
  const target = path.join(root, "target.txt");
  await fs.writeFile(target, "tool data");
  const requests: Context[] = [];
  let releaseFirst: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const router = createSkillRouterExtension({
    agentDir: root,
    env: {},
    configStore: {
      load: async () => true,
      save: async () => undefined,
    },
    selectModel: async () => JEV as never,
    createClient: () => ({
      judgeBatch: async (candidates) => ({
        scores: new Map(candidates.map((candidate) => [candidate.id, 1])),
      }),
    }),
  });
  const queuedTransformer = (pi: ExtensionAPI) => {
    pi.on("input", (event) =>
      event.text === "queued B"
        ? { action: "transform", text: "EXPANDED queued B" }
        : { action: "continue" },
    );
  };
  const { provider, session } = await makeSession(
    root,
    [
      async (context) => {
        requests.push(structuredClone(context));
        await blocked;
        return fauxAssistantMessage("first answer");
      },
      (context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage(fauxToolCall("read", { path: target }));
      },
      (context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage("first queued answer");
      },
      (context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage("second queued answer");
      },
      (context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage("fresh answer");
      },
    ],
    [router, queuedTransformer],
  );
  try {
    const running = session.prompt("request A", { source: "interactive" });
    while (provider.state.callCount === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await session.followUp("queued B");
    await session.followUp("queued B");
    releaseFirst?.();
    await running;
    await session.waitForIdle();
    await session.prompt("fresh after settled", { source: "interactive" });

    expect(provider.state.callCount).toBe(5);
    const fallbacks = (request: Context) =>
      request.messages.filter((message) =>
        JSON.stringify(message).includes("<available_skills>"),
      );
    expect(fallbacks(requests[1] as Context)).toHaveLength(1);
    expect(fallbacks(requests[1] as Context)[0]).toEqual(
      fallbacks(requests[2] as Context)[0],
    );
    expect(fallbacks(requests[3] as Context)).toHaveLength(2);
    expect(fallbacks(requests[4] as Context)).toHaveLength(2);
    for (const request of requests.slice(1)) {
      const queuedIndexes = request.messages.flatMap((message, index) =>
        JSON.stringify(message).includes("EXPANDED queued B") ? [index] : [],
      );
      const fallbackIndexes = request.messages.flatMap((message, index) =>
        JSON.stringify(message).includes("<available_skills>") ? [index] : [],
      );
      expect(fallbackIndexes).toEqual(
        queuedIndexes.map((queuedIndex) => queuedIndex - 1),
      );
    }
    const canonical = session.sessionManager.getEntries();
    expect(JSON.stringify(canonical)).toContain("EXPANDED queued B");
    expect(JSON.stringify(canonical)).not.toContain(
      "skill-router-native-fallback",
    );
  } finally {
    session.dispose();
  }
});

test("real provider retains a recovered body across controlled compaction, settling, and fresh fallback", async () => {
  const root = await makeRoot();
  const requests: Context[] = [];
  let enabled = true;
  const router = createSkillRouterExtension({
    agentDir: root,
    env: {},
    configStore: {
      load: async () => enabled,
      save: (value) => {
        enabled = value;
        return Promise.resolve();
      },
    },
    selectModel: async () => JEV as never,
    createClient: () => ({
      judgeBatch: async (candidates) => ({
        scores: new Map(candidates.map((candidate) => [candidate.id, 1])),
      }),
    }),
  });
  const controlledCompaction = (pi: ExtensionAPI) => {
    pi.on("session_before_compact", (event) => ({
      compaction: {
        summary: "Controlled offline compaction summary.",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    }));
    pi.on("session_compact", () => {
      pi.sendMessage(
        {
          customType: "controlled-post-compact-continuation",
          content: "Continue after controlled compaction.",
          display: false,
        },
        { triggerTurn: true },
      );
    });
  };
  const { provider, session } = await makeSession(
    root,
    ["first", "deduplicated", "continued", "fresh", "fallback"].map(
      (reply) => (context: Context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage(reply);
      },
    ),
    [router, controlledCompaction],
  );
  try {
    await session.prompt("initial route", { source: "interactive" });
    await session.prompt("same route", { source: "interactive" });
    await session.compact();
    await session.waitForIdle();
    await session.prompt("fresh after recovery", { source: "interactive" });
    enabled = false;
    await session.prompt("disabled fallback", { source: "interactive" });

    expect(provider.state.callCount).toBe(5);
    const recoveredBody = (request: Context) =>
      request.messages.find((message) =>
        JSON.stringify(message).includes(SKILL_BODY),
      );
    const recovered = recoveredBody(requests[2] as Context);
    expect(recovered).toBeDefined();
    expect(recoveredBody(requests[3] as Context)).toEqual(recovered);
    expect(recoveredBody(requests[4] as Context)).toEqual(recovered);
    for (const request of requests.slice(2)) {
      expect(
        request.messages.filter((message) =>
          JSON.stringify(message).includes(SKILL_BODY),
        ),
      ).toHaveLength(1);
    }
    const canonical = session.sessionManager.buildContextEntries();
    expect(JSON.stringify(canonical)).not.toContain(SKILL_BODY);
    expect(JSON.stringify(canonical)).not.toContain(
      "skill-router-native-fallback",
    );
  } finally {
    session.dispose();
  }
});

test("context hook covers queued follow-up without replacing persisted messages", async () => {
  const root = await makeRoot();
  const requests: Context[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { provider, session } = await makeSession(
    root,
    [
      async (context) => {
        requests.push(structuredClone(context));
        await firstBlocked;
        return fauxAssistantMessage("first answer");
      },
      (context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage("queued answer");
      },
    ],
    (pi) => {
      pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.skills = [];
      });
      pi.on("context", (event) => {
        const hasQueuedPrompt = JSON.stringify(event.messages).includes(
          "queued request",
        );
        if (!hasQueuedPrompt) {
          return;
        }
        return {
          messages: [
            ...event.messages,
            {
              role: "custom",
              customType: "skill-router-catalog-fallback",
              content: CATALOG,
              display: false,
              timestamp: Date.now(),
            },
          ],
        };
      });
    },
  );
  try {
    const running = session.prompt("original request");
    while (provider.state.callCount === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await session.followUp("queued request");
    releaseFirst?.();
    await running;
    await session.waitForIdle();

    expect(provider.state.callCount).toBe(2);
    const secondMessages = JSON.stringify(requests[1]?.messages);
    const secondSystemMessage = JSON.stringify(requests[1]?.messages[0]);
    expect(secondSystemMessage).not.toContain(SKILL_NAME);
    expect(secondMessages).toContain("original request");
    expect(secondMessages).toContain("first answer");
    expect(secondMessages).toContain("queued request");
    expect(secondMessages).toContain("available_skills");
    expect(secondMessages).toContain(SKILL_NAME);
  } finally {
    session.dispose();
  }
});
