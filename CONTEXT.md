# CONTEXT

## Product purpose

`supa-pi` is Ethan's personal-but-reusable Pi agent harness. It curates local Pi extensions, specialized agents, reusable skills, prompt templates, and rule packs to make Pi sessions more capable and consistent.

The repository is optimized for local workflow quality and maintainable agent behavior, not public-package stability.

## Domain model

- **Extension** — a Pi runtime module registered through `package.json -> pi.extensions`. Extensions add commands, tools, UI behavior, or workflow prompts.
- **Command** — a slash-command interface supplied by an Extension or a native prompt template. _Avoid_: Extension-only command.
- **Prompt transformer** — an Extension input hook that expands selected prompt invocations without registering their slash commands. _Avoid_: command registrar.
- **Agent** — a specialized subagent definition under `agents/` used for delegated work.
- **Skill** — reusable task-specific instructions under `skills/` or imported skill locations.
- **Domain-modeling skill** — reusable canonical semantic primitive under `skills/domain-modeling/` that owns terminology sharpening, scenario testing, contradiction discovery, boundary analysis, and ADR-candidacy assessment.
- **Context-docs workflow** — sole owner of durable-context routing, formats, commands, and persistence; it consumes completed domain-modeling packets without delegating them back.
- **Rule pack** — coding, testing, security, or workflow guidance under `rules/`.
- **Prompt template** — durable prompt text under `prompts/` or an extension-local prompt file.
- **Setup script** — `setup.sh`, which prepares the live Pi agent environment.
- **Companion package** — external Pi package installed by `setup.sh` to extend the local harness.

## Domain glossary

- **Active Extension** — an Extension currently listed in `package.json -> pi.extensions`.
- **Disabled Extension** — extension code present in the repo but not listed in `package.json -> pi.extensions`.
- **Live Pi config** — the runtime Pi agent directory under `~/.pi/agent`.
- **Development clone** — any checkout used for editing this repo. It does not have to be `~/.pi/agent`.
- **Core orchestration contract** — always-on main-session policy for autonomy, direct-versus-delegated work, verification, and output behavior. _Avoid_: routing rule, workflow rule.
- **Agent role contract** — a delegated worker's responsibility, tools, model, boundaries, and output contract; reusable implementation methodology belongs in a Skill. _Avoid_: methodology agent.
- **Workflow skill** — reusable task procedure loaded only when the work matches, shared by direct and delegated execution when applicable. _Avoid_: specialist worker, routing policy.
- **Task rule** — selectively loaded user or project policy defining when guidance applies and which outcomes are required; it does not own always-on orchestration routing. _Avoid_: dispatcher, agent catalog.
- **TDD Slice** — an atomic behavior-change task that uses the canonical TDD skill as implementation guidance; completion requires independent main-session verification. _Avoid_: TDD phase.
- **Sift** — an active SupaPi Extension that screens explicit workspace file candidates for relevance before the main agent reads their full contents. _Avoid_: search, index.
- **File judgment** — one independent Jev evaluation assigning a probability of relevance to one bounded file against the caller's query. _Avoid_: proof, authorization.
- **Matt-compatible context docs** — `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`, and optional `docs/context/` notes.
- **Model profile** — a named, machine-local set of main-session and agent model/thinking choices that `/profile` applies in one switch. _Avoid_: mode, loadout, preset.
- **Default profile** — the reserved Model profile that restores repo `agents/*.md` frontmatter and any captured `defaultMain` model/thinking choices, then clears that snapshot; without a snapshot, main remains unchanged. It cannot be defined in profile config. _Avoid_: reset profile, base profile.
- **Generated agent override** — a live agent file rendered from a repo agent plus the active Model profile, replacing only `model`/`thinking`. _Avoid_: agent patch, frontmatter rewrite.
- **Final report** — the reply that closes multi-step work: edits, investigations, delegated work, or review, diagnose, Wayfinder, and grill summaries. One-line answers and lookups are not Final reports. _Avoid_: summary turn, any long reply.
- **Plain report** — the output style for Final reports and reviewer `why`/`change` text: roughly 80% of ASD-STE100 Simplified Technical English, using `CONTEXT.md` vocabulary. _Avoid_: STE mode, caveman.
- **Explainer rung** — one output format on the `/show-me` ladder: text, diagram, or HTML. Video is a deferred rung. _Avoid_: view mode.

## Product constraints

- Keep extension boundaries isolated. Extensions under `extensions/` should not import from sibling extensions unless explicitly refactored into shared non-extension code.
- Prefer small, durable Markdown context over chat-only decisions.
- Develop anywhere, but treat `~/.pi/agent` as the live Pi config location described by setup docs.
- Pi 0.84 or newer owns regular/fullscreen viewport composition. SupaPi defaults newly created settings to fullscreen, supports both modes, and does not rewrite existing TUI-mode preferences.
- Do not document secrets, credentials, tokens, private keys, or raw sensitive logs.
- Root project license is MIT. Copied or adapted upstream materials must carry source and license notices in durable docs or README entries.
- Domain modeling is skill composition, not a command or production runtime registration; grilling invokes it only when explicit domain signals arise.
- Linting and formatting use oxlint (type-aware) and oxfmt extending Ultracite presets, tuned to prior Biome intent (Biome-equivalent strictness, Biome-style output, grouped imports) over all repo TypeScript and JSON; `bun run check` is the gate. Vendored upstream skill examples stay verbatim.

## Oversight output: implemented product direction

Implemented as prompt and skill text. Contract tests verify the wiring; they do not prove model adherence. The idea comes from Andrej Karpathy's 2026-10-02 post on making LLM output easier to understand. The goal is faster oversight of agent output.

- Style is split by surface. Chat replies and progress updates stay telegraph. Final reports use Plain report style. Caveman mode, when on, overrides both.
- The `plain-report` skill owns the Plain report rules. The core prompt `<output>`, `AGENTS.global.md`, reviewer, synthesizer, and verifier agents, `/wait-what`, and Wayfinder and grilling summaries reference it. The skill paraphrases a subset of ASD-STE100; it does not copy the spec text or dictionary.
- `/review` takes part only through reviewer-written `why`/`change` text. The renderer and report contract stay unchanged.
- `/show-me [text|diagram|html] [topic]` re-renders the last result at the chosen Explainer rung. With no argument, it picks the smallest useful rung. HTML explainers are discardable: they are written to `$TMPDIR/supa-pi-show-me/`, shown through Glimpse, and never stored in the repo.
- Verification is contract tests that each surface references `plain-report`, plus a manual before/after comparison of 3–5 real reports. Model adherence is not tested automatically.

## Upstream-native execution

`/execute` delegates through native `SubagentWorkflow`; see `extensions/execute/README.md`. Both execute and review now use public upstream tools; no repository fork SDK dependency or private upstream imports remain.

- Standardize execution on `@tintinweb/pi-subagents` workflows and `@tintinweb/pi-tasks`, rather than preserving the fork's custom execution runtime. Load only one subagents implementation.
- Preserve explicit-plan and Execution Brief command behavior, ambiguity resolution, and dangerous-action approval.
- Main-session independent verification remains completion authority. Upstream structured output validates report shape, not code correctness. TDD becomes worker guidance rather than runtime-enforced trajectory proof.
- Permit parallel writes only for disjoint scopes; dependent work requires verified prerequisites. Safe local repair remains bounded to two attempts per original task lineage.
- Use upstream workflow journals for same-session resume, with current-state verification; retire execute-specific checkpoint recovery and automatic continuation. Existing `.pi/execute` records remain untouched, without automatic import or reuse. Cross-session automatic recovery is outside this target.
- Execute only in the session's target workspace; alternate-workspace dispatch is outside this target.

## Public-workflow review

The approved migration is implemented after public-sandbox and local lifecycle validation; this does not claim live activation or full live E2E. See `extensions/review/README.md` for the version-sensitive public artifact contract (inspected upstream 0.19.0).

- `/review` prepares one exact public `SubagentWorkflow` run after local configuration/trust/preflight, visible in the native Workflows UI. The main session submits a compact run-bound marker; the public Pi `tool_call` hook validates and expands it in memory to the authorized inline source, avoiding model regeneration of the full program. Repository-owned deterministic code validates reviewer coverage and lossless clustering between stages; model instructions do not replace these checks.
- `review_finalize({runId})` accepts no results or paths, binds observed public call/result/native completion, reads the complete bounded journal rather than previews, and checks target freshness before/after. Local finalization remains report authority: bind results to the prepared run, target, and model configuration; validate findings and derive provenance/support before rendering and persisting the existing report contract. Reject unknown, duplicate, already-finalized, cancelled, session-switched, or stale-target submissions.
- Preserve target selection, model configuration/trust and preflight, role-by-model coverage and concurrency limits, independent verification, and `/review-summary` and `/review-fix` integration. Reviewer jobs use awaited native parallel batches of at most four inside one workflow, retaining dispatch/result order. Reject unsupported `off` in preflight/preparation without changing saved configs; supported efforts pass through. Provider schemas explicitly type every enum, use singleton reviewer enums, and require notes arrays (local validation still allows omission).
- Use upstream schema retry only. Semantic validation failures receive no additional local repair; reviewer failures follow existing degraded-coverage rules, while invalid downstream stages fail review.
- Synthesizer tool isolation becomes upstream agent configuration rather than override-proof local enforcement. `/review cancel` invalidates report publication; native Workflows UI stops workers. Parent cancellation no longer guarantees worker termination.
- Interrupted reviews require a fresh invocation; workflow resume is outside this migration. The unused fork SDK dependency is removed. Setup does not detect or reject duplicate subagents runtimes; verify registration manually. Missing/incompatible journals fail closed; at most one report is published. No private upstream API adapter is used.

## Wayfinder: implemented product direction

Wayfinder is a SupaPi workflow for carrying unresolved decisions across sessions until the route to a destination is clear. It does not own implementation planning or delivery. The canonical workflow is implemented in `skills/wayfinder/SKILL.md`, with a thin prompt entrypoint at `prompts/wayfinder.md`; this does not claim live installation or end-to-end UX validation.

- **Decision map** — a project-local planning record containing a destination, standing notes, decision links, unspecified areas, and explicit exclusions. _Avoid_: execution plan.
- **Decision question** — a precise question with its own evidence, dependencies, answer, and revision history. A blocked but precise question is still recorded; areas not yet precise enough remain unspecified. _Avoid_: implementation task.
- **Ready question** — an unresolved question whose dependencies are resolved. _Avoid_: unblocked execution task.
- **Decision branch** — a coherent set of related questions suitable for one planning session. _Avoid_: one-ticket session.

Approved boundaries:

- Maps live in versioned `.pi/wayfinder/<name>/` directories, with `MAP.md` as the index and separate question files as the authoritative answer records. Planning records remain separate from canonical context docs and execution task state.
- V1 supports one active session per map, not concurrent decision writers. Research workers return findings to the owning session rather than editing shared map state. Skill-level ownership checks are not atomic locking guarantees.
- Agents may resolve verified factual questions; the human owns preferences, scope, and tradeoffs. Question types are research, grilling, prototype, and prerequisite task. Prerequisite tasks exist only to unblock decisions, not to deliver the destination.
- Each prototype or prerequisite task requires approval of its actions, artifact location, edits, side effects, verification, and cleanup before work. External or destructive actions require specific approval. Prototype acceptance requires human feedback; prerequisite-task completion requires verification against agreed criteria.
- Progress is saved incrementally. Changed decisions retain history and reopen affected questions for revalidation. Resume verifies saved state and relevant evidence, then continues the active branch or selects the first ready question in explicit map order; ambiguous map selection requires clarification.
- A map is complete when no unresolved in-scope choices or unexplained unspecified areas remain. Its output is a decision summary and handoff to separate execution planning, not automatic implementation.
- Promotion into canonical context docs is proposed separately and requires explicit approval. Context-docs retains persistence ownership; domain-modeling retains ADR qualification ownership.

The implementation is a canonical workflow skill with a thin `/wayfinder` entrypoint, composing existing grilling, domain-modeling, and research guidance rather than introducing a dedicated state engine. The shipped schema and ownership/checkpoint representation are canonical in `skills/wayfinder/templates/MAP.md`, `skills/wayfinder/templates/QUESTION.md`, and `skills/wayfinder/SKILL.md`. The design is adapted from [Matt Pocock's MIT-licensed Wayfinder skill at pinned commit `74ca5fe077456a0b3b2f5310cf9430999fd0b5fd`](https://github.com/mattpocock/skills/blob/74ca5fe077456a0b3b2f5310cf9430999fd0b5fd/skills/engineering/wayfinder/SKILL.md); the retained notice is `skills/wayfinder/LICENSE.upstream`.

## Sift: implemented product direction

Sift is implemented and registered as an active Extension. Focused mocked integration tests pass, paired isolated Pi scenarios verify tool selection and non-selection, and a user-consented login (since removed) completed one live synthetic direct-TypeSafe Jev judgment without repository content. Sift now classifies through Pi's classifier runtime; that path has no live request yet.

- V1 is a repo-owned Extension with one agent tool, `sift_files`, and one human command, `/sift`. The tool accepts one relevance query plus explicit local file paths and returns ordered per-file `P(relevant)` judgments, truncation state, and failures. It does not scan automatically, filter by a caller threshold, explain judgments, or expose Jev's general Choice/Score question types.
- Each file is evaluated independently as one Jev `bool` question through `ctx.modelRegistry.classify`. Sift prefers `typesafe/jev-latest` and otherwise uses the first credentialed Pi classifier whose ID contains `jev`. It owns no credentials and copies no code from the unlicensed `jev-sift` repository.
- The trust boundary is the current workspace: real paths must remain under `ctx.cwd`, including after symlink resolution. Only the canonical workspace-relative path, bounded text content, and query are sent; only bounded text files are eligible. Known sensitive filenames and obvious private-key or token markers are blocked locally, with an explicit warning that this is not complete secret detection.
- Workspace content may leave the machine only after interactive `/sift enable` consent, persisted globally as a strict owner-only `PI_CODING_AGENT_DIR/sift/config.json` `{ "enabled": boolean }` setting; enabled consent covers any credentialed Jev provider, including consent saved before the classifier-runtime move. Missing config defaults to disabled; invalid, unreadable, or unsafely permissioned config fails closed. `/sift disable` persists global disablement, headless sessions may consume but not grant persisted consent, and the setting is re-read for each status or tool call. Credentials come from Pi (`TYPESAFE_API_KEY`, `/login`, or other Jev provider auth); consent and status name the selected model. File contents and judgments are neither persisted nor logged.
- V1 permits at most 20 files per call, four concurrent requests, 50 KB per file, no automatic retries, and 100 attempted file judgments per session. Cancellation stops new work; one file's failure does not erase other results.
- Completion requires mocked unit/integration coverage, inspection of the exact agent-facing schema, isolated Pi tests for appropriate use and non-use plus auth UX, one user-consented live Jev smoke request, targeted tests, `bun format`, and `bun run check`.
- Deferred from V1: URLs, inline text, outside-workspace roots, typed questions, explicit provider pinning, configurable limits, and persistent daily cost caps.

## Skill router: implemented, registered, and default off

The Skill router is an independently consented Extension at `extensions/skill-router/`. It is first in `package.json -> pi.extensions` so it can capture bounded raw input before prompt writers and input transformers, but registration does not enable paid routing. Commands, limits, privacy details, and evidence are canonical in `extensions/skill-router/README.md`.

- **Skill router** — selects applicable skills before model execution and supplies their instructions while retaining recovery discovery. _Avoid_: skills manager, Sift.
- **Skill applicability judgment** — one advisory JEV probability that a skill should load for the bounded task context. It does not grant workflow or action authorization. _Avoid_: permission, proof.

Implemented boundaries:

- `extensions/skills/` still owns skill management/resource discovery and `extensions/sift/` owns explicit file judgments. The router has its own JEV adapter over `ctx.modelRegistry.classify` and strict global consent config; it owns no credentials. It prefers `typesafe/jev-latest`, otherwise the first credentialed Pi classifier whose ID contains `jev`. `/skill-router [status|enable|disable]` grants explicit paid conversation-transfer consent naming the selected model; enabled consent, including consent saved before the classifier-runtime move, covers any credentialed Jev provider. Headless/workers only consume prior consent. Disable cancels in-flight work and persists disabled.
- Pi's effective catalog is the authoritative skill universe. The router does not scan the filesystem or add skills; it preserves source/base-directory data and honors named preloads only as represented in that catalog. Empty catalogs and Extension exclusion opt out. Upstream resource extension/discovery can repopulate an effective catalog despite unobservable original `noSkills` or `skills: false` flags, so no stronger enforcement is promised. Existing `agents/executor.md` and `agents/review-synthesizer.md` opt-outs remain unchanged.
- Skills are automatically eligible unless native `disableModelInvocation` is set or their exact name is one of `execute`, `diagnose`, `grill-me`, `review-orchestration`, `review-fix`, or `simplify`. Other prose is interpreted probabilistically by JEV; unknown imported skills are not quarantined. Explicit/slash input receives native handling, and an audited-name mention conservatively falls back. Injected instructions never authorize gated workflows.
- Only a successful, certain route with no pre-existing `forceSystemPrompt` replaces the native prompt catalog with selected local bodies. The router does not claim to strip catalog text already embedded in opaque inherited prompts. Failure, uncertainty, unsupported input, cancellation, and deadline preserve native discovery. Recovery uses a metadata-only catalog through existing `read`; no model tool is added.
- Paid input is bounded raw current input captured before expansion plus recent plain assistant text and previously captured source-vetted plain user text. Tool results, files, images, attachments, and skill bodies are not automatically sent. Source filtering is not secret-proof, and resumed or expanded user text can be omitted when raw provenance is unavailable. Uncaptured, Extension-origin, image-bearing, explicit, oversized, uncertain, or deadline-exceeded requests use native fallback.
- The router permits 100 fresh classifications per `session_start` scope, reset on Extension reload/session start—not a daily or hierarchical dollar cap—with a two-second overall deadline including preparation and no retry. It accepts at most 256 skills, batches 16 with four concurrent batches, and selects at most eight. The `0.9` selection and `0.1` rejection thresholds are experimental and uncalibrated; detailed byte limits are in the Extension README.
- Queued steering/follow-up intent uses native-catalog fallback rather than JEV. Identity-anchored provider-only projections preserve prior prefixes across continuations, settling, and fresh requests without canonical-history mutation. Selected bodies are source-aware deduplicated and recovered from a frozen snapshot after compaction. Session branch/reload boundaries reset ephemeral state; byte-identical resume caches and cross-process projection persistence are not promised. Raw memory is bounded and inactive context handling is passive.
- The only public-hook compatibility wrapper outside the router is the previously existing prompt-commands input pipeline wrapper. Router tests use offline unit/mocked transport and real public-SDK faux-provider scenarios, including controlled manual compaction, representative headless config, forced-prompt order, transformed/repeated queues, and canonical-history assertions.

Live JEV batching compatibility, threshold calibration, latency, actual automatic/overflow compactors, real upstream worker-process E2E, task success/required-skill coverage, and combined JEV/main/worker dollars or provider-cache effects remain unverified. No live router experiment, login, activation, or actual credential was used; Sift's prior live verification is not router validation. Rollout requires user-approved representative live comparisons, not a small-prompt claim.

## PR workflow: implemented product direction

The canonical `skills/pr/SKILL.md` workflow uses the plain `prompts/pr.md` template, not the prompt-commands transformer. Live push/PR end-to-end behavior remains unverified.

- **PR body** — Summary (smallest useful diff visual, view choice delegated to `showing-me`), Evidence (real Before/After; missing evidence marked not captured, never invented), and Merge Danger (one-way or two-way door, blast radius). Uses `CONTEXT.md` domain language. _Avoid_: PR description essay, test-plan TODO list.
- Loads for `/pr` and natural write/open-PR requests. Base is `--base` or origin's default branch. Review uses the fetched base diff and full branch history; GitHub CLI operations target origin's repository.
- Preflight stops on the base branch, with uncommitted or untracked changes, or with no commits ahead of base; the command never commits, stashes, or branches.
- Evidence comes from targeted tests and the repo check run on HEAD. Failing checks are reported and flagged, not blocking; the user decides.
- Titles use conventional-commit types. Exactly one confirmation precedes the outward-facing `git push -u` plus `gh pr create` (ready for review) or, for an existing open PR, `gh pr edit`; that confirmation also covers a prominently displayed retarget when the existing PR's base differs. The draft title and body print in chat first; the confirmation prompt stays short and does not repeat them.
- `rules/common/git-workflow.md` PR guidance defers to the `pr` skill as the single PR-body source.
- Adapted from [Matt Pocock's MIT-licensed in-progress `pr` skill at commit `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`](https://github.com/mattpocock/skills/tree/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/in-progress/pr); its HumanLayer `show-me` credit is carried by `showing-me`.

## Model profiles: implemented product direction

Approved by `/grill-me` on 2026-09-30; implemented and registered as an active Extension `extensions/model-profiles` with command `/profile`, with focused tests. Live `/profile` use and E2E subagent spawning remain unverified. See `extensions/model-profiles/README.md` for the implemented contract.

- Scope: main-session model/thinking and agent model/thinking only. `/review` is untouched; its workflow passes explicit `agent({model, effort})`, which pi-subagents 0.19.0 resolves before frontmatter (source-read inference, not E2E-verified).
- Config: machine-local `~/.pi/agent/model-profiles.json` with a schema. Shape `{$schema?, active?, defaultMain?: {model?, thinking?}, profiles: {<name>: {main?: {model?, thinking?}, agents?: {"*"?: {...}, <agent>?: {...}}}}}`; absent `active` means `default`. Per field, named agent > `*` > repo frontmatter. Repo `agents/*.md` stay the canonical baseline.
- Commands: `/profile` selector showing the active profile; `/profile <name>` switches; `/profile save <name>` snapshots current main model/thinking, keeping the existing agents map. Agent maps are hand-edited.
- Switching validates main and every override (registry, auth, scope) first; any failure lists all failures and applies nothing. Main applies to the current session and persists defaults to settings.
- One global active profile. Agent changes affect every session's next spawn; other running sessions keep their current main until they switch. Writes are atomic.
- Rationale for Generated agent overrides: pi-subagents frontmatter is authoritative over `Agent` params, `subagents.json` has no per-agent model setting, and workflow `agent()` calls are unreachable by `tool_call` hooks. Stripping repo pins would send model-less workflow spawns to the parent model. An upstream override setting was deferred as dependent on upstream.
- Per-file ownership in `~/.pi/agent/agents/`: overridden agents become generated files with a marker comment; unoverridden agents stay setup-style per-file repo symlinks; user-authored files are never touched. Default profile restores symlinks; generated files for deleted repo agents are removed. `setup.sh` is unchanged. Never write into the repo: a directory-level symlink to repo `agents/` is automatically converted to a real directory of per-file symlinks on the first render that needs it.
- Render on `session_start`, on switch, and in a pre-spawn `tool_call` hook for `Agent`/`SubagentWorkflow` with a cheap freshness check.

## Codemode: implemented recipes; measured pilot

Approved by `/grill-me` on 2026-10-02. Optional recipes exist for `/diagnose`, `/init-deep`, `/context-review`, and `/execute` verification, with `/review-fix` linking to the verification recipe. RTK regression tests and headless probes verify the runtime changes below. A small benchmark measured main-session token usage; it does not establish general savings or equivalent review quality.

- **Codemode recipe** — an optional, command-scoped script pattern that runs mechanical tool calls in one `codemode` call and returns compact results to the main context. _Avoid_: codemode subagent.
- Codemode is an orchestration layer, not an agent runtime: scripts cannot run chat models or nest `codemode`. Subagents remain on `@tintinweb/pi-subagents`.
- Goal: main-context savings per command run. Recipes live in the command's prompt or skill, phrased "when `codemode` is available"; no global codemode rule.
- Nested calls use the same argument validation and `tool_call`/`tool_result` hooks as direct calls, with `parentToolCallId` set (verified on Pi 1.0.0 by source read and a headless probe).
- RTK accepts `rtk rewrite` exits 0 and 3 as rewrite; exits 1 and 2 pass through unchanged. RTK skips output compaction and savings recording for nested tool calls (`parentToolCallId`), completing pending metrics while retaining command rewriting. This preserves data for scripts to process; direct tool results retain their existing compaction.
- `/context-review` checks conservative plain backticked path references and returns a compact doc inventory and missing references. Semantic review still requires reading relevant docs; the inventory does not replace that review.
- Verification recipe output: command and exit code on pass; on failure add the last ~40 lines and a `mktemp` log path holding the full output.
- Promote a recipe to a repo-owned tool only when real runs show an identical script; otherwise keep it as a recipe.
- Measurement: 12 completed `pi --mode json --no-session` runs on `openai-codex/gpt-6.1-sol` with high thinking, three runs per arm per case; baseline used `-xt codemode`. Mean main-session final-context tokens were 130,109 → 125,012 for context-review (−3.9%) and 43,432 → 44,091 for verification (+1.5%). Mean cumulative input across model turns was 3,602,974 → 2,967,769 (−17.6%) and 210,178 → 143,453 (−31.7%), respectively. Verification command-result text fell from 3,264 to 118 characters; all six verification runs passed 1,371 tests and `bun run check`.
- Benchmark limits: final context is the last provider-reported input plus cache-read/write tokens; cumulative input sums those counts across turns, not unique tokens or billed cost. Removing codemode changes the tool-description surface, so this measures codemode enabled versus disabled, not recipe-only effects. Context-review used a direct skill prompt because the slash-command entrypoint produced no assistant turns headlessly. Review paths and delegation varied; worker costs and equal finding quality were not measured. Two recipe-arm reviews recovered from script errors (a missing README and exceeding the per-value `store()` limit). With three runs per arm, these results remain indicative.
- Earlier Claude quota-interrupted context-review runs are excluded. The benchmark stayed read-only: the repository diff hash remained unchanged across all 12 current-model runs.
- Deferred: `/pr`, a global codemode rule, `codemode.mode: "only"`, and `pi -p` fan-out from scripts.

## Open questions

- Extension isolation: RTK imports tool-display configuration and rendering helpers despite the sibling-import prohibition in `extensions/AGENTS.md`. Was a narrow exception approved, with what scope and rationale, or should the dependency be removed? Owner: user; resolve before changing this boundary.
- Model profiles (deferred): stale Generated agent overrides after disabling the Extension (documented; run Default profile first to clean up); status rendering when manual `/model` drifts from the active profile.
- Live installation and end-to-end Wayfinder UX remain unverified. Integrated tests, loader checks, and static scenarios verify repository behavior and resources, but static scenarios do not prove model adherence.
- PR workflow (deferred): feasibility of cheap base-branch Before evidence, screenshots, and fork→upstream PR support.
- Oversight output: it is not verified whether reviewer subagents receive the core prompt; agent files therefore reference `plain-report` directly. Deferred: the video Explainer rung (Manim, ffmpeg, TTS), an HTML review-report view, and a readability eval.

## Context map

See `CONTEXT-MAP.md`.
