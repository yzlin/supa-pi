# CONTEXT

## Product purpose

`supa-pi` is Ethan's personal-but-reusable Pi agent harness. It curates local Pi extensions, specialized agents, reusable skills, prompt templates, and rule packs to make Pi sessions more capable and consistent.

The repository is optimized for local workflow quality and maintainable agent behavior, not public-package stability.

## Domain model

- **Extension** — a Pi runtime module registered through `package.json -> pi.extensions`. Extensions add commands, tools, UI behavior, or workflow prompts.
- **Command** — a slash-command interface exposed by an Extension.
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

## Product constraints

- Keep extension boundaries isolated. Extensions under `extensions/` should not import from sibling extensions unless explicitly refactored into shared non-extension code.
- Prefer small, durable Markdown context over chat-only decisions.
- Develop anywhere, but treat `~/.pi/agent` as the live Pi config location described by setup docs.
- Pi 0.84 or newer owns regular/fullscreen viewport composition. SupaPi defaults newly created settings to fullscreen, supports both modes, and does not rewrite existing TUI-mode preferences.
- Do not document secrets, credentials, tokens, private keys, or raw sensitive logs.
- Root project license is MIT. Copied or adapted upstream materials must carry source and license notices in durable docs or README entries.
- Domain modeling is skill composition, not a command or production runtime registration; grilling invokes it only when explicit domain signals arise.

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
- Interrupted reviews require a fresh invocation; workflow resume is outside this migration. The unused fork SDK dependency is removed; setup retains the duplicate-runtime guard. Missing/incompatible journals fail closed; at most one report is published. No private upstream API adapter is used.

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

Sift is implemented and registered as an active Extension. Focused mocked integration tests pass, paired isolated Pi scenarios verify tool selection and non-selection, and a user-consented `/sift login` completed one live synthetic Jev judgment without repository content.

- V1 is a repo-owned Extension with one agent tool, `sift_files`, and one human command, `/sift`. The tool accepts one relevance query plus explicit local file paths and returns ordered per-file `P(relevant)` judgments, truncation state, and failures. It does not scan automatically, filter by a caller threshold, explain judgments, or expose Jev's general Choice/Score question types.
- Each file is evaluated independently through the fixed TypeSafe Jev REST integration. V1 does not add a TypeSafe SDK dependency or copy code from the unlicensed `jev-sift` repository. Any auth implementation adapted from MIT-licensed `pi-typesafe` must retain attribution.
- The trust boundary is the current workspace: real paths must remain under `ctx.cwd`, including after symlink resolution. Only the canonical workspace-relative path, bounded text content, and query are sent; only bounded text files are eligible. Known sensitive filenames and obvious private-key or token markers are blocked locally, with an explicit warning that this is not complete secret detection.
- Workspace content may leave the machine only after interactive `/sift enable` consent, persisted globally as a strict owner-only `PI_CODING_AGENT_DIR/sift/config.json` `{ "enabled": boolean }` setting. Missing config defaults to disabled; invalid, unreadable, or unsafely permissioned config fails closed. `/sift disable` and `/sift logout` persist global disablement, headless sessions may consume but not grant persisted consent, and the setting is re-read for each status or tool call. `/sift` also owns hidden login, verification-before-save, logout, and status behavior. `TYPESAFE_API_KEY` takes precedence over the owner-only credential store under `PI_CODING_AGENT_DIR/sift/`. File contents and judgments are neither persisted nor logged.
- V1 permits at most 20 files per call, four concurrent requests, 50 KB per file, no automatic retries, and 100 attempted file judgments per session. Cancellation stops new work; one file's failure does not erase other results.
- Completion requires mocked unit/integration coverage, inspection of the exact agent-facing schema, isolated Pi tests for appropriate use and non-use plus auth UX, one user-consented live Jev smoke request, targeted tests, `bun format`, and `bun run check`.
- Deferred from V1: URLs, inline text, outside-workspace roots, typed questions, configurable providers or limits, and persistent daily cost caps.

## Skill router: implemented, registered, and default off

The Skill router is an independently consented Extension at `extensions/skill-router/`. It is first in `package.json -> pi.extensions` so it can capture bounded raw input before prompt writers and input transformers, but registration does not enable paid routing. Commands, limits, privacy details, and evidence are canonical in `extensions/skill-router/README.md`.

- **Skill router** — selects applicable skills before model execution and supplies their instructions while retaining recovery discovery. _Avoid_: skills manager, Sift.
- **Skill applicability judgment** — one advisory JEV probability that a skill should load for the bounded task context. It does not grant workflow or action authorization. _Avoid_: permission, proof.

Implemented boundaries:

- `extensions/skills/` still owns skill management/resource discovery and `extensions/sift/` owns explicit file judgments. The router has its own JEV adapter, credential store, and strict global consent config. `/skill-router [status|login|logout|enable|disable]` separates interactive hidden login verification from explicit paid conversation-transfer consent; headless/workers only consume prior consent. Login leaves consent unchanged. Disable and logout cancel in-flight work and persist disabled; logout does not remove an environment credential.
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

## Open questions

- Live installation and end-to-end Wayfinder UX remain unverified. Integrated tests, loader checks, and static scenarios verify repository behavior and resources, but static scenarios do not prove model adherence.
- PR workflow (deferred): feasibility of cheap base-branch Before evidence, screenshots, and fork→upstream PR support.

## Context map

See `CONTEXT-MAP.md`.
