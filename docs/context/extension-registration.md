---
summary: "Canonical registration, ownership, and deployment notes for SupaPi extensions."
read_when:
  - "Changing package.json extension registration, active/retired extension claims, tool ownership, or setup deployment."
---

# Extension registration context

## Active Extensions

An Extension is active only when listed in `package.json -> pi.extensions`.

When documenting active capabilities, prefer `package.json` over directory presence. Extension code may exist in the repo without being loaded by Pi.

## Registration notes

`extensions/notify.ts` is active and sends a desktop notification after `agent_end`. On macOS in Ghostty, it lazily compiles and launches a cached AppleScript app named `Pi agent` because direct OSC notifications fail in the live setup; this gives notifications the `Pi agent` sender identity. It falls back to OSC 777 if the app cannot compile or launch. Elsewhere, it uses OSC 777, supported by terminals including Ghostty, iTerm2, WezTerm, and rxvt-unicode. It is copied from original author Armin Ronacher's `mitsuhiko/agent-stuff` [`extensions/notify.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/notify.ts) under Apache License 2.0; the local file adds attribution, repository formatting/lint changes, and the macOS Ghostty delivery path.

`read-patch` is retired. Its skill-file full-read behavior now belongs to active `extensions/tool-display`; do not re-add `extensions/read-patch.ts` or `extensions/read-patch/` docs.

`extensions/tool-display` contains a default-off candidate `edit` override with a strict public `{ text }` schema and no edit reasoning field; its session-aware registration delegates to Pi's built-in edit definition whenever the candidate is disabled, so the built-in contract remains available by default until the documented live reliability gate passes. Its local unified-edit dialect supports selected row operations and Codex Add/Update/Delete patches, but not moves or full upstream compatibility. `prepareArguments` normalizes upstream-compatible raw strings and single text aliases; retired classic, `multi`, and `edits` calls are rejected. `write` remains a separate tool; patch adds require it to be enabled. Permanent delete defaults off and requires config plus exact-plan TUI/RPC confirmation. The implementation is ported from Armin Ronacher and contributors' `mitsuhiko/agent-stuff` `extensions/unified-edit.ts` at commit `4bce45560fa55ace2f5dc8634a63a2af464ddc8b` under Apache License 2.0, with local safety deviations recorded in `docs/adr/0001-local-unified-edit-dialect.md`.

`extensions/obsidian` is active. It loads vault-local `CLAUDE.md` / `CLAUDE.MD` context from configured Obsidian vaults in `~/.pi/agent/obsidian.json`, injects loaded context through provider payload hooks, and exposes `/obsidian status`.

`extensions/docs-list` is active. It registers the `docs_list` tool, backed by the same docs-discovery implementation as the `docs-list` CLI. It defaults to `cwd/docs`, accepts an optional safe relative path (leading `@` stripped), excludes `archive` and `research` directories, and returns readable output plus structured doc metadata and front matter warnings.

`extensions/no-sleep.ts` is active. It prevents macOS from sleeping while Pi's agent is running by spawning `caffeinate`, registers `/no-sleep [status|on|off|toggle|agent|session]`, defaults to `PI_NO_SLEEP=on`, defaults to agent-scoped caffeination, and supports `PI_NO_SLEEP_SCOPE=session` plus `PI_NO_SLEEP_DISPLAY=1`.

`extensions/auto-rename` is active. After Pi accepts the first raw interactive or RPC prompt, it gives an unnamed session a validated 3–6 word title from that bounded pre-dispatch request, with `agent_settled` persisted-branch fallback, while preserving manual names and guarding session/tree concurrency. It registers `/auto-rename [status|regen]`, uses one no-retry request to the active model, including `openai-codex-responses`, and falls back privately to `session-<8hex>` on failure. The installed Codex adapter does not enforce the requested output-token cap; the operation still has a timeout and strict persisted-title validation. Its only config is `~/.pi/agent/auto-rename.json`; invalid config disables naming and warns. This repo-native rewrite intentionally omits upstream config compatibility, model/endpoint selection, retry chains, prefixes, readable IDs, config initialization, tools, and shell execution. It is informed by [`byteowlz/pi-agent-extensions/pi-auto-rename`](https://github.com/byteowlz/pi-agent-extensions/tree/main/pi-auto-rename), under the MIT License; the full local contract and deviations are in `extensions/auto-rename/README.md`.

`extensions/whimsical` is active. It sets a random whimsical working message at `turn_start`, clears it at `turn_end`, and registers `/whimsical [set]` to show or select bundled message sets (`default`, `negative-energy`) plus valid custom sets from `~/.pi/agent/whimsical/<slug>.json`. Selection persists to the session and `~/.pi/agent/whimsical.json`; latest command session state wins over global config, with unavailable or invalid selected custom sets falling back to bundled `default`. It scans on extension init/session lifecycle and command invocation; completions use the cached list from the last scan. It does not watch files. It is adapted from Armin Ronacher's `agent-stuff` `extensions/whimsical.ts` under Apache License 2.0.

`extensions/fast` is active. It registers:

- `/fast [on|off|status]` (bare `/fast` toggles)
- the `--fast` boolean flag
- the generic `fast` UI status key
- a provider-payload hook that adds `service_tier: "priority"`

The provider hook only patches payloads when Fast Mode is enabled, the selected model supports Fast Mode, and the payload does not already set `service_tier` or `serviceTier`. Model support comes from metadata `fastMode: true`, the built-in allowlist, or the config allowlist. The built-in allowlist follows the current Codex Fast-capable models exposed by Pi: `openai-codex/gpt-5.4`, `openai-codex/gpt-5.5`, and `openai-codex/gpt-5.6-{luna,sol,terra}`. GPT-5.4 Mini and GPT-5.3 Codex Spark remain unsupported. Fast enablement stays a separate persisted user choice.

Fast Mode persists global state and additive exact-match model support in `~/.pi/agent/fast-mode.json`. The config requires boolean `enabled` and array `allowlist` of canonical `provider/id` strings; invalid config fails fast. Writes preserve unknown top-level keys and the existing allowlist. Status notifications report the support source (`model`, `built-in allowlist`, `config allowlist`, or `unsupported`). Config changes are not live-reloaded.

`extensions/execute` is active. It registers `/execute`, `execute_checkpoint`, and `execute_tasks`. The main session owns pi-task and checkpoint state; `execute_tasks` launches at most four bounded executor agents per round through the pi-subagents workflow runtime with a compact closed native structured-output schema, settled per-task outcomes, hard agent deadlines, eventual session disposal, no inherited extension/parent-bridge tools, and at most one report-only repair by the tool-less `executor-output-repair` agent. For behavior changes and bug fixes, a task marked `tdd: true` uses the generic executor and receives only the canonical `skills/tdd-workflow/SKILL.md` from a fixed bundled path; callers cannot select arbitrary skills. Repaired reports return `needs_verification` and cannot complete a task without independent orchestrator checks.

## Prompt-pipeline command ownership

`extensions/prompt-commands` does not register slash commands. The three names are prompt templates under `prompts/`, so Pi keeps attached images, original input events/source metadata, and native steering/follow-up queue behavior. Each template also contains its complete functional `$@` wrapper as a standalone fallback for `--no-extensions` and Extension load failures. The Extension transforms normal `prompt()` input before template argument tokenization only when Pi's effective `expandPromptTemplates` option is enabled; explicit opt-out calls and Extension-origin `sendUserMessage()` content remain literal. It applies the same raw expansion at the otherwise non-interceptable direct `AgentSession.steer()` and `followUp()` boundary, so its output no longer starts with a slash command and cannot be expanded a second time. It accepts the same whitespace delimiter class as Pi templates, consumes one delimiter character, and preserves every remaining character. The unavoidable process-wide session-method patch uses async-call-scoped prompt options and lifecycle-owned transformers: the newest owner supplies current behavior, shutdown removes that owner, and deferred cleanup restores each original method after any outer wrapper unlinks. Keep the Extension active and the three prompt files deployed together.

## Tool ownership and registration order

`extensions/tool-display` owns `read`, `write`, and optional compact renderers for `grep`, `find`, and `ls`. Its strict-text unified `edit` candidate is owned only when explicitly enabled and defaults off pending the live gate; disabled sessions receive Pi's built-in edit definition instead. There is no standalone active multi-edit extension entry.

`extensions/rtk` owns `bash` execution, output rewrite, statistics, and compaction metadata. RTK may reuse tool-display bash rendering helpers, but tool-display must not register `bash`.

Keep `./extensions/prompt-commands` before `./extensions/auto-rename`, and keep auto-rename before input-transforming `./extensions/context-docs`. This makes auto-rename the outer prompt observer so wrapper shutdown/reload unwinds safely; its retained source still comes from the raw pre-dispatch prompt rather than a generated workflow message.

Keep `./extensions/rtk` before `./extensions/tool-display` in `package.json -> pi.extensions` so ownership stays explicit and reviewable.

## Companion packages

Web access tools come from the external `npm:pi-web-access` companion package, not vendored repo code.

## Deployment model

This repo can be developed from any checkout path. `setup.sh` first installs that checkout's locked production dependencies with Bun, then registers the checkout as a Pi local-path package before reconciling linked prompt files. Pi local-path installation records the source but does not install its dependencies, so this ordering is required for every manifest Extension to load. Registration makes `package.json -> pi.extensions` active in the live Pi config and keeps extension command replacements available during upgrades. Dependency installation is fail-fast. The live Pi config is still the `~/.pi/agent` environment described by setup docs.

When changing setup or installation docs, keep this distinction clear:

- development clone — where the repo is edited and the installed local-path package points
- live Pi config — where Pi records packages and loads agents, skills, prompts, rules, and extensions

## License context

The root project license is MIT, as declared by `package.json` and `LICENSE.md`.

Copied or adapted upstream materials must include durable source and license attribution in README or nearby docs. Matt-derived materials should mention Matt Pocock, the MIT license name, and the upstream source URL.
