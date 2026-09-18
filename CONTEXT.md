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

- `/review` prepares one exact INLINE public `SubagentWorkflow` run after local configuration/trust/preflight, visible in the native Workflows UI. Repository-owned deterministic code validates reviewer coverage and lossless clustering between stages; model instructions do not replace these checks.
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

## Open questions

- Live installation and end-to-end Wayfinder UX remain unverified. Integrated tests, loader checks, and static scenarios verify repository behavior and resources, but static scenarios do not prove model adherence.

## Context map

See `CONTEXT-MAP.md`.
