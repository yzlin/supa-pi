---
summary: "Offline harness audit: completed instruction cleanup and three implemented Astra reassessment priorities; TDD policy remains deferred."
read_when:
  - "Reviewing research-agent artifact ownership or updating search-first delegation instructions."
  - "Removing, trimming, consolidating, or relocating prompts, agents, skills, and injected rules for Astra readiness."
---

# Harness contract audit

Earlier phases: the initial two findings and the later approved systematic subtraction phase are complete. The subtraction phase covered all six audited cleanup rows as seven offline implementation slices. It changed instruction ownership and added contract tests only; it did not change runtime implementation code, schemas, configured models, defaults, or the whole-agent architecture. No live probe was authorized. The source-guided reassessment below led to separately approved implementation of priorities 1–3; priority 4 remains deferred.

## Scope and limits

The user selected an offline audit of agents, prompts, and skills after the Astra-readiness work, then approved this report path. The working set is this repository; `~/.pi/agent` is the live configuration. The initial inspection found live `agents` and `prompts` symlinked to this checkout. Repository workflow skills were exposed in that main session through their checkout paths; absence of equivalent global skill directories did not mean they were unavailable.

Evidence for the initial audit: the files cited below as they stood at audit time, `CONTEXT.md`, `CONTEXT-MAP.md`, `package.json`, installed Pi `0.85.1` help and native `docs/skills.md` / `docs/prompt-templates.md`, and that session's exposed tool/agent catalog. The repository pinned development dependencies to `0.84.0`; installed-version evidence was not pinned-version proof.

Two read-only reviewers inspected agent/prompt and workflow-skill contracts. The main session independently checked reported findings and their consumers. Representative workflows included research delegation, planning, execute recovery, grilling/context persistence, review, and explicit visual explanation. Other application overlays and the complete external-package implementation set were not audited.

No fresh model session, network probe, startup-token measurement, artifact-collision reproduction, or historical regrading ran. These are source-contract findings, not measured Astra weaknesses, quality gains, or prompt-cache savings. Existing comparison evidence and approval limits remain in [Astra readiness](gpt-6-astra-harness-readiness.md).

## Operating relationship

The requested audit workflow separated read-only investigation from implementation, preserved human approval for consequential ambiguity and model rollout, and expected independently checked evidence. The initial audit only recommended changes and did not apply them. Subsequent, separate approvals authorized the offline finding 1 and finding 2 changes recorded below, then all six subtraction rows as seven implementation slices. The Markdown report remains the durable review surface.

## Existing capabilities to keep

- **Native:** file tools, progressive skill discovery/loading, and prompt-template expansion already exist in Pi. Do not rebuild these as new extensions.
- **Active repository additions:** `package.json` registers execute, research, prompt-command, context, and skills extensions. `extensions/context/index.ts:30` exposes context inspection; `extensions/skills/index.ts:1278` exposes skill management. These user controls are not substitutes for native discovery.
- **External/session capabilities:** the current session exposes `Agent`, pi-task tools, and web tools. `docs/context/extension-registration.md` identifies web access as a companion package. Do not treat those capabilities as missing merely because they are not native Pi tools.
- **Workflow boundaries:** `skills/execute/SKILL.md` owns main-session task/checkpoint control, bounded recovery, concrete worker references, and independent verification. The reviewed grilling, context, review, and showing-me skills already separate their responsibilities; no additional confirmed defect was identified in that bounded pass. This is not an exhaustive correctness guarantee.

## Ranked findings

### 1. Replace stale search-first dispatch guidance

**Initial verified evidence (at audit time):** `skills/search-first/SKILL.md:75` prescribed `Task(subagent_type="general-purpose", ...)`. Its surrounding text said to launch the researcher. That session instead exposed `Agent` with the defined `researcher` role; neither a `Task` tool nor a `general-purpose` agent was in the exposed catalog. The same skill told the planner to invoke a researcher at line 110, while `agents/planner.md:3` listed only file-reading tools and `write`.

**Mismatch and scenario (at audit time):** following the example literally requested an unavailable tool/role. Handing the nested-delegation requirement to the tool-restricted planner could not fulfill that instruction through its declared tools. Actual model failure was not reproduced; an agent might have repaired the stale example by inference.

**Suggested disposition:** replace, not expand. Let `skills/search-first/SKILL.md` describe the existing main-session-owned `Agent`/`researcher` route. Have the parent supply research to the planner rather than requiring a new planner capability. Keep `/research`'s separately owned pi-task route in `extensions/research/prompt.md` intact.

**Benefit / overhead:** removes avoidable tool-name translation and impossible delegation guidance; no new runtime, tool, or model route needed.

**Current offline resolution:** under the subsequent approval, `skills/search-first/SKILL.md` now assigns researcher dispatch to the main session through `Agent`/`researcher`, has the main session supply findings to planner and architect, and keeps simple local repository lookup direct. `extensions/skills/search-first-contract.test.ts` covers those contracts with 3 tests and 14 assertions. This source-contract fix does not establish measured model improvement; no model-behavior comparison ran.

### 2. Give research artifacts an explicit owner

**Initial verified evidence (at audit time):** `agents/researcher.md:18` said:

> Write `research.md` in this format:

Its frontmatter permitted `write`. `extensions/research/prompt.md:7` allowed multiple research tracks when explicitly requested, but its dispatch requirements specified no distinct output path.

**Inference and scenario:** two workers sharing a working directory and following the default target can overwrite each other's report; a single worker can also overwrite an existing report. Whether a particular runner uses isolated working directories must be verified before asserting an observed collision. No overwrite was reproduced.

**Suggested disposition:** change the existing researcher role and its caller contract, not the storage architecture. Prefer returning the brief by default; write an artifact only when the caller supplies an explicitly owned path. Parallel callers should assign distinct paths if files are requested. Preserve the brief's evidence and uncertainty sections; a new structured-output framework is not required to solve path ownership.

**Benefit / overhead:** avoids implicit workspace writes and conflicting default targets; adds only a narrow output-ownership rule.

**Current offline resolution:** under the later approval, `agents/researcher.md` now returns the brief in its response by default and writes only to an explicit caller-assigned path. `extensions/research/prompt.md` now passes requested explicit paths, requires distinct paths for multiple requested tracks, and invents no implicit filename. `extensions/research/output-contract.test.ts` covers the default response, one explicit path, distinct parallel paths, and preserved evidence/task contracts with 4 tests and 25 assertions. The existing `research-options` case (`evals/prompt-optimization/corpus.json:789-815`) forbids file edits and omits `write`, so it cannot validate production artifact ownership. No live collision was reproduced, and the offline contract test does not establish model efficacy; a real concurrency test would need an explicitly approved bounded run.

## Findings not promoted

- Planner `write` access alone is not a proven policy violation. The role explicitly limits implementation, and a planning artifact can be legitimate; no mutation incident was established.
- `/research-brief` duplicates some strict-evidence wording, but `skills/research-mode/SKILL.md` also defines persistent multi-turn behavior. Replacing the one-shot template with that mode is a behavior choice, not an automatic deduplication fix. Resolve intended scope before changing it.
- Broad tool/skill exposure is visible, but its startup cost and selection impact were not measured. Do not prescribe pruning, profiles, or caching changes from inventory size alone.

## Review disposition

The initial two findings are resolved by separately approved offline instruction-contract changes and contract tests. Finding 1 now uses the main-session-owned researcher route; finding 2 now defaults to response-only output and permits writes only to explicit caller-assigned paths, with distinct paths for requested parallel artifacts. Runtime, schema, model, and task orchestration remained unchanged. Keep Sol/high defaults and existing approval gates. No live collision, measured model improvement, model efficacy proof, model/default change, or live probe is claimed.

## Completed Astra-readiness subtraction phase

The user requested and later approved systematic treatment of unclear, unnecessary, and overlapping guidance beyond the isolated contract repairs. The bounded local phase is complete within the reviewed-gap stage of [Astra readiness](gpt-6-astra-harness-readiness.md#adoption-stages). It did not reopen historical model scores, change model/default routing, or authorize a broad rewrite or live calibration.

### Inventory and exposure

At initial audit time, the repository inventory contained **17 agent definitions, 24 skill entrypoints, 4 prompt templates, and 22 rule files**. Those counts are preserved as historical inventory, not asserted as the current tree. Three read-only reviewers covered role/template bodies, workflow skill bodies, and domain skill bodies/rule packs; the parent checked promoted findings against exact sources and loaders. Linked domain reference catalogs were not exhaustively reviewed. Selected external React/Argent skill bodies were examined as neighbors, not as an audited complete external working set.

- `AGENTS.global.md` is linked into live global context; `extensions/core-prompt/prompt.md` supplies the main orchestration contract.
- `extensions/rules/index.ts:60-102` injects a rule-path catalog, **not every rule body**. Bodies are selectively read. Do not count all rule text as permanent startup cost.
- Native Pi supplies progressive skill discovery and template expansion. `skills/session-query/SKILL.md:4` is hidden from model discovery, but `extensions/handoff.ts:186` explicitly invokes `/skill:session-query`; it is not dead material.
- Main and detached worker prompts are different contexts. Similar safety wording in both is not proof of duplicate loading. Managed executor schema/strategy injection is separately owned by `extensions/execute/executor-prompt.ts`.
- File counts and text repetition are inventory evidence, not token-cost, latency, quality, or Astra-effect measurements. No new live baseline was run.

### Historical disposition inventory

This table preserves the initial audit disposition. Names resolve under `agents/`, `skills/`, `prompts/`, or `rules/` as indicated. **KEEP** meant no justified removal in that bounded pass, not proof that wording can never improve. The seven completed implementation slices are recorded separately below.

| Surface | Audited disposition | Ownership retained |
| --- | --- | --- |
| Agents: `architect`, `planner` | KEEP | Design decisions/trade-offs versus dependency-ordered implementation planning. |
| Agents: `build-error-resolver`, `executor`, `refactor-cleaner`, `code-simplifier` | KEEP | Build repair, assigned execution, proven dead-code cleanup, and scoped simplification remain distinct. |
| Agents: `code-reviewer`, `security-reviewer`, `database-reviewer`, `performance-reviewer` | KEEP | General review and selected specialist concerns; reviewer selection belongs to orchestration, not added role prose. |
| Agents: `executor-output-repair`, `review-synthesizer`, `review-verifier` | KEEP | Report normalization, lossless clustering, and independent truth verification must not collapse into one authority. |
| Agents: `explorer`, `researcher`, `doc-updater`, `e2e-runner` | KEEP | Distinct work products and tool boundaries. Research output ownership was already repaired. |
| Skills: `context-docs`, `domain-modeling`, `grilling`, `grill-me` | KEEP | Persistence, semantic analysis, interview procedure, and explicit-command write gates. |
| Skills: `diagnose`, `research-mode`, `review-fix`, `review-orchestration` | KEEP | Explicit diagnosis, multi-turn evidence mode, implementation of findings, and review orchestration. |
| Skills: `search-first`, `showing-me`, `simplify`, `tdd-workflow`, `web-browser`, `session-query` | KEEP | Distinct discovery, presentation, scoped cleanup, testing, browser, and historical-context jobs. |
| Skill: `execute` | TRIM repeated lifecycle prose | Main-session ownership and outcome handling remain canonical; preserve all unique safety and recovery cases. |
| Skills: `architecture-diagrams`, `composition-patterns`, `react-best-practices`, `react-native-skills`, `react-view-transitions`, `regex-vs-llm-structured-text` | KEEP | Narrow domain references; similar names do not justify merging them or removing global availability. |
| Skill: `performance-optimization` | MERGE duplicated procedure ownership, not whole packages | Keep detailed measurement workflow here; the common rule retains triggers and policy. |
| Skill: `security-review` | MERGE duplicated policy; RELOCATE selected recipes | Keep detailed security judgment; common policy needs one explicit owner with a resolvable dependency. |
| Skill: `e2e-testing` | RELOCATE long setup/CI examples; CLARIFY readiness examples | Keep a concise Playwright workflow; preserve discoverable implementation references. |
| Prompts: `grill-me`, `show-me`, `wait-what` | KEEP | Explicit user controls and functional fallback behavior. |
| Prompt: `research-brief` | KEEP pending one-shot versus persistent-mode decision | Evidence-language overlap alone does not justify entering persistent research mode. |
| Rules: `common/performance` | REMOVE/RELOCATE unrelated sections; MERGE repeated method | Application performance policy, not model routing or build-agent dispatch. |
| Rules: `common/security` | MERGE policy ownership with security skill | Preserve the union of applicable safeguards; do not discard skill-only conditions. |
| Rules: remaining `common` files; `typescript`, `python`, `swift`, `sql`, `misc` packs | KEEP structure | Work/language-specific guidance remains selectively loaded. No wholesale pruning justified. |
| `AGENTS.global.md`; core prompt; rules-routing prompt | TRIM exact repetition first within its owner | Global preferences, main orchestration, and rule selection stay distinct. Do not remove worker safeguards by assuming global inheritance. |

The initial plan proposed no entire agent or skill package for removal. **REMOVE** applied to proven misplaced or repeated sections, not a deletion quota.

### Completed implementation slices

All six audited cleanup rows were approved and completed as seven independently reviewable slices. Expected behavioral benefits remain hypotheses until separately approved model calibration; the evidence here is source-contract coverage.

| Audit row / slice | Completed change | Contract suite and checks |
| --- | --- | --- |
| 1 | Removed model selection, context-window, and build-resolver routing from `rules/common/performance.md`; retained application-performance policy and checks. | `extensions/skills/performance-policy-contract.test.ts` — `application performance policy contract`: preserves the application policy, baseline/bounded/blocked-measurement guidance, and excludes unrelated routing sections. |
| 2 | Consolidated five repeated scope/restraint bullets in `AGENTS.global.md` into two while preserving requested broad-refactor allowance and no unrelated or drive-by work. | `extensions/skills/global-scope-contract.test.ts` — `global scope instruction contract`: checks the compact scope owner and unchanged neighboring global sections. |
| 3 | Consolidated `skills/execute/SKILL.md` into one ordered lifecycle and one outcome/recovery table while preserving plan identity, TDD shape, typed outcomes, independent verification, bounded two-round recovery, checkpoint semantics, dependency blocking, and dangerous-plan approval. | `extensions/execute/lifecycle-contract.test.ts` — `execute lifecycle contract`: covers lifecycle/table uniqueness, safeguards, outcome distinctions, recovery/checkpoint identity, and main-session versus worker ownership. |
| 4 | Kept Measure → Identify → Fix → Verify → Guard only in `skills/performance-optimization/SKILL.md`. The common rule now uses an explicit rule-relative link and `MUST read and follow` for actual performance work, with a bounded routine-work opt-out. | `extensions/skills/performance-workflow-contract.test.ts` — `performance workflow ownership contract`: resolves the canonical skill link, checks single method ownership, selective activation, anti-speculation policy, bounded checks, and blocked-measurement reporting. |
| 5 | Made `rules/common/security.md` the shared policy owner after preserving the union of threat-model, approval, cookie/header, LLM-output, and prohibited-action safeguards. The skill explicitly `MUST` read the relative policy and no longer duplicates its policy sections. | `extensions/skills/security-policy-contract.test.ts` — `security policy ownership contract`: checks the safeguard union, resolvable policy dependency, and absence of duplicated policy headings. |
| 6a | Moved the Solana, SSRF, and AI/LLM recipes into selectively routed references under `skills/security-review/references/`; ordinary validation does not load all three. | `extensions/skills/security-references-contract.test.ts` — `security selective reference contract`: checks per-risk routing and resolvability, selective non-use, retained safety guidance, no entrypoint duplication, and byte-for-byte equality of each moved section to its captured pre-change source. |
| 6b | Moved Playwright setup/configuration and CI recipes into distinct references under `skills/e2e-testing/references/`; ordinary flow-test work loads neither automatically. | `extensions/skills/e2e-references-contract.test.ts` — `E2E selective reference contract`: checks selective routing and resolvability, retained workflow guidance, no entrypoint duplication, and byte-for-byte equality of both moved blocks to their captured pre-change source. |

The earlier researcher ownership and search-first dispatch repairs remain in place and covered by `extensions/research/output-contract.test.ts` and `extensions/skills/search-first-contract.test.ts`. No entire agent or skill package was removed. Ordinary role differentiation was not expanded into new routing prose.

### Deferred decisions and rejected audit suggestions

- **React Native profiling:** the generic performance skill and external Argent optimization skill both offer an entry path. The external skill also says measure first while its pipeline performs lint/semantic fixes before baseline profiling. Choose and validate narrow-task versus app-wide ownership before proposing consolidation. External-package changes require separate scope; no automatic move into repo rules.
- **E2E waits:** at audit time, `skills/e2e-testing/SKILL.md:52,58,189` used `networkidle` in positive examples; that guidance still merits a separate correctness check against current Playwright documentation. The then-line 176 `waitForTimeout(5000)` was explicitly a **Bad** example, not a recommendation to remove as a defect.
- **Package-manager examples:** npm examples in a reusable skill are not automatically incompatible merely because this harness uses Bun. Validate against the target project rather than globally replacing npm commands.
- **Session query:** retain the hidden skill because handoff invokes it. Its hidden status is intentional progressive disclosure, not missing functionality.
- **Prompt fallbacks:** matching wrapper/template text can protect `--no-extensions` and load-failure behavior. Keep that compatibility until its actual user-facing contract changes.
- **Global domain skills:** no relocation of React/native packages solely because they are niche. The user's cross-workspace usage and effective overlays matter; the complete external environment remains outside this pass.

### Final validation and remaining gates

Parent validation after all seven slices recorded:

- `bun test extensions/skills extensions/execute extensions/research extensions/lsp evals/prompt-optimization setup.test.ts`: 476 pass, 0 fail, 3,028 assertions across 35 files.
- `bun run check`: exit 0 across 250 files, with one known unrelated warning and 17 informational findings.
- All seven new TypeScript contract files were LSP-clean, and the scoped Biome check was clean after mechanical recovery.
- An independent code reviewer returned `correct` with no findings for the final source-contract diff.
- Managed validation retained 64 hard pre-RED and 67 hard RED-capture truncation failures rather than weakening them. Other coverage-correlation warnings were independently checked. This is current source-contract validation, not historical recertification or model-quality evidence.

Remaining gates are unchanged: preserve historical Astra/Sol evidence; use separately approved matched live calibration before claiming selection quality, latency, token, cost, or behavioral improvement; and require explicit user approval before model adoption, default changes, or route changes. Further subtraction needs a new evidenced scope rather than a size target.

## Source-guided Astra reassessment

The user requested this reassessment against Eric Provencher's [Rethinking skills and prompts for GPT-6 Astra](https://x.com/pvncher/status/2095991462416490862) and OpenAI's [latest-model guide](https://developers.openai.com/api/docs/guides/latest-model). Direct X access returned HTTP 403; the article text was recovered through the [public FxTwitter mirror](https://api.fxtwitter.com/pvncher/status/2095991462416490862). The official guide was fetched directly. These are source recommendations, not measurements of this harness.

Provencher writes:

> Ask GPT-6 Astra to do an audit based on what was discussed in this article, then go build something you wouldn’t have attempted before!

> Requiring a stack of docs or a full repo map before every edit is excessive for a typo fix.

OpenAI recommends:

> Before asking the user clarifying questions, you should complete the work that is already authorized from context and necessary to make the proposed action concrete and reviewable.

> Run tests appropriate to the change and complete required checks. Once those pass, broaden or repeat testing only when new changes, failures, or unresolved concerns justify it; otherwise, continue toward completing the task.

**Scope:** current repository instruction contracts and Ask's correction mechanism, with selected live instruction exposure from this session. Two read-only workers inspected workflow instructions and skill discovery; the parent checked promoted findings. This was not an Astra-run audit, exhaustive external-skill review, fresh startup measurement, or live model comparison. The previously chosen calibration pause remains in effect; it does not block source inspection or offline reproductions. The assessment phase changed only this report; subsequent approved implementation is recorded below.

### Prioritized proposals (assessment-time evidence)

1. **Remove automatic conversational intervention from Ask's heuristic.** `extensions/ask/index.ts:44-45,92-98` matches a question mark anywhere in the response plus broad phrases such as `which`. The `agent_end` handler at `:752-820` can then inject a hidden correction with `triggerTurn: true`. It does not distinguish a question addressed to the user from sample questions the user might ask another agent. An offline invocation of the actual registered handlers, with a mocked Pi interface and no provider, produced one correction for `Which output format do you prefer?`, one for advice containing `Which instructions caused confusion or wasted work?`, and none for equivalent declarative advice. This reproduces a false positive matching the kind of correction just seen in the conversation; it is not evidence of Astra-specific failure. **Suggested owner:** Ask extension. Keep its structured UI and guidance for genuinely needed input; stop treating this heuristic as authority to start another turn. Do not add a model classifier to repair it. **Validation:** genuine clarification remains supported; quoted/sample questions, code examples, and rhetorical questions do not create unsolicited turns. This is the first implementation candidate.

2. **Make documentation discovery conditional.** `AGENTS.global.md` requires `docs_list` before coding and says to follow links until the domain makes sense. It already restricts opened documents to relevant summaries, but the initial discovery step has no small-edit exception. **Inference:** this can impose avoidable work on a typo or already-understood local edit, directly matching the article's warning. **Suggested owner:** global Docs guidance. Keep task-relevant documentation, project-specific read requirements, and documentation updates when behavior changes; do not require a discovery tour for every edit. **Validation:** a local typo correction avoids unrelated discovery, while an unfamiliar authentication change reads the applicable project security context before editing. No latency or token benefit is claimed yet.

3. **Remove the compulsory classification preamble.** `extensions/core-prompt/prompt.md:12` requires `I read this as [complexity]-[domain_guess] — [one line plan].` before acting, including small lookups and conversational follow-ups. The active loader appends this core contract in `extensions/core-prompt/index.ts`. **Suggested owner:** core prompt. Keep short plans or material assumptions when they help the user, rather than forcing a classification sentence on every response. Retain the existing autonomy, direct-work routing, and consequential-ambiguity boundaries at `prompt.md:10,13,17-19`; duplicating those with another long Astra prompt is unnecessary. **Validation:** simple answers lead with their answer; consequential or multi-step work still exposes the plan and required decisions. This is a presentation-policy proposal, not measured quality evidence.

4. **Review the universal direct-work RED stopping rule.** `rules/common/testing.md` correctly requires the narrowest sufficient proof and excludes nonbehavioral work. However, `skills/tdd-workflow/SKILL.md` says to use its method for every behavior change and bug fix, and to stop direct work if no valid RED can be produced. Managed executors already have an explicitly different independent-verification route. **Suggested owner:** common testing policy and its canonical TDD skill. Consider permitting proportionate direct verification when a test would merely mirror a reversible, low-impact implementation; retain regression tests for meaningful bugs, required repository checks, risk-appropriate failure-path coverage, and honest unavailable-verification reporting. This changes an intentional testing policy and requires separate approval. Do not weaken managed evidence validation, fabricate RED/GREEN evidence, or regrade historical artifacts. **Validation:** a low-impact change completes with sufficient direct evidence; a consequential authorization change still requires meaningful positive and negative tests. Offline policy checks alone cannot prove model behavior improves.

### Keep and reject

- Keep the existing security/E2E selective references. They already implement the article's progressive-disclosure direction; do not repeat the completed extraction or remove skills solely by count (`skills/security-review/SKILL.md`, `skills/e2e-testing/SKILL.md`). The complete imported React/Expo/Argent skill environment remains outside this bounded assessment. Codex-specific description shortening described in the article was not established for Pi.
- Do not promote the reviewers' generic suggestions to weaken `/execute` checkpoints or Diagnose's causal-proof procedure. `/execute` deliberately selects managed orchestration; `skills/diagnose/SKILL.md` explicitly activates only for `/diagnose` or a named-skill request. Their method cost alone is not a defect in ordinary direct work.
- Keep explicit user boundaries, type safety, truthful verification, and approval for consequential changes. Interpret already-authorized reversible work from conversation context rather than adding routine permission checkpoints. The Ask false positive is a runtime mechanism problem, not a reason to add another global warning.
- Do not treat the guide's Responses API async tools, steering, and cache controls as capabilities proven on this repository's Codex route. Those require a separate runtime compatibility assessment, not prompt cleanup. The guide recommends preserving current effective reasoning effort during migration; this gives a starting point for effort, not evidence that Sol is the better model.

### Approved follow-through: priorities 1–3

The user authorized continuing with the recommended first three priorities. Implementation removes Ask's automatic correction helper, warning notifications, and follow-up turns; the heuristic now only records uncertain diagnostic candidates. Structured Ask behavior is unchanged. Historical `questionnaire-*` records and redirect fields remain readable by `/ask-stats` until those persisted records are explicitly migrated or retired. See [Ask diagnostics](ask.md#plain-text-clarification-diagnostics).

`AGENTS.global.md` now limits documentation discovery to unfamiliar project/domain context or scoped instruction requirements. Obvious typos, mechanical edits, and already-understood local changes may skip discovery unless scoped instructions require it. Relevant documentation updates and project-specific read requirements remain intact. `extensions/core-prompt/prompt.md` no longer mandates the classification preamble; existing autonomy, scope, verification, and non-trivial planning guidance remain.

Validation: the Ask worker first observed four expected runtime regression failures, then 67 passing Ask tests. Parent verification of `bun test extensions/ask extensions/skills/global-scope-contract.test.ts` passed 69 tests with 294 assertions, including genuine and sample/quoted/code/rhetorical questions, input-source handling, historical stats, and unchanged Ask UI behavior. The existing global instruction contract failed before the documentation-policy edit and passed afterward. An offline invocation of the actual core prompt loader verified the emitted prompt drops the compulsory preamble while retaining original context, autonomy, scope, and verification. LSP diagnostics were clean for both changed Ask TypeScript files and the updated global instruction test. Scoped formatting changed no files. `bun run check` passed with the existing one warning and 17 informational findings; independent scoped review found no issues. An optional repository-wide `tsc --noEmit` run exited 2 with 178 diagnostics outside the three changed TypeScript files; no repository-wide typecheck success is claimed, and those other files were not repaired. These checks establish runtime and source contracts, not improved Astra behavior.

**Remaining scope:** priority 4's TDD policy change is not authorized or implemented. No model/default change, live reload, stopping-control subsystem, historical regrading, or paid comparison accompanies these changes. Existing links into the live configuration can pick up source changes on future loads; no current session was deliberately reloaded. Calibration remains paused. Further model-behavior claims require separately approved real-task evidence.
