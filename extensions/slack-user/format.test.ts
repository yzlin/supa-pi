import { describe, expect, it } from "bun:test";

import { formatSlackThread } from "./format.js";
import type { SlackThread } from "./slack.js";
import { parseSlackPermalink } from "./url.js";

describe("Slack thread formatting", () => {
  it("hydrates authors, mentions, links, and file metadata", () => {
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );
    const thread: SlackThread = {
      messages: [
        {
          user: "U123",
          text: "Hi <@U456>, see <https://example.com|the doc> &amp; reply.",
          ts: "1700000000.123456",
          files: [
            {
              id: "F123",
              name: "design.png",
              mimetype: "image/png",
              permalink: "https://example.slack.com/files/U123/F123/design.png",
            },
          ],
        },
      ],
      users: new Map([
        ["U123", "Alice"],
        ["U456", "Bob"],
      ]),
      truncatedByMessageLimit: false,
    };

    const result = formatSlackThread(target, thread);

    expect(result.outputTruncated).toBe(false);
    expect(result.text).toContain("## Alice — 2023-11-14 22:13:20 UTC");
    expect(result.text).toContain(
      "Hi @Bob, see [the doc](https://example.com) & reply.",
    );
    expect(result.text).toContain("📎 design.png (F123 · image/png)");
  });

  it("distinguishes empty threads from a message cap", () => {
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );
    const result = formatSlackThread(target, {
      messages: [],
      users: new Map(),
      truncatedByMessageLimit: false,
    });
    expect(result.text).toContain("No messages returned.");
    expect(result.outputTruncated).toBe(false);
    const limited = formatSlackThread(target, {
      messages: [{ ts: "1700000000.123456", text: "One" }],
      users: new Map(),
      truncatedByMessageLimit: true,
    });
    expect(limited.text).toContain("Messages: 1 (more available)");
    expect(limited.text).toContain("Increase max_messages");
  });

  it("marks per-message truncation", () => {
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );
    const result = formatSlackThread(target, {
      messages: [
        { ts: "1700000000.123456", text: `${"x".repeat(8000)}OMITTED` },
      ],
      users: new Map(),
      truncatedByMessageLimit: false,
    });
    expect(result.text).toContain("[message text truncated]");
    expect(result.text).not.toContain("OMITTED");
  });

  it("marks aggregate output truncation", () => {
    const target = parseSlackPermalink(
      "https://example.slack.com/archives/C123/p1700000000123456",
    );
    const result = formatSlackThread(target, {
      messages: Array.from({ length: 20 }, (_, index) => ({
        ts: `1700000000.${String(index).padStart(6, "0")}`,
        text: "x".repeat(8000),
      })),
      users: new Map(),
      truncatedByMessageLimit: false,
    });
    expect(result.outputTruncated).toBe(true);
    expect(result.text).toContain("No local Slack transcript was written.");
    expect(Buffer.byteLength(result.text)).toBeLessThan(48 * 1024 + 200);
  });
});
