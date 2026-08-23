# Auto-rename

Auto-rename gives an unnamed Pi session a concise semantic title after the session's next completed agent run. It is a repo-native rewrite informed by [`byteowlz/pi-agent-extensions/pi-auto-rename`](https://github.com/byteowlz/pi-agent-extensions/tree/main/pi-auto-rename), which is MIT licensed. This local extension and repository are also distributed under the MIT license.

## Behavior

The automatic attempt runs after `agent_settled`, not at session start, resume, or before agent work. This means a long first run remains unnamed until it settles, and an existing unnamed session is named gradually after its next settled run.

For a new branch, the source is the first bounded raw interactive or RPC user input, captured before skill or prompt-template expansion. Extension-injected input is ignored. The active registration keeps auto-rename ahead of input-transforming extensions such as context-docs so this boundary remains intact. When a resumed or tree-navigated branch already has a persisted user message, automatic naming keeps that earlier request instead of replacing it with a later follow-up. If neither lifecycle source is available, auto-rename falls back to the first persisted user message on the active branch.

Automatic naming preserves every existing or manually assigned name, including a `/name` change made while generation is in flight. Use Pi's built-in `/name` for manual naming. Explicit regeneration is the only auto-rename operation allowed to replace the current name.

## Commands

- `/auto-rename status` (or bare `/auto-rename`) reloads configuration and reports state, current name, pending work, bounded settings, and the last non-sensitive failure category.
- `/auto-rename regen` explicitly replaces the current name using the retained raw request or persisted fallback. Missing session/source and concurrent-operation cases are reported without changing the name.

Other arguments show `/auto-rename [status|regen]` usage.

## Configuration

Auto-rename reads only the optional global file:

```text
~/.pi/agent/auto-rename.json
```

There is no project-local configuration or precedence chain. A missing file uses these defaults; every field is optional, but unknown fields are rejected:

| Field | Type | Default | Runtime constraint |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | — |
| `prompt` | string | `Generate a concise 3–6 word plain Title Case session title for the user's request. Return only the title.` | non-whitespace, 1–1,000 characters |
| `maxQueryLength` | integer | `2000` | 100–20,000 |
| `maxNameLength` | integer | `80` | 12–200; accepted titles still have an absolute 80-character limit |
| `timeoutMs` | integer | `10000` | 100–60,000 milliseconds |
| `debug` | boolean | `false` | — |

[`configuration_schema.json`](./configuration_schema.json) provides editor support; runtime validation remains authoritative. Configuration is loaded at session start and by status checks, not watched. If an existing file is unreadable, malformed, contains unknown keys, or has invalid values, auto-rename disables itself rather than using enabled defaults. It warns once in the UI, or writes the concise `auto-rename: disabled-invalid` warning to the console in headless mode.

## Model and output safety

Each operation makes at most one bounded request through `ctx.modelRegistry.complete()` using only the active `ctx.model` and its existing authentication/provider behavior. For supported model APIs, it sends the configured short system prompt and at most `maxQueryLength` source characters, requests at most 32 output tokens, uses `timeoutMs`, sets provider retries to zero, and owns an abort signal. The installed `openai-codex-responses` adapter does not put its `maxTokens` option into the final provider payload, so auto-rename skips model generation for that API and uses the deterministic fallback instead of making an unbounded request. It does not expose tools, execute commands, or execute/interpolate model output.

Model output is untrusted. Normalization removes harmless wrapping quotes, horizontal whitespace noise, and ending punctuation. Validation then requires plain one-line text of 3–6 words, within the configured and absolute length limits, with only allowlisted separators. Markup, controls, URLs (including generic URI schemes), reasoning labels, and suspicious credential/token-shaped fragments are rejected rather than redacted. Unavailable models, timeout, abort, provider failure, empty output, or rejected output use `session-<8hex>`, where the suffix is the first eight SHA-256 hex characters of the session ID. The fallback never derives from request text.

The nested naming request is hidden extension overhead and may not be reflected in normal Pi session usage totals. No audit/session entry is added solely for it.

## Privacy and logging boundary

The active provider receives the bounded naming prompt and bounded first-request source. Auto-rename does not send them elsewhere. It keeps only a session-local bounded raw copy and clears it on session replacement/tree changes and shutdown. Successful and expected fallback naming are silent. Debug logging is limited to lifecycle labels and failure categories: it never logs raw prompts, model output, credentials, secret-like rejected text, or full provider errors.

## Session, tree, and concurrency safety

Only one naming operation may be active. Before starting and before writing, the extension checks the session and stable tree generation, current name, and enabled state. Ordinary messages may advance the branch leaf without invalidating in-flight naming; session replacement, shutdown, and tree navigation abort and invalidate stale work. Manual name changes observed through `session_info_changed` block automatic writes. Repeated settlement is deduplicated per stable branch generation after the current operation finishes. Opening a branch does not itself rename it; an unnamed branch is reconsidered only after a later settlement. The settlement handler starts naming in the background, so provider latency does not delay Pi's public settlement or idle completion. Explicit `regen` uses the same timeout, validation, fallback, and stale-session guards.

The extension does not require dialogs or TUI components. Naming works in TUI, RPC, and other headless/non-TUI sessions. UI notifications are used when available. Invalid configuration and session-name persistence failures use concise console warnings in headless mode. Command status/error notifications have no separate headless renderer.

## Limitations and intentional deviations

- Titles appear only after agent settlement, never merely on resume. One extra active-model request is made for each unnamed session that reaches supported model generation; `openai-codex-responses` uses the opaque fallback without a model request because its adapter cannot enforce the output cap.
- Strict validation can reject legitimate punctuation-heavy technical titles and choose the opaque fallback.
- Existing unnamed sessions are renamed gradually when next used.
- Configuration is global-only, so projects cannot define separate naming policy.
- This rewrite does not preserve upstream configuration compatibility.
- It does not support explicit primary/fallback model selection, cheapest-model discovery, direct OpenAI-compatible endpoints, endpoint credentials, provider retry chains, or connectivity commands.
- It does not support static/dynamic prefixes, `prefixCommand`, shell execution, prefix-only mode, readable adjective/noun IDs, custom wordlists, environment-provided readable IDs, or config initialization commands.
- It intentionally uses the active Pi model, a single request with no retry, a private hash fallback, strict validation, post-`agent_settled` timing, and `/auto-rename status|regen` instead of those upstream facilities.

## Attribution

Auto-rename is a clean, repo-native rewrite based on the behavior of [`byteowlz/pi-agent-extensions/pi-auto-rename`](https://github.com/byteowlz/pi-agent-extensions/tree/main/pi-auto-rename). Upstream is copyright its contributors and licensed under the MIT License. See this repository's [`LICENSE.md`](../../LICENSE.md) for the local MIT license.
