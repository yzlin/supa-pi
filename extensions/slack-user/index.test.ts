import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piSlackUserExtension from "./index.js";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: { url: string; text?: string; max_messages?: number },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: {
      hasUI: boolean;
      ui: { confirm: (title: string, message: string) => Promise<boolean> };
    },
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
}

interface RegisteredCommand {
  handler: (
    args: string,
    ctx: {
      ui: { notify: (message: string, level: string) => void };
    },
  ) => Promise<void>;
}

type FetchFunction = (
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

const originalToken = process.env.SLACK_USER_TOKEN;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let testAgentDir: string;
const originalFetch = globalThis.fetch;
const url = "https://example.slack.com/archives/C123/p1700000000123456";

function loadExtension() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const pi = {
    registerTool(definition: RegisteredTool) {
      tools.set(definition.name, definition);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
  };
  piSlackUserExtension(pi as unknown as ExtensionAPI);
  function tool(name: string): RegisteredTool {
    const registered = tools.get(name);
    if (!registered) {
      throw new Error(`${name} was not registered`);
    }
    return registered;
  }
  return { tools, commands, tool };
}

beforeEach(() => {
  testAgentDir = mkdtempSync(join(realpathSync(tmpdir()), "slack-user-test-"));
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
  process.env.SLACK_USER_TOKEN = "xoxp-test-token";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  execFileSync("trash", [testAgentDir]);
  if (originalToken === undefined) {
    delete process.env.SLACK_USER_TOKEN;
  } else {
    process.env.SLACK_USER_TOKEN = originalToken;
  }
});

describe("Slack extension", () => {
  it("registers the two upstream tools and status command", () => {
    const { tools, commands } = loadExtension();
    expect([...tools.keys()]).toEqual([
      "slack_read_url",
      "slack_post_reply_url",
    ]);
    expect([...commands.keys()]).toEqual(["slack-user"]);
  });

  for (const name of ["slack_read_url", "slack_post_reply_url"]) {
    it(`${name} rejects empty thread_ts before confirmation or a Slack request`, async () => {
      const fetchMock = mock<FetchFunction>(async () =>
        Response.json({
          ok: true,
          messages: [],
          channel: "C123",
          ts: "1700000010.654321",
        }),
      );
      globalThis.fetch = Object.assign(fetchMock, {
        preconnect: originalFetch.preconnect,
      });
      const confirm = mock(async () => true);
      const error = await loadExtension()
        .tool(name)
        .execute(
          "empty-thread",
          { url: `${url}?thread_ts=`, text: "Exact reply" },
          undefined,
          undefined,
          { hasUI: true, ui: { confirm } },
        )
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("thread_ts"),
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("does not call Slack when confirmation is declined", async () => {
    const fetchMock = mock<FetchFunction>();
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const tool = loadExtension().tool("slack_post_reply_url");
    const confirm = mock(async () => false);
    const result = await tool.execute(
      "call-1",
      { url, text: "Exact reply" },
      undefined,
      undefined,
      { hasUI: true, ui: { confirm } },
    );
    expect(confirm).toHaveBeenCalledWith(
      "Post Slack reply?",
      `Reply to:\n${url}\n\nExact message:\nExact reply`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.details).toEqual({ posted: false });
    expect(result.content[0]?.text).toContain("nothing was posted");
  });

  it("refuses to post when confirmation is unavailable", async () => {
    const fetchMock = mock<FetchFunction>();
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const confirm = mock(async () => true);
    const error = await loadExtension()
      .tool("slack_post_reply_url")
      .execute("call-1", { url, text: "Exact reply" }, undefined, undefined, {
        hasUI: false,
        ui: { confirm },
      })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toContain(
      "interactive UI confirmation",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the exact confirmed text once and returns the permalink", async () => {
    const confirm = mock(async () => true);
    const fetchMock = mock<FetchFunction>(async (_input, init) => {
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(typeof init?.body).toBe("string");
      const body = new URLSearchParams(
        typeof init?.body === "string" ? init.body : "",
      );
      expect(body.get("text")).toBe(" Exact reply\n");
      return Response.json({
        ok: true,
        channel: "C123",
        ts: "1700000010.654321",
      });
    });
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const result = await loadExtension()
      .tool("slack_post_reply_url")
      .execute(
        "call-1",
        { url, text: " Exact reply\n" },
        undefined,
        undefined,
        { hasUI: true, ui: { confirm } },
      );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.details.posted).toBe(true);
    expect(result.content[0]?.text).toBe(
      "Posted Slack reply: https://example.slack.com/archives/C123/p1700000010654321?thread_ts=1700000000.123456&cid=C123",
    );
  });

  it("rejects whitespace-only text before confirmation", async () => {
    const fetchMock = mock<FetchFunction>();
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const confirm = mock(async () => true);
    const error = await loadExtension()
      .tool("slack_post_reply_url")
      .execute("call-1", { url, text: " \n " }, undefined, undefined, {
        hasUI: true,
        ui: { confirm },
      })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toContain(
      "cannot be empty",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing token without a request", async () => {
    delete process.env.SLACK_USER_TOKEN;
    const fetchMock = mock<FetchFunction>();
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const notify = mock((_message: string, _level: string) => {});
    const command = loadExtension().commands.get("slack-user");
    expect(command).toBeDefined();
    await command?.handler("", { ui: { notify } });
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("SLACK_USER_TOKEN is missing"),
      "warning",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a bounded thread through the registered tool", async () => {
    const controller = new AbortController();
    const fetchMock = mock<FetchFunction>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      const body = new URLSearchParams(
        typeof init?.body === "string" ? init.body : "",
      );
      expect(body.get("limit")).toBe("1");
      expect(body.get("ts")).toBe("1700000000.123456");
      return Response.json({
        ok: true,
        messages: [{ ts: "1700000000.123456", text: "Thread text" }],
        has_more: true,
        response_metadata: { next_cursor: "next" },
      });
    });
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const result = await loadExtension()
      .tool("slack_read_url")
      .execute(
        "read-1",
        { url, max_messages: 1 },
        controller.signal,
        undefined,
        { hasUI: false, ui: { confirm: mock(async () => false) } },
      );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toContain("Thread text");
    expect(result.content[0]?.text).toContain("Increase max_messages");
    expect(result.details).toEqual({
      channel: "C123",
      threadTs: "1700000000.123456",
      count: 1,
      messageLimitReached: true,
      outputTruncated: false,
    });
  });

  it("uses the default read cap and rejects missing credentials before fetching", async () => {
    const fetchMock = mock<FetchFunction>(async () =>
      Response.json({ ok: true, messages: [] }),
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const tool = loadExtension().tool("slack_read_url");
    const ctx = { hasUI: false, ui: { confirm: mock(async () => false) } };
    const result = await tool.execute(
      "read-1",
      { url },
      undefined,
      undefined,
      ctx,
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(
      new URLSearchParams(typeof body === "string" ? body : "").get("limit"),
    ).toBe("100");
    expect(result.content[0]?.text).toContain("No messages returned.");
    delete process.env.SLACK_USER_TOKEN;
    const error = await tool
      .execute("read-2", { url }, undefined, undefined, ctx)
      .catch((failure: unknown) => failure);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("Missing SLACK_USER_TOKEN"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates and displays identity without displaying the token", async () => {
    const fetchMock = mock<FetchFunction>(async () =>
      Response.json({ ok: true, user: "alice", team: "Example" }),
    );
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const notify = mock((_message: string, _level: string) => {});
    await loadExtension()
      .commands.get("slack-user")
      ?.handler("", { ui: { notify } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://slack.com/api/auth.test",
    );
    expect(notify).toHaveBeenCalledWith(
      "Slack user token is valid: @alice on Example.",
      "info",
    );
  });
});
