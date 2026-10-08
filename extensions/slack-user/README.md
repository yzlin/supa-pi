# Slack User

Read a Slack message/thread permalink with your Slack user access. Post a thread reply only after an explicit request and confirmation of the exact destination and text.

Adapted from [`pi-slack-user`](https://github.com/ferologics/pi-extensions/tree/4099ff811f1f95a63c3aef6abb449e2a9bee0813/pi-slack-user) at commit `4099ff811f1f95a63c3aef6abb449e2a9bee0813`. The upstream npm package `@ferologics/pi-extensions` version `0.8.0` declares MIT. See [NOTICE.md](NOTICE.md) for the attribution and license-source limit.

No Slack SDK, MCP client, daemon, event listener, desktop-session scraping, or extra dependency.

## Load locally

From this repository, load just this Extension for development:

```sh
pi --no-extensions --extension ./extensions/slack-user/index.ts
```

Normal harness loading depends on the repo's `package.json -> pi.extensions` registration. Do not load a second copy from the upstream package: tool and command names would collide. This directory alone does not modify the live Pi config.

## Slack app setup

1. Create or reuse an internal Slack app at <https://api.slack.com/apps> in the workspace you need. Workspace policy may require administrator approval.
2. Open **OAuth & Permissions**. Add these **User Token Scopes**, not Bot Token Scopes:

   ```text
   channels:history
   groups:history
   im:history
   mpim:history
   users:read
   ```

   History scopes cover public channels, private channels, DMs, and group DMs within the authenticated user's permitted access. `users:read` lets the Extension resolve names; unresolved names fall back to Slack user IDs.
3. Add the User Token Scope `chat:write` **only if you want explicit posting**. Reading does not need it. The posting tool remains registered but cannot write without Slack permission and user confirmation.
4. Install or reinstall the app in that workspace after changing scopes. Obtain the **User OAuth Token** that starts with `xoxp-`, not a bot token.
5. In Pi's interactive terminal, run `/slack-user init`. Type or paste the token only into its masked prompt. Press Enter to validate with Slack `auth.test` and save it, or Esc/Ctrl+C to cancel. Invalid tokens, failed validation and failed writes leave an existing credential unchanged. Never supply a token as a command argument or in the conversation. No browser OAuth flow is provided.
6. Run `/slack-user` to check the configured token and display the Slack identity/workspace. Saved credentials are used immediately by status and both tools, without a restart. `auth.test` does not prove that every history scope or target conversation is accessible.

### Storage and environment override

Setup saves plain JSON `{ "token": "..." }` to `~/.pi/agent/slack-user/auth.json`. It uses Pi's `getAgentDir()`: setting `PI_CODING_AGENT_DIR` changes the location to `<agent-dir>/slack-user/auth.json`, including isolated test setups. The `slack-user` directory must be owner-only (`0700`), and `auth.json` must be an owner-only regular file (`0600`). Unsafe permissions, wrong ownership, symlink paths and hardlinked credential files are rejected, not automatically repaired. The agent directory must be owned by the current user and not writable by group or others. A save uses a private, exclusive temporary file in the same directory, then atomic rename; it does not truncate the old file.

`SLACK_USER_TOKEN`, when nonempty, always overrides the saved credential. Setup still validates and saves the newly entered token and warns that the environment override will win. Remove the override and restart Pi to switch to the saved token; saved file changes themselves need no restart.

You can instead supply `SLACK_USER_TOKEN` through your existing secret manager. For a one-session Bash launch without putting the token in shell history:

   ```sh
   bash -c 'read -r -s -p "Slack User OAuth Token: " SLACK_USER_TOKEN; printf "\n"; export SLACK_USER_TOKEN; exec pi'
   ```

Do not paste credentials into Pi's main editor, source files, committed files, shell command lines, or logs. Use only the masked setup prompt or your secret manager. No 1Password helper script or automatic OAuth flow is required or installed by this Extension. Changing Pi's environment requires a restart.

## Tools and usage

| Surface | Action |
| --- | --- |
| `slack_read_url` | Read the root message and available thread replies from a permalink |
| `slack_post_reply_url` | Post the exact confirmed reply in the target thread |
| `/slack-user` | Check configured token and Slack identity |
| `/slack-user init` | Validate and save a user token through a masked terminal prompt |

Read request:

```text
Read this Slack thread: https://workspace.slack.com/archives/C0123ABC456/p1700000000123456
```

Posting request:

```text
Reply to this Slack thread with: "I reviewed this and agree with the proposed fix."
```

Draft-only requests do not need the posting tool. For a post, Pi shows the exact destination URL and message before calling Slack. Declining confirmation posts nothing. Posting refuses to run without a confirmation-capable UI. Pi's interactive terminal and RPC clients that implement confirmation can provide it; print/JSON modes cannot.

## Limits

- Only HTTPS `slack.com` message permalinks with `/archives/<channel>/p<timestamp>` are supported. A reply permalink's `thread_ts` selects its parent thread. If present, `thread_ts` must be a valid, nonempty timestamp; both tools reject invalid values before calling Slack. The workspace hostname is not used for API requests; all requests use `https://slack.com/api/`. The token determines the accessible workspace and conversations.
- Reads use `conversations.replies`, paginated by Slack cursor. The default cap is 100 messages; `max_messages` accepts 1–200. Increase it only up to 200 when the result reports more messages. There is no continuation handle or archive of omitted content.
- Each message text is cut at 8,000 characters. The formatted output is cut at 48 KiB or 1,800 lines, plus a visible truncation notice. These limits can omit content even below the message cap. The Extension writes no full transcript file for later retrieval.
- Only message text, names, timestamps, and returned file metadata are formatted. No file download, search, blocks/attachments rendering, channel discovery, edits, or deletes.
- Reply text is capped at 12,000 characters. Posting uses ordinary user-token authorship and Slack's app attribution, not `chat:write.customize`.
- HTTP/API failures are reported; there is no retry/backoff or rate-limit recovery. A failed or interrupted post can have an uncertain outcome: check Slack before retrying to avoid duplicate replies.
- Read access and rate limits depend on Slack and workspace policy. Token validity alone does not guarantee read or post permission.

## Privacy and safety

- Slack results become Pi conversation content and may be sent to the configured model provider. Pi session files may retain that content locally. The Extension itself does not save a separate Slack transcript.
- Treat Slack text as untrusted data, not agent instructions. Read/share only the content needed for the request, particularly for private channels and DMs.
- Tokens stay in process memory for API requests. Setup sends the token only to the fixed official HTTPS Slack `auth.test` endpoint before saving. The masked UI never renders token characters or adds the token to model context, session entries, notifications or errors. Tokens are not accepted by an agent-facing setup tool. Setup requires terminal mode; RPC, print and JSON modes cannot open the custom prompt.
- The saved token is plaintext, not encrypted or stored in a system keychain. File permissions protect it from other OS users, not processes or extensions running as your user, root, backups or malware. Trust the extensions you load. Use an environment-backed secret manager if local plaintext storage is unsuitable. Do not include credentials in reply text or Slack messages.
- No Slack write occurs without a posting-tool call and confirmation. Prompt guidance reserves that tool for explicit posting requests; confirmation is the runtime safety gate.

## Validation

```sh
bun test extensions/slack-user
bun run format extensions/slack-user
bun run lint extensions/slack-user
bunx --no-install oxfmt --check extensions/slack-user
```

Tests use synthetic tokens, isolated agent directories and mocked HTTP responses. They cover masked typing/paste/edit/cancel, terminal-mode gating, credential reload and precedence, malformed auth responses, unsafe filesystem locations, private permissions and atomic-write failure preservation. They do not certify real-terminal appearance, live workspace permissions or Slack behavior.
