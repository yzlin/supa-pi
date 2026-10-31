---
name: slack-links
description: Use whenever the user shares a Slack URL (*.slack.com/archives/...) or asks to read, digest, or summarize a Slack message or thread. Retrieve it through the executor MCP Slack app; never web-fetch or browse Slack URLs.
---

# Slack links via Executor

Slack pages need a signed-in session, so `fetch_content`, `web_search`, and browsers cannot read them. The executor MCP server (`mcp__executor`, a codemode server) exposes the user's linked Slack accounts as the `slack` app.

## Retrieve

Run everything in one `tools.mcp__executor__execute({ code })` program from codemode, and return only the fields needed.

1. Parse the URL `https://<workspace>.slack.com/archives/<channel>/p<16 digits>`:
   - `ts` = the first 10 digits + `.` + the last 6 digits.
   - If the query string has `thread_ts`, the link is a reply; use `thread_ts` as the thread ts.
2. Pick the account for `<workspace>`: `tools.search({ namespace: "slack", query: "conversations replies", limit: 1 })` lists the linked account IDs in the item's `input` (`accountId: "acc_…" | "acc_…"`). Call `tools.slack.auth.test({ accountId, input: {} })` for each, and use the one whose `url` matches the workspace.
3. Fetch:
   - Thread: `tools.slack.conversations.replies({ accountId, input: { query: { channel, ts, limit: 200, cursor } } })`; repeat while `response_metadata.next_cursor` is set.
   - Single message without replies: the same call returns just that message.
   - Names: `tools.slack.users.info({ accountId, input: { query: { user } } })` once per unique user ID.
4. Return `who`, `ts`, `text`, file names, and reactions per message. Do not return raw payloads.

Read exact signatures with `tools.search.describe` before calling a tool you have not used in this session. Tool inputs nest Slack arguments under `input.query`; never pass a `token`.

## Failures

- `slack` tools missing, or `AccountRequired`: tell the user to link the workspace's Slack account to the Executor Slack app.
- Other errors: report the Executor error code and message.
- Do not fall back to `fetch_content`, a browser, or guessing the content.
