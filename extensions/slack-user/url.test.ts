import { describe, expect, it } from "bun:test";

import { buildSlackReplyPermalink, parseSlackPermalink } from "./url.js";

describe("Slack permalink parsing", () => {
  it("parses a root message permalink", () => {
    expect(
      parseSlackPermalink(
        "https://example.slack.com/archives/C0123ABC456/p1700000000123456",
      ),
    ).toEqual({
      originalUrl:
        "https://example.slack.com/archives/C0123ABC456/p1700000000123456",
      workspaceUrl: "https://example.slack.com",
      channelId: "C0123ABC456",
      messageTs: "1700000000.123456",
      threadTs: "1700000000.123456",
    });
  });

  it("rejects an explicitly empty thread_ts", () => {
    expect(() =>
      parseSlackPermalink(
        "https://example.slack.com/archives/C123/p1700000000123456?thread_ts=",
      ),
    ).toThrow("thread_ts");
  });

  it("uses thread_ts when the permalink points at a reply", () => {
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C0123ABC456/p1700009999654321?thread_ts=1700000000.123456&cid=C0123ABC456",
    );

    expect(target.messageTs).toBe("1700009999.654321");
    expect(target.threadTs).toBe("1700000000.123456");
  });

  it("rejects non-Slack URLs and non-message Slack URLs", () => {
    expect(() =>
      parseSlackPermalink(
        "https://example.com/archives/C123/p1700000000123456",
      ),
    ).toThrow("slack.com");
    expect(() =>
      parseSlackPermalink("https://example.slack.com/client/T123/C123"),
    ).toThrow("/archives/");
  });

  it("builds a permalink for a posted thread reply", () => {
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );

    expect(buildSlackReplyPermalink(target, "1700000010.654321")).toBe(
      "https://example.slack.com/archives/C123/p1700000010654321?thread_ts=1700000000.123456&cid=C123",
    );
  });

  it("rejects insecure and lookalike hosts", () => {
    for (const host of [
      "http://example.slack.com",
      "https://slack.com.evil.example",
      "https://evilslack.com",
    ]) {
      expect(() =>
        parseSlackPermalink(`${host}/archives/C123/p1700000000123456`),
      ).toThrow("HTTPS permalink");
    }
  });

  it("rejects malformed timestamps", () => {
    expect(() =>
      parseSlackPermalink("https://example.slack.com/archives/C123/p123"),
    ).toThrow("timestamp");
    expect(() =>
      parseSlackPermalink(
        "https://example.slack.com/archives/C123/p1700000000123456?thread_ts=invalid",
      ),
    ).toThrow("thread_ts");
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );
    expect(() => buildSlackReplyPermalink(target, "invalid")).toThrow(
      "timestamp",
    );
  });
});
