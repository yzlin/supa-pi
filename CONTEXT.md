# CONTEXT

## Product purpose

`supa-pi` is Ethan's personal-but-reusable Pi agent harness. It curates local Pi extensions, specialized agents, reusable skills, prompt templates, and rule packs to make Pi sessions more capable and consistent.

The repository is optimized for local workflow quality and maintainable agent behavior, not public-package stability.

## Domain model

- **Extension** — a Pi runtime module registerable through `package.json -> pi.extensions`. Extensions add commands, tools, UI behavior, or workflow prompts.
- **Command** — a slash-command interface supplied by an Extension or a native prompt template. _Avoid_: Extension-only command.
- **Prompt transformer** — an Extension input hook that expands selected prompt invocations without registering their slash commands. _Avoid_: command registrar.
- **Agent** — a named delegated role definition discovered from trusted parent-workspace `.pi/agents/` or global agent files. Repo `agents/` supplies the bundled definitions.
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
- **Final report** — the reply that closes multi-step work: edits, investigations, delegated work, or review, diagnose, and grill summaries. One-line answers and lookups are not Final reports. _Avoid_: summary turn, any long reply.
- **Plain report** — the output style for Final reports and reviewer `why`/`change` text: roughly 80% of ASD-STE100 Simplified Technical English, using `CONTEXT.md` vocabulary. _Avoid_: STE mode, caveman.
- **Explainer rung** — one output format on the `/show-me` ladder: text, diagram, or HTML. Video is a deferred rung. _Avoid_: view mode.
- **Evidence tier** — the grade a `/why` claim carries: Direct, Supported, Inferred, Speculative, or Unknown. The tier sets the claim's section and wording; code is never evidence of its own intent. _Avoid_: confidence score.
- **Proof ladder** — how far `/blast-radius` got a safety fact: Said, Pointed, Walked, Ran, Reproduced. Only Ran and Reproduced involve running code. _Avoid_: confidence level.
- **Action item** — in a `/ketchup` reply, a call only the user can make: a product choice, an approval, an irreversible or external step, a live run that needs approval, or access the agent lacks. Work the agent can still do is not one. _Avoid_: todo, next step.
- **Hub skill** — the single orchestrator skill `skills/supapi-mode/` that starts non-trivial work with the Triage Playbook, which matches it to one Playbook and, for build kinds and `execute`, a Tier; the hub holds the Shared rules (Unit loop, review gate) and names the Principles. _Avoid_: mode prompt, router extension.
- **Triage** — the entry Playbook `skills/supapi-mode/playbooks/triage.md`: it skips explicit commands, picks the kind, learns before sizing, declares the tier with the `tier` tool before the first edit, dispatches, and escalates a T1 run to T2 on a hard trigger. _Avoid_: router, classifier.
- **Tier** — how much process a build job (bug-fix, feature, refactoring) gets. T0: work directly (typo, one line, lookup). T1: the kind Playbook plus the Unit loop, no Spec. T2: the kind's design steps, then a Spec through `execute`; forced by a one-way door, a request for proof, or two or more subsystems. T3: `figure-it-out`, for unattended, multi-session, or multi-phase work. _Avoid_: size, complexity level.
- **Playbook** — an ordered step file under `skills/supapi-mode/playbooks/` for one task type, loaded by path only when the Hub skill matches it; it sequences Workflow skills and subagents. _Avoid_: workflow skill, command.
- **Principle** — one named engineering rule under `rules/principles/`, cited by name when it changes a decision. _Avoid_: task rule, guideline.

## Product constraints

- Keep extension boundaries isolated. Extensions under `extensions/` should not import from sibling extensions unless explicitly refactored into shared non-extension code.
- Prefer small, durable Markdown context over chat-only decisions.
- Develop anywhere, but treat `~/.pi/agent` as the live Pi config location described by setup docs.
- Pi 0.84 or newer owns regular/fullscreen viewport composition. SupaPi defaults newly created settings to fullscreen, supports both modes, and does not rewrite existing TUI-mode preferences.
- Do not document secrets, credentials, tokens, private keys, or raw sensitive logs.
- Root project license is MIT. Copied or adapted upstream materials must carry source and license notices in durable docs or README entries.
- Domain modeling is skill composition, not a command or production runtime registration; grilling invokes it only when explicit domain signals arise.
- Linting and formatting use oxlint (type-aware) and oxfmt extending Ultracite presets, tuned to prior Biome intent (Biome-equivalent strictness, Biome-style output, grouped imports) over all repo TypeScript and JSON; strict `tsc` type-checks all repo TypeScript, tests included; `bun run check` (lint, format check, `tsc`) is the gate. Vendored upstream skill examples stay verbatim.

## Open questions

- Extension isolation (resolved 2026-10-04): no approved exception; RTK's tool-display dependency is removed under "Tool rendering: implemented product direction" in `docs/context/subsystems.md`.
- PR workflow (deferred): feasibility of cheap base-branch Before evidence, screenshots, and fork→upstream PR support.
- Oversight output: it is not verified whether reviewer subagents receive the core prompt; agent files therefore reference `plain-report` directly. Deferred: the video Explainer rung (Manim, ffmpeg, TTS), an HTML review-report view, and a readability eval.

## Context map

See `CONTEXT-MAP.md`.
