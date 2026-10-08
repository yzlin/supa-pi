import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { execFileSync } from "node:child_process";
import fs, {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { saveUserToken } from "./auth.js";
import extension from "./index.js";
import { SlackUserClient } from "./slack.js";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Factory = Parameters<ExtensionUIContext["custom"]>[0];
const savedEnv = {
  token: process.env.SLACK_USER_TOKEN,
  dir: process.env.PI_CODING_AGENT_DIR,
};
const originalFetch = globalThis.fetch;
const token = "xoxp-synthetic-secret";
const url = "https://example.slack.com/archives/C123/p1700000000123456";
let root: string;
let authDir: string;
let authFile: string;

function load() {
  let command: Command | undefined;
  const tools = new Map<string, Tool>();
  extension({
    registerCommand(_name: string, value: Command) {
      command = value;
    },
    registerTool(value: Tool) {
      tools.set(value.name, value);
    },
  } as ExtensionAPI);
  if (!command) {
    throw new Error("Command missing");
  }
  return { command, tools };
}

function context(inputs: string[] = [token, "\r"], mode = "tui") {
  const notifications: string[] = [];
  const renders: string[][] = [];
  const custom = mock(async (factory: Factory) => {
    let result: unknown;
    const component = await factory(
      { requestRender() {} } as Parameters<Factory>[0],
      {} as Parameters<Factory>[1],
      {} as Parameters<Factory>[2],
      (value) => {
        result = value;
      },
    );
    if ("focused" in component) {
      component.focused = true;
    }
    for (const input of inputs) {
      component.handleInput?.(input);
      component.invalidate();
      for (const width of [1, 10, 80]) {
        renders.push(component.render(width));
      }
    }
    const disposable: Component & { dispose?: () => void } = component;
    disposable.dispose?.();
    return result;
  });
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      custom,
      notify(message: string) {
        notifications.push(message);
      },
      confirm: async () => true,
    },
  } as unknown as ExtensionCommandContext & ExtensionToolContext;
  return { ctx, custom, notifications, renders };
}
function respond(body: unknown = { ok: true, user: "alice", team: "Example" }) {
  const fetchMock = mock(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(body),
  );
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  return fetchMock;
}
function previous() {
  mkdirSync(authDir, { mode: 0o700 });
  writeFileSync(authFile, JSON.stringify({ token: "xoxp-previous" }), {
    mode: 0o600,
  });
  return readFileSync(authFile, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "slack-init-test-"));
  authDir = join(root, "slack-user");
  authFile = join(authDir, "auth.json");
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.SLACK_USER_TOKEN;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of [
    ["SLACK_USER_TOKEN", savedEnv.token],
    ["PI_CODING_AGENT_DIR", savedEnv.dir],
  ]) {
    if (value === undefined) {
      delete process.env[name!];
    } else {
      process.env[name!] = value;
    }
  }
  execFileSync("trash", [root]);
});

describe("Slack user init", () => {
  it("masks typed, split pasted and edited input at every width, then saves privately", async () => {
    const fetchMock = respond();
    const { command } = load();
    const ui = context([
      "xoxp-",
      "\x1b[200~synthetic-",
      "secreX\x1b[201~",
      "\x7f",
      "t",
      "\r",
    ]);
    await command.handler("init", ui.ctx);
    expect(ui.custom).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://slack.com/api/auth.test",
    );
    expect(readFileSync(authFile, "utf8")).toBe(
      `${JSON.stringify({ token })}\n`,
    );
    expect(lstatSync(authDir).mode % 4096).toBe(0o700);
    expect(lstatSync(authFile).mode % 4096).toBe(0o600);
    expect(JSON.stringify(ui.renders)).not.toMatch(/xoxp|synthetic|secreX/);
    expect(JSON.stringify(ui.notifications)).not.toContain(token);
    expect(readdirSync(authDir)).toEqual(["auth.json"]);
  });
  for (const mode of ["rpc", "print", "json"]) {
    it(`rejects init in ${mode} even when RPC has UI`, async () => {
      const fetchMock = respond();
      const ui = context([], mode);
      await load().command.handler("init", ui.ctx);
      expect(ui.custom).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ui.notifications.join()).toContain("terminal");
    });
  }
  for (const args of [
    "init xoxp-inline-secret",
    "xoxp-inline-secret",
    "other",
  ]) {
    it(`rejects unexpected arguments without echoing them`, async () => {
      const fetchMock = respond();
      const ui = context();
      await load().command.handler(args, ui.ctx);
      expect(ui.custom).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ui.notifications.join()).toContain("Usage:");
      expect(ui.notifications.join()).not.toContain(args);
    });
  }
  it("cancels masked input and preserves the existing credential", async () => {
    const old = previous();
    const fetchMock = respond();
    const ui = context([token, "\x1b"]);
    await load().command.handler("init", ui.ctx);
    expect(ui.custom).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(authFile, "utf8")).toBe(old);
    expect(JSON.stringify(ui.renders)).not.toContain(token);
  });
  it("cancels with Ctrl+C and ignores subsequent input", async () => {
    const old = previous();
    const fetchMock = respond();
    const ui = context([token, "\x03", "ignored", "\r"]);
    await load().command.handler("init", ui.ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(authFile, "utf8")).toBe(old);
    expect(ui.notifications.join()).toContain("cancelled");
  });
  for (const body of [
    { ok: false, error: token, response_metadata: { messages: [token] } },
    {},
    { ok: "true" },
    { ok: true },
    { ok: true, user: 9, team: "Example" },
    null,
  ]) {
    it("failed or malformed auth preserves previous credential and hides diagnostics", async () => {
      const old = previous();
      const fetchMock = respond(body);
      const ui = context();
      await load().command.handler("init", ui.ctx);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(readFileSync(authFile, "utf8")).toBe(old);
      expect(ui.notifications.join()).toContain("failed");
      expect(ui.notifications.join()).not.toContain(token);
    });
  }
  it("hides arbitrary transport/custom errors", async () => {
    previous();
    globalThis.fetch = Object.assign(
      mock(async () => {
        throw new Error(token);
      }),
      { preconnect: originalFetch.preconnect },
    );
    const ui = context();
    await load().command.handler("init", ui.ctx);
    expect(ui.notifications.join()).toContain("failed");
    expect(ui.notifications.join()).not.toContain(token);
    ui.custom.mockRejectedValueOnce(new Error(token));
    await load().command.handler("init", ui.ctx);
    expect(ui.notifications.join()).not.toContain(token);
  });
  it("rejects non-user tokens without sending them to Slack", async () => {
    const old = previous();
    const fetchMock = respond();
    const ui = context(["xoxb-synthetic", "\r"]);
    await load().command.handler("init", ui.ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(authFile, "utf8")).toBe(old);
    expect(ui.notifications.join()).toContain("xoxp-");
  });
  it("reloads saved credentials for status and both tools without restart", async () => {
    respond();
    const loaded = load();
    await loaded.command.handler("init", context().ctx);
    const seen: string[] = [];
    globalThis.fetch = Object.assign(
      mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("Authorization") ?? "");
        return Response.json({
          ok: true,
          user: "alice",
          team: "Example",
          messages: [],
          channel: "C123",
          ts: "1700000010.123456",
        });
      }),
      { preconnect: originalFetch.preconnect },
    );
    await loaded.command.handler("", context().ctx);
    await loaded.tools
      .get("slack_read_url")
      ?.execute("r", { url }, undefined, undefined, context().ctx);
    await loaded.tools
      .get("slack_post_reply_url")
      ?.execute(
        "p",
        { url, text: "Reply" },
        undefined,
        undefined,
        context().ctx,
      );
    await load().command.handler("", context().ctx);
    expect(seen).toEqual(Array.from({ length: 4 }, () => `Bearer ${token}`));
    const oldInode = lstatSync(authFile).ino;
    respond();
    await loaded.command.handler(
      "init",
      context(["xoxp-replacement", "\r"]).ctx,
    );
    expect(lstatSync(authFile).ino).not.toBe(oldInode);
    expect(readdirSync(authDir)).toEqual(["auth.json"]);
    expect(lstatSync(authFile).mode % 4096).toBe(0o600);
    const fetchMock = respond();
    await loaded.command.handler("", context().ctx);
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization"),
    ).toBe("Bearer xoxp-replacement");
  });
  it("prefers environment credentials and warns after saving", async () => {
    process.env.SLACK_USER_TOKEN = "xoxp-environment";
    const fetchMock = respond();
    const loaded = load();
    const ui = context();
    await loaded.command.handler("init", ui.ctx);
    expect(readFileSync(authFile, "utf8")).toContain(token);
    expect(ui.notifications.join()).toContain("SLACK_USER_TOKEN");
    await loaded.command.handler("", ui.ctx);
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization"),
    ).toBe(`Bearer ${token}`);
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization"),
    ).toBe("Bearer xoxp-environment");
  });
  for (const unsafe of [
    "malformed",
    "shape",
    "insecure-file",
    "insecure-dir",
    "insecure-agent-dir",
    "file-symlink",
    "dir-symlink",
    "ancestor-symlink",
    "hardlink",
    "auth-directory",
  ]) {
    it(`rejects ${unsafe} saved locations on load and unsafe locations on save`, async () => {
      previous();
      if (unsafe === "malformed") {
        writeFileSync(authFile, "{invalid");
      }
      if (unsafe === "shape") {
        writeFileSync(authFile, JSON.stringify({ token: 9 }));
      }
      if (unsafe === "insecure-file") {
        chmodSync(authFile, 0o644);
      }
      if (unsafe === "insecure-dir") {
        chmodSync(authDir, 0o755);
      }
      if (unsafe === "insecure-agent-dir") {
        chmodSync(root, 0o777);
      }
      if (unsafe === "file-symlink") {
        renameSync(authFile, join(root, "other"));
        symlinkSync(join(root, "other"), authFile);
      }
      if (unsafe === "dir-symlink") {
        renameSync(authDir, join(root, "other-dir"));
        symlinkSync(join(root, "other-dir"), authDir);
      }
      if (unsafe === "ancestor-symlink") {
        symlinkSync(root, join(root, "alias"));
        process.env.PI_CODING_AGENT_DIR = join(root, "alias");
      }
      if (unsafe === "hardlink") {
        execFileSync("ln", [authFile, join(root, "linked")]);
      }
      if (unsafe === "auth-directory") {
        renameSync(authFile, join(root, "other"));
        mkdirSync(authFile, { mode: 0o700 });
      }
      const fetchMock = respond();
      const ui = context();
      const loaded = load();
      await loaded.command.handler("", ui.ctx);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ui.notifications.join()).toContain("credential");
      const toolError = await loaded.tools
        .get("slack_read_url")
        ?.execute("r", { url }, undefined, undefined, ui.ctx)
        .catch((e: unknown) => e);
      expect(toolError).toBeInstanceOf(Error);
      expect(fetchMock).not.toHaveBeenCalled();
      if (!["malformed", "shape"].includes(unsafe)) {
        const before = lstatSync(authFile);
        await loaded.command.handler("init", ui.ctx);
        expect(lstatSync(authFile).ino).toBe(before.ino);
        expect(
          readdirSync(authDir).filter((name) => name !== "auth.json"),
        ).toEqual([]);
        expect(ui.notifications.join()).not.toContain(token);
      }
    });
  }
});

describe("atomic credential failure", () => {
  for (const operation of [
    "writeFileSync",
    "fsyncSync",
    "renameSync",
  ] as const) {
    it(`preserves the old credential and removes private temporary after ${operation} fails`, () => {
      const old = previous();
      const inode = lstatSync(authFile).ino;
      const failure = spyOn(fs, operation).mockImplementationOnce(() => {
        const temporary = readdirSync(authDir).find((name) =>
          name.endsWith(".tmp"),
        );
        expect(temporary).toBeDefined();
        expect(
          lstatSync(join(authDir, temporary ?? "missing")).mode % 4096,
        ).toBe(0o600);
        throw new Error(token);
      });
      try {
        expect(() => saveUserToken(token)).toThrow(
          "Slack credential save failed. Existing credentials were not changed.",
        );
        expect(readFileSync(authFile, "utf8")).toBe(old);
        expect(lstatSync(authFile).ino).toBe(inode);
        expect(readdirSync(authDir)).toEqual(["auth.json"]);
        expect(failure).toHaveBeenCalledTimes(1);
      } finally {
        failure.mockRestore();
      }
    });
  }
});

describe("resolved credential error safety", () => {
  it("does not expose tokens echoed in Slack error fields", async () => {
    const client = new SlackUserClient(token, async () =>
      Response.json({
        ok: false,
        error: token,
        needed: token,
        provided: token,
        response_metadata: { messages: [token] },
      }),
    );
    const error = await client
      .readThread(
        {
          originalUrl: url,
          workspaceUrl: "https://example.slack.com",
          channelId: "C123",
          threadTs: "1700000000.123456",
          messageTs: "1700000000.123456",
        },
        1,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").not.toContain(token);
  });
});

describe("auth.test validation", () => {
  for (const body of [
    {},
    { ok: "true" },
    { ok: true },
    { ok: true, user: 3, team: "Example" },
    null,
  ]) {
    it("rejects malformed success payload", async () => {
      const client = new SlackUserClient(token, async () =>
        Response.json(body),
      );
      expect(await client.authTest().catch((e: unknown) => e)).toBeInstanceOf(
        Error,
      );
    });
  }
});
