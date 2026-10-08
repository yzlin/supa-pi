import { describe, expect, it, mock } from "bun:test";

import { type FetchLike, SlackApiError, SlackUserClient } from "./slack.js";
import { parseSlackPermalink } from "./url.js";

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("SlackUserClient", () => {
  it("reads and paginates a thread with the user bearer token", async () => {
    const fetchMock = mock<FetchLike>();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [{ user: "U123", text: "First", ts: "1700000000.123456" }],
          has_more: true,
          response_metadata: { next_cursor: "next" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [{ user: "U123", text: "Second", ts: "1700000001.123456" }],
          has_more: false,
          response_metadata: { next_cursor: "" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          user: {
            id: "U123",
            name: "alice",
            profile: { display_name: "Alice" },
          },
        }),
      );

    const client = new SlackUserClient("xoxp-test-token", fetchMock);
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );
    const thread = await client.readThread(target, 100);

    expect(thread.messages.map((message) => message.text)).toEqual([
      "First",
      "Second",
    ]);
    expect(thread.users.get("U123")).toBe("Alice");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const firstInit = fetchMock.mock.calls[0]?.[1];
    expect(firstInit?.headers).toMatchObject({
      Authorization: "Bearer xoxp-test-token",
    });
    expect(typeof firstInit?.body).toBe("string");
    const firstBody = new URLSearchParams(
      typeof firstInit?.body === "string" ? firstInit.body : "",
    );
    expect({
      channel: firstBody.get("channel"),
      ts: firstBody.get("ts"),
      limit: firstBody.get("limit"),
    }).toEqual({
      channel: "C123",
      ts: "1700000000.123456",
      limit: "100",
    });
  });

  it("posts a plain user-context reply without identity customization", async () => {
    const fetchMock = mock<FetchLike>().mockResolvedValue(
      jsonResponse({ ok: true, channel: "C123", ts: "1700000010.654321" }),
    );
    const client = new SlackUserClient("xoxp-test-token", fetchMock);
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );

    expect(await client.postReply(target, "Ship it")).toEqual({
      channel: "C123",
      ts: "1700000010.654321",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(typeof init?.body).toBe("string");
    const postBody = new URLSearchParams(
      typeof init?.body === "string" ? init.body : "",
    );
    expect({
      channel: postBody.get("channel"),
      thread_ts: postBody.get("thread_ts"),
      text: postBody.get("text"),
    }).toEqual({
      channel: "C123",
      thread_ts: "1700000000.123456",
      text: "Ship it",
    });
  });

  it("reports missing Slack scopes without exposing the token", async () => {
    const fetchMock = mock<FetchLike>().mockResolvedValue(
      jsonResponse({
        ok: false,
        error: "missing_scope",
        needed: "channels:history",
        provided: "chat:write",
      }),
    );
    const client = new SlackUserClient("xoxp-secret", fetchMock);
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );

    const error = await client
      .readThread(target, 100)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toEqual(
      expect.objectContaining({
        message:
          "Slack conversations.replies failed: missing_scope (needed: channels:history)",
      }),
    );
    expect(error instanceof Error ? error.message : "").not.toContain(
      "xoxp-secret",
    );
  });

  it("stops at the message cap and reports more messages", async () => {
    const fetchMock = mock<FetchLike>(async () =>
      Response.json({
        ok: true,
        messages: [{ ts: "1700000000.123456", text: "One" }],
        has_more: true,
        response_metadata: { next_cursor: "next" },
      }),
    );
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );
    const thread = await new SlackUserClient(
      "xoxp-test-token",
      fetchMock,
    ).readThread(target, 1);
    expect(thread.messages).toHaveLength(1);
    expect(thread.truncatedByMessageLimit).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to user IDs when names cannot be resolved", async () => {
    const fetchMock = mock<FetchLike>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          messages: [
            { ts: "1700000000.123456", user: "U123", text: "Hi <@U456>" },
          ],
        }),
      )
      .mockResolvedValue(Response.json({ ok: false, error: "missing_scope" }));
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );
    const thread = await new SlackUserClient(
      "xoxp-test-token",
      fetchMock,
    ).readThread(target, 100);
    expect([...thread.users.entries()]).toEqual([
      ["U123", "U123"],
      ["U456", "U456"],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("forwards cancellation without swallowing an aborted name lookup", async () => {
    const controller = new AbortController();
    const fetchMock = mock<FetchLike>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          messages: [{ ts: "1700000000.123456", user: "U123" }],
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      });
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );
    const error = await new SlackUserClient("xoxp-test-token", fetchMock)
      .readThread(target, 100, controller.signal)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toHaveProperty("name", "AbortError");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("reports HTTP rate limits without automatic retries", async () => {
    const fetchMock = mock<FetchLike>(async () =>
      Response.json({}, { status: 429 }),
    );
    const error = await new SlackUserClient("xoxp-test-token", fetchMock)
      .authTest()
      .catch((failure: unknown) => failure);
    expect(error).toHaveProperty(
      "message",
      "Slack auth.test returned HTTP 429.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
