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

`extensions/smart-docs` is deprecated and disabled. Its code remains, but it is not listed in `package.json -> pi.extensions`, so `/smart-docs` is not registered.

`extensions/tool-display` contains a default-off candidate `edit` override with a strict public `{ text }` schema and no edit reasoning field; it registers the candidate only when `tools.edit.enabled` is true. Before candidate edit is first enabled, disabled edit is not registered. After opt-in, disabled session reloads restore Pi's native definition without renderers and refresh its working directory. Drawing is supplied separately by the Renderer resolver. Its local unified-edit dialect supports selected row operations and Codex Add/Update/Delete patches, but not moves or full upstream compatibility. `prepareArguments` normalizes upstream-compatible raw strings and single text aliases; retired classic, `multi`, and `edits` calls are rejected. `write` remains a separate tool; patch adds require it to be enabled. Permanent delete defaults off and requires config plus exact-plan TUI/RPC confirmation. The implementation is ported from Armin Ronacher and contributors' `mitsuhiko/agent-stuff` `extensions/unified-edit.ts` at commit `4bce45560fa55ace2f5dc8634a63a2af464ddc8b` under Apache License 2.0, with local safety deviations recorded in `docs/adr/0001-local-unified-edit-dialect.md`.

`extensions/obsidian` is active. It loads vault-local `CLAUDE.md` / `CLAUDE.MD` context from configured Obsidian vaults in `~/.pi/agent/obsidian.json`, injects loaded context through provider payload hooks, and exposes `/obsidian status`.

`extensions/docs-list` is active. It registers the `docs_list` tool, backed by the same docs-discovery implementation as the `docs-list` CLI. It defaults to `cwd/docs`, accepts an optional safe relative path (leading `@` stripped), excludes `archive` and `research` directories, and returns readable output plus structured doc metadata and front matter warnings.

`extensions/sift` is active. It registers the advisory `sift_files` tool and `/sift [status|enable|disable]`. Interactive `/sift enable` consent persists globally in the strict owner-only `PI_CODING_AGENT_DIR/sift/config.json` `{ "enabled": boolean }` setting, covering any credentialed Jev provider; disable persists `false`, and headless sessions can honor but not grant consent. Invalid, unreadable, or unsafely permissioned config fails closed. Jev model selection through Pi's classifier runtime, limits, the incomplete secret-detection caveat, and verification status are documented in `extensions/sift/README.md`.

`extensions/skill-router` is active but defaults off. It registers `/skill-router [status|enable|disable]` and no tool. It uses Pi's classifier runtime and credentials; interactive enablement grants paid transfer of bounded skill metadata and conversation text to any credentialed Jev provider. Headless/workers can consume but cannot grant consent. Failure preserves native skill discovery. Jev model selection, effective-catalog policy, privacy bounds, limits, and unverified live rollout gates are documented in `extensions/skill-router/README.md`; Sift consent and prior live verification do not apply to it.

`extensions/no-sleep.ts` is active. It prevents macOS from sleeping while Pi's agent is running by spawning `caffeinate`, registers `/no-sleep [status|on|off|toggle|agent|session]`, defaults to `PI_NO_SLEEP=on`, defaults to agent-scoped caffeination, and supports `PI_NO_SLEEP_SCOPE=session` plus `PI_NO_SLEEP_DISPLAY=1`.

`extensions/auto-rename` is active. After Pi accepts the first raw interactive or RPC prompt, it gives an unnamed session a validated 3–6 word title from that bounded pre-dispatch request, with `agent_settled` persisted-branch fallback, while preserving manual names and guarding session/tree concurrency. It registers `/auto-rename [status|regen]`, uses one no-retry request to the active model, including `openai-codex-responses`, and falls back privately to `session-<8hex>` on failure. The installed Codex adapter does not enforce the requested output-token cap; the operation still has a timeout and strict persisted-title validation. Its only config is `~/.pi/agent/auto-rename.json`; invalid config disables naming and warns. This repo-native rewrite intentionally omits upstream config compatibility, model/endpoint selection, retry chains, prefixes, readable IDs, config initialization, tools, and shell execution. It is informed by [`byteowlz/pi-agent-extensions/pi-auto-rename`](https://github.com/byteowlz/pi-agent-extensions/tree/main/pi-auto-rename), under the MIT License; the full local contract and deviations are in `extensions/auto-rename/README.md`.

`extensions/whimsical` is active. It sets a random whimsical working message at `turn_start`, clears it at `turn_end`, and registers `/whimsical [set]` to show or select bundled message sets (`default`, `negative-energy`) plus valid custom sets from `~/.pi/agent/whimsical/<slug>.json`. Selection persists to the session and `~/.pi/agent/whimsical.json`; latest command session state wins over global config, with unavailable or invalid selected custom sets falling back to bundled `default`. It scans on extension init/session lifecycle and command invocation; completions use the cached list from the last scan. It does not watch files. It is adapted from Armin Ronacher's `agent-stuff` `extensions/whimsical.ts` under Apache License 2.0.

`extensions/fast` is active. It registers:

- `/fast [on|off|status]` (bare `/fast` toggles)
- the `--fast` boolean flag
- the generic `fast` UI status key
- a provider-payload hook that adds `service_tier: "priority"`

The provider hook only patches payloads when Fast Mode is enabled, the selected model supports Fast Mode, and the payload does not already set `service_tier` or `serviceTier`. Model support comes from metadata `fastMode: true`, the built-in allowlist, or the config allowlist. The built-in allowlist includes `openai-codex/gpt-5.4`, `openai-codex/gpt-5.5`, `openai-codex/gpt-5.6-{luna,sol,terra}`, `openai-codex/gpt-6-{astra,luna,sol}`, and `openai-codex/gpt-6.1-sol`. GPT-6.1 Sol is explicitly allowlisted; its backend priority-tier acceptance and fulfillment have not been verified here. Astra is explicitly allowlisted; its backend priority-tier acceptance has not been verified here. GPT-6 Sol/Luna priority-injected requests succeeded, but Pi CLI JSON did not expose the actual response tier. GPT-5.4 Mini and GPT-5.3 Codex Spark remain unsupported. Fast enablement stays a separate persisted user choice.

Fast Mode persists global state and additive exact-match model support in `~/.pi/agent/fast-mode.json`. The config requires boolean `enabled` and array `allowlist` of canonical `provider/id` strings; invalid config fails fast. Writes preserve unknown top-level keys and the existing allowlist. Status notifications report the support source (`model`, `built-in allowlist`, `config allowlist`, or `unsupported`). Config changes are not live-reloaded.

`extensions/model-profiles` is active. It registers `/profile` for machine-local main-session and agent model/thinking choices, persists one global active profile, and renders owned live agent overrides without editing repo agents. Commands, validation, global defaults, per-file ownership, and the cleanup required before disabling are documented in `extensions/model-profiles/README.md`.

`extensions/subagent` is active and registers repo-owned blocking `subagent({task, agent?, cwd?, provider?, model?, thinking?, schema?})`. It replaces both external delegation and task runtimes, not their APIs. Four active children per parent share the checkout; further calls queue. Trusted parent `.pi/agents` shadows global definitions; explicit call settings override role settings, then parent defaults. Children receive only the task, role, and normal workspace guidance, with enforced direct/nested tool controls (not an OS sandbox). Schema-bound calls use internal `StructuredOutput`, with one final missing-report correction and no semantic repair authority. Abort/parent shutdown cancels owned active/queued children, keeps owner-only evidence, and cleans finished tmux sessions. See [subagent](../../extensions/subagent/README.md) for actual tool/native API shape and offline smoke limits.

`extensions/execute` registers `/execute`, execution-scoped `execute_checkpoint`, and native-session ledger hooks. Explicit invocation authorizes one accepted plan; main owns blocking executor calls, dependencies/scopes, verification, and at most two mutation repairs per lineage. Valid reports are claims; only main evidence completes assignments. Missing/error/invalid reports remain unresolved. It never reads/imports legacy `.pi/execute` records, resumes a child conversation, or enforces a private TDD trajectory. See [execute](../../extensions/execute/README.md).

`extensions/goal` keeps its existing checkpoint and budget model. Task mode instructs main to use blocking executor subagents sequentially and update only `goal_checkpoint`; it does not enter the execution ledger. `/review` now uses a closed blocking deterministic `review_run({runId})` then `review_finalize({runId})` pipeline with owned run binding, semantic validation, and freshness checks. Independent whole-repository tests and `bun run check` verify the source cutover; actual offline tmux/Pi children verify the reviewer, synthesizer, verifier, and once-only publication boundary. These deterministic fixtures do not prove paid-model quality or live deployment. Live configuration/setup is unmigrated, and paid-model quality is not validated; see [review](../../extensions/review/README.md).

## Prompt-pipeline command ownership

`extensions/prompt-commands` does not register slash commands. The four names—`grill-me`, `research-brief`, `show-me`, and `wayfinder`—are prompt templates under `prompts/`, so Pi keeps attached images, original input events/source metadata, and native steering/follow-up queue behavior. Each template also contains its complete functional `$@` wrapper as a standalone fallback for `--no-extensions` and Extension load failures; bare `/wayfinder` uses its default start-or-resume request in that fallback. The Extension transforms input events before template argument tokenization only when Pi's effective `expandPromptTemplates` option is enabled; explicit opt-out calls and Extension-origin `sendUserMessage()` content remain literal. Native `AgentSession.steer()` and `followUp()` now emit through that same input pipeline, so their methods remain untouched and each request is transformed exactly once. The transformer accepts the same whitespace delimiter class as Pi templates, consumes one delimiter character, and preserves every remaining character. Only the process-wide `prompt()` options wrapper remains: async-call-scoped state preserves the effective expansion opt-out, lifecycle ownership removes it at shutdown, and deferred cleanup restores the original after any outer wrapper unlinks. Keep the Extension active and the four prompt files deployed together. This adds no Extension registration; the package entry remains unchanged.

## Tool ownership and registration order

Keep `./extensions/skill-router` first in `package.json -> pi.extensions`, before core-prompt/rules full-system-prompt writers and every input transformer. It must capture bounded raw input before expansion; registration order does not grant the separate paid-routing consent, and routing remains default off.

`extensions/tool-display` optionally overrides execution/schema for `read`, `grep`, `find`, `ls`, and `write`, gated by `tools.*.enabled`. Its strict-text unified `edit` candidate is registered only when explicitly enabled and defaults off pending the live gate; the never-enabled path registers no edit. After opt-in, disabled session reloads restore Pi's native schema and execution for the current working directory. Execution registrations contain no renderers. There is no standalone active multi-edit extension entry.

Tool-display draws through one `pi.registerToolRenderer()` Renderer resolver: `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash` by name, companion MCP/codemode/web adapters, plus a Fallback renderer for other tools. Owned names are authoritative while their drawing gate is on; gates off pass `next()` through. For other tools, fallback fills only missing `renderCall`/`renderResult`, preserving renderers the tool already supplies, including resumed calls with no connected tool definition. Retired Task tools have no owned renderer or `output.tasks` gate; historical calls use fill-only fallback. `subagent` stays on its own/default renderers. Drawing gates are `output.read/search/bash/mcp/codemode/web/fallback.enabled` and `diff.enabled`, independent of execution/schema gates.

`extensions/rtk` owns `bash` execution, command rewrite, statistics, and compaction metadata, and always adds required `reasoning` through a local wrapper that strips it before execution and records elapsed time in `details.toolDisplay.durationMs`. RTK imports nothing from tool-display and registers no renderers or resolver. Tool-display does not register `bash`; its resolver draws bash with or without RTK, and RTK badges appear only with `details.rtkCompaction`.

Keep `./extensions/prompt-commands` before `./extensions/auto-rename`, and keep auto-rename before input-transforming `./extensions/context-docs`. This makes auto-rename the outer prompt observer so wrapper shutdown/reload unwinds safely; its retained source still comes from the raw pre-dispatch prompt rather than a generated workflow message.

Renderer resolvers compose in extension load order. RTK registers no resolver, so its relative load order with tool-display does not affect bash drawing; the current manifest order is not a renderer dependency.

## Companion packages

Web access tools come from the external `npm:pi-web-access` companion package, not vendored repo code.

## Deployment model

This repo can be developed from any checkout path. `setup.sh` first installs that checkout's locked production dependencies with Bun, then registers the checkout as a Pi local-path package before reconciling linked prompt files. Pi local-path installation records the source but does not install its dependencies, so this ordering is required for every manifest Extension to load. Registration makes `package.json -> pi.extensions` active in the live Pi config and keeps extension command replacements available during upgrades. Dependency installation is fail-fast. The live Pi config is still the `~/.pi/agent` environment described by setup docs.

For an existing installation, **manually remove both** `npm:@tintinweb/pi-subagents` and `npm:@tintinweb/pi-tasks` registrations before rerunning setup or restarting Pi. Use `pi remove npm:@tintinweb/pi-subagents` and `pi remove npm:@tintinweb/pi-tasks` for global registrations only when present. For project-local registrations, run `pi remove -l <exact-registered-source>` from each affected project root. Also remove `npm:@yzlin/pi-subagents` if the earlier fork is still registered, using the flag for its registration scope. Inspect `pi list` in each affected project and recheck global/project package registrations for duplicates. Setup neither removes nor detects old runtimes; it no longer installs either companion. Keep the checkout's `./extensions/subagent` as the sole delegation runtime, then rerun `./setup.sh` and restart. Old saved state is not imported. These are manual migration instructions, not actions performed by the repository change; live setup/uninstallation/settings and paid-model checks remain out of scope.

The runner requires tmux, Pi 1.0.1+, a full checkout, and Bun for strict-skill children. Other companions and fresh/default setup choices are unchanged. Model profiles still own only generated global agent files, not project-shadowed definitions.

- development clone — where the repo is edited and the installed local-path package points
- live Pi config — where Pi records packages and loads agents, skills, prompts, rules, and extensions

## License context

The root project license is MIT, as declared by `package.json` and `LICENSE.md`.

Copied or adapted upstream materials must include durable source and license attribution in README or nearby docs. Matt-derived materials should mention Matt Pocock, the MIT license name, and the upstream source URL.
