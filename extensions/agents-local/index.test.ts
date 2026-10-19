import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  type ContextFile,
  contextDirectories,
  contextFilesDisabled,
  discoverLocalContextFiles,
  mergeLocalContextFiles,
} from "./discover";
import agentsLocalExtension from "./index";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(name: string): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), `agents-local-${name}-`)),
  );
  temporaryDirectories.push(directory);
  return directory;
}

type HookName = "session_start" | "before_agent_start";
type HookHandler = (event: unknown, context: ExtensionContext) => unknown;

function createExtensionHarness() {
  const hooks = new Map<HookName, HookHandler>();
  const registered: string[] = [];
  agentsLocalExtension({
    on(name: string, handler: HookHandler) {
      hooks.set(name as HookName, handler);
    },
    registerCommand(name: string) {
      registered.push(name);
    },
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
    },
  } as unknown as ExtensionAPI);

  return {
    hooks,
    registered,
    sessionStart(cwd: string) {
      return hooks.get("session_start")?.(
        { type: "session_start", reason: "startup" },
        { cwd } as ExtensionContext,
      );
    },
    /** Runs before_agent_start on contextFiles in place; returns the handler result. */
    beforeAgentStart(contextFiles: ContextFile[], cwd: string) {
      return hooks.get("before_agent_start")?.(
        {
          type: "before_agent_start",
          prompt: "hello",
          systemPrompt: "base prompt",
          systemPromptOptions: { contextFiles, sections: {} },
        },
        { cwd } as ExtensionContext,
      );
    },
  };
}

/** Builds global agent dir, repo root, and subdir cwd with files written by name. */
function makeLayout(
  files: Partial<Record<"agent" | "root" | "sub", string[]>>,
) {
  const base = makeTempDir("layout");
  const dirs = {
    agent: join(base, "agent"),
    root: join(base, "repo"),
    sub: join(base, "repo", "packages", "app"),
  };
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true });
  }
  for (const [key, names] of Object.entries(files)) {
    for (const name of names ?? []) {
      writeFileSync(
        join(dirs[key as keyof typeof dirs], name),
        `${key}:${name}`,
      );
    }
  }
  process.env.PI_CODING_AGENT_DIR = dirs.agent;
  return dirs;
}

function native(dir: string): ContextFile {
  return { path: join(dir, "AGENTS.md"), content: `native:${dir}` };
}

function local(dir: string) {
  return join(dir, "AGENTS.local.md");
}

describe("agents-local SDK seam", () => {
  it("renders a Local context file inside project_context right after its sibling AGENTS.md", async () => {
    const root = makeTempDir("seam");
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "TEAM_NATIVE");
    writeFileSync(join(cwd, "AGENTS.local.md"), "\uFEFFPERSONAL_LOCAL");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const requests: Context[] = [];
    const provider = fauxProvider();
    provider.setResponses([
      (context: Context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage("ok");
      },
    ]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(root, "models-store.json"),
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(provider.provider);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noSkills: true,
      extensionFactories: [agentsLocalExtension],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: provider.getModel(),
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
    });
    try {
      await session.bindExtensions({ mode: "print" });
      await session.prompt("hello");

      const rendered = JSON.stringify(requests[0]);
      const nativeBlock = `<project_instructions path=\\"${join(cwd, "AGENTS.md")}\\">\\nTEAM_NATIVE\\n</project_instructions>`;
      const localBlock = `<project_instructions path=\\"${join(cwd, "AGENTS.local.md")}\\">\\nPERSONAL_LOCAL\\n</project_instructions>`;
      expect(rendered).toContain(`${nativeBlock}\\n\\n${localBlock}`);
      const contextStart = rendered.indexOf("<project_context>");
      const contextEnd = rendered.indexOf("</project_context>");
      expect(contextStart).toBeGreaterThan(-1);
      expect(rendered.indexOf(localBlock)).toBeGreaterThan(contextStart);
      expect(rendered.indexOf(localBlock)).toBeLessThan(contextEnd);
    } finally {
      session.dispose();
    }
  });
});

describe("agents-local placement", () => {
  it("orders global, root, and subdir pairs native then local", () => {
    const dirs = makeLayout({
      agent: ["AGENTS.md", "AGENTS.local.md"],
      root: ["AGENTS.md", "AGENTS.local.md"],
      sub: ["AGENTS.md", "AGENTS.local.md"],
    });
    const harness = createExtensionHarness();
    const contextFiles = [
      native(dirs.agent),
      native(dirs.root),
      native(dirs.sub),
    ];

    harness.sessionStart(dirs.sub);
    const result = harness.beforeAgentStart(contextFiles, dirs.sub);

    expect(result).toBeUndefined();
    expect(contextFiles.map(({ path }) => path)).toEqual([
      join(dirs.agent, "AGENTS.md"),
      local(dirs.agent),
      join(dirs.root, "AGENTS.md"),
      local(dirs.root),
      join(dirs.sub, "AGENTS.md"),
      local(dirs.sub),
    ]);
    expect(contextFiles[1]).toEqual({
      path: local(dirs.agent),
      content: "agent:AGENTS.local.md",
    });
    expect(harness.registered).toEqual([]);
  });

  it("loads orphan Local context files in their parent-to-child slot", () => {
    const dirs = makeLayout({
      agent: ["AGENTS.local.md"],
      root: ["AGENTS.local.md"],
      sub: ["AGENTS.md"],
    });
    const harness = createExtensionHarness();
    const contextFiles = [native(dirs.sub)];

    harness.sessionStart(dirs.sub);
    harness.beforeAgentStart(contextFiles, dirs.sub);

    expect(contextFiles.map(({ path }) => path)).toEqual([
      local(dirs.agent),
      local(dirs.root),
      join(dirs.sub, "AGENTS.md"),
    ]);
  });

  it("never removes or reorders natives and stays idempotent", () => {
    const dirs = makeLayout({
      root: ["AGENTS.md", "AGENTS.local.md"],
      sub: ["AGENTS.md", "AGENTS.local.md"],
    });
    const harness = createExtensionHarness();
    const natives = [native(dirs.agent), native(dirs.root), native(dirs.sub)];
    const contextFiles = [...natives];

    harness.sessionStart(dirs.sub);
    harness.beforeAgentStart(contextFiles, dirs.sub);
    const once = [...contextFiles];
    harness.beforeAgentStart(contextFiles, dirs.sub);

    expect(contextFiles).toEqual(once);
    expect(contextFiles.filter((entry) => natives.includes(entry))).toEqual(
      natives,
    );
    const options = { cwd: dirs.sub, agentDir: dirs.agent };
    expect(
      mergeLocalContextFiles(
        once,
        discoverLocalContextFiles(options),
        contextDirectories(options),
      ),
    ).toEqual(once);
  });

  it("loads a realpath-duplicate Local context file once", () => {
    const dirs = makeLayout({ root: ["AGENTS.local.md"] });
    symlinkSync(local(dirs.root), local(dirs.sub));

    expect(
      discoverLocalContextFiles({ cwd: dirs.sub, agentDir: dirs.agent }).map(
        ({ path }) => path,
      ),
    ).toEqual([local(dirs.root)]);
    expect(
      discoverLocalContextFiles({ cwd: dirs.root, agentDir: dirs.root }).map(
        ({ path }) => path,
      ),
    ).toEqual([local(dirs.root)]);
  });
});

describe("agents-local caching and opt-out", () => {
  it("keeps the session_start scan until the next session_start", () => {
    const dirs = makeLayout({ root: ["AGENTS.local.md"] });
    const harness = createExtensionHarness();

    harness.sessionStart(dirs.root);
    writeFileSync(local(dirs.root), "edited");
    const cached: ContextFile[] = [];
    harness.beforeAgentStart(cached, dirs.root);
    expect(cached).toEqual([
      { path: local(dirs.root), content: "root:AGENTS.local.md" },
    ]);

    harness.sessionStart(dirs.root);
    const rescanned: ContextFile[] = [];
    harness.beforeAgentStart(rescanned, dirs.root);
    expect(rescanned).toEqual([{ path: local(dirs.root), content: "edited" }]);
  });

  it.each(["-nc", "--no-context-files"])(
    "leaves contextFiles unchanged and reads no files with %s",
    (flag) => {
      const dirs = makeLayout({ root: ["AGENTS.md", "AGENTS.local.md"] });
      const harness = createExtensionHarness();
      process.argv = [...originalArgv, flag];
      const spies = [
        spyOn(fs, "statSync"),
        spyOn(fs, "readFileSync"),
        spyOn(fs, "realpathSync"),
      ];
      try {
        const contextFiles = [native(dirs.root)];
        harness.sessionStart(dirs.root);
        harness.beforeAgentStart(contextFiles, dirs.root);

        expect(contextFiles).toEqual([native(dirs.root)]);
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    },
  );

  it("detects only the exact opt-out flags", () => {
    expect(contextFilesDisabled(["pi", "-nc"])).toBe(true);
    expect(contextFilesDisabled(["pi", "--no-context-files"])).toBe(true);
    expect(contextFilesDisabled(["pi", "--no-skills", "-n"])).toBe(false);
  });

  it("skips unreadable and non-file Local context files without throwing", () => {
    const dirs = makeLayout({ root: ["AGENTS.local.md"] });
    chmodSync(local(dirs.root), 0o000);
    mkdirSync(local(dirs.sub));
    const harness = createExtensionHarness();
    const contextFiles: ContextFile[] = [];
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    let warnings: unknown[][] = [];

    try {
      expect(() => harness.sessionStart(dirs.sub)).not.toThrow();
      harness.beforeAgentStart(contextFiles, dirs.sub);
      warnings = [...consoleError.mock.calls];
    } finally {
      chmodSync(local(dirs.root), 0o644);
      consoleError.mockRestore();
    }

    expect(contextFiles).toEqual([]);
    // Only the unreadable file warns; missing files and the directory entry stay silent.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toStartWith(
      `Warning: Could not read ${local(dirs.root)}: `,
    );
    expect(warnings[0]?.[0]).toContain("EACCES");
  });
});
