# Sift

Sift screens explicit workspace files for relevance before the agent reads them fully. Its `sift_files` tool returns ordered `P(relevant)` judgments; these are advisory and never authorize another action.

## First action and consent

Run `/sift status`, then `/sift login` if needed, and `/sift enable`. Enabling interactively explains the transfer and charge boundary and requires confirmation. Enablement and the 100-judgment budget reset each session. Headless use requires the explicit `PI_SIFT_ENABLED=1` environment opt-in; `/sift enable` never silently opts in outside the TUI.

## Data boundary and limits

Each selected file's canonical workspace-relative path (slash-separated), bounded contents, and the query are sent to TypeSafe's fixed Jev endpoint (`https://api.typesafe.ai/v1/systemone`) using `jev-latest`. Nothing is scanned automatically. Paths must resolve inside the current workspace. Calls allow 1–20 unique paths, process at most four requests concurrently, read at most 50 KB per text file, do not retry, and share 100 attempted judgments per session. Results preserve input order and report partial failures, truncation, and remaining budget. Contents and judgments are neither logged nor persisted.

Sensitive filenames and obvious key/token markers are blocked locally, but **secret detection is incomplete**. Inspect candidates before consenting to external transfer. TypeSafe usage may incur charges.

## Authentication

`/sift login` uses hidden TUI input, validates locally, sends one synthetic Noul verification request, and saves only a verified key in an owner-only store under `$PI_CODING_AGENT_DIR/sift/` (or the default Pi agent directory). `TYPESAFE_API_KEY` always takes precedence and login will not overwrite stored auth while it is present. `/sift logout` clears only the stored credential and disables future calls; it cannot clear an environment credential.

Commands are `/sift login`, `logout`, `status`, `enable`, and `disable`; bare `/sift` shows status.

## Verification

Run `bun test extensions/sift`. Automated integration tests mock Jev transport. A user-consented `/sift login` verification subsequently completed one live synthetic Jev judgment and saved the credential successfully, confirming the direct API response contract without sending repository content. The `sift_files` path is covered offline and was not given a second live request.

## Attribution

The scoped hidden-input/authentication UX is adapted from [DevMortimer/pi-typesafe](https://github.com/DevMortimer/pi-typesafe), under the MIT License. See `LICENSE.pi-typesafe`. The implementation does not copy code from `kbhuw/jev-sift`.
