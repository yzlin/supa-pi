# Sift

Sift screens explicit workspace files for relevance before the agent reads them fully. Its `sift_files` tool returns ordered `P(relevant)` judgments; these are advisory and never authorize another action.

## First action and consent

Run `/sift status`, make a Jev classifier model available if status shows `model=none`, and run `/sift enable`. Enabling interactively names the selected model, explains the transfer and charge boundary, requires confirmation, and persists `{ "enabled": true }` (consent to any credentialed Jev provider) in `$PI_CODING_AGENT_DIR/sift/config.json` (or the default `~/.pi/agent/sift/config.json`). `/sift disable` persists `false`. Consent saved before the move to Pi's classifier runtime uses the same format and now also covers every credentialed Jev provider. The config is written atomically with owner-only permissions; missing config defaults to disabled, while invalid, unreadable, or unsafely permissioned config fails closed. Headless sessions honor the persisted setting but cannot change it to enabled because they cannot show the consent prompt. The 100-judgment budget still resets each session.

## Data boundary and limits

Each selected file's canonical workspace-relative path (slash-separated), bounded contents, and the query are sent as one Jev `bool` question through Pi's classifier runtime (`ctx.modelRegistry.classify`). Nothing is scanned automatically. Paths must resolve inside the current workspace. Calls allow 1–20 unique paths, process at most four requests concurrently, read at most 50 KB per text file, do not retry, and share 100 attempted judgments per session. Results preserve input order and report partial failures, truncation, and remaining budget. Contents and judgments are neither logged nor persisted.

Sensitive filenames and obvious key/token markers are blocked locally, but **secret detection is incomplete**. Inspect candidates before consenting to external transfer. Classifier usage may incur charges with the selected provider.

## Model and authentication

Sift owns no credentials. Each status or tool call uses `typesafe/jev-latest` when Pi has credentials for it; otherwise it uses the first credentialed Pi classifier whose ID contains `jev`, such as OpenRouter, Cloudflare Workers AI, Vercel AI Gateway, or OpenCode Jev. Content can therefore go to any of those providers; status and the consent prompt show the currently selected model. Configure credentials through Pi, for example `TYPESAFE_API_KEY` or `/login`. Without a credentialed Jev model, enabling and tool calls fail without sending content.

Commands are `/sift status`, `enable`, and `disable`; bare `/sift` shows status. Credentials stored by the removed `/sift login` in `$PI_CODING_AGENT_DIR/sift/auth.json` are no longer read; delete that file if it exists.

## Verification

Run `bun test extensions/sift`. Automated integration tests mock Pi's model registry. An earlier user-consented live synthetic Jev judgment confirmed the direct TypeSafe response contract; the Pi classifier path has not had a live request.
