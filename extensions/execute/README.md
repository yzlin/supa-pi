---
title: execute extension behavior
read_when:
  - changing /execute command behavior
  - documenting Execution Brief or execute orchestration behavior
status: active
---

# `/execute` extension

`/execute` starts main-session task orchestration from an explicit plan or from an assistant-authored Execution Brief. The orchestrator should produce a concise plan, resolve ambiguity and danger, then run.

## Command behavior

- `/execute <plan>` executes immediately. The extension sends a concise execute-skill invocation packet and wraps the trimmed args in `<plan>...</plan>`.
- Bare `/execute` reuses the most recent valid assistant message titled `# Execution Brief`, unless a newer user message appears after it.
- If no usable brief exists, or the last brief is stale, bare `/execute` sends a concise mode line asking the assistant to synthesize a new Execution Brief from current session context and then continue through normal execute orchestration in the same run if safe and unambiguous. No second `/execute` is required.
- Explicit plan args and valid, fresh assistant-authored briefs execute immediately through orchestration.
- When the agent is busy, `/execute` queues the same message as a follow-up and notifies the user.

## Execution Brief contract

A usable brief must be assistant-only and include these exact markdown headings:

```markdown
# Execution Brief
## Execution Scope
## Plan
## Done Criteria
## Verification
## Out of Scope
```

User-authored briefs are not accepted as reusable briefs. Any user message after the last assistant brief makes that brief stale, so bare `/execute` synthesizes a fresh brief instead.

## Orchestration behavior

Canonical orchestration workflow: `../../skills/execute/SKILL.md`. It instructs the main-session orchestrator to:

- present a concise plan before dispatching executor tasks;
- ask concise ambiguity questions before execution when the answer could change scope, safety, task breakdown, or done criteria;
- stop in non-interactive contexts and report the exact answers required to proceed instead of guessing;
- run a conservative whole-plan danger preflight before creating or dispatching any task;
- derive one fixed-template `canonicalPlan` from the normalized executable plan and pass that exact trimmed non-empty string to every `execute_checkpoint` load/save;
- checkpoint progress under `.pi/execute/` with `execute_checkpoint` and stop/checkpoint/report on task failure;
- auto-resume an unfinished checkpoint for the same `canonicalPlan` hash;
- leave different-plan unfinished checkpoints untouched and unannounced so they never gate or redirect the current invocation;
- load and resume checkpoints only by the current `canonicalPlan`, without listing different-plan checkpoints during normal orchestration;
- persist dangerous-action approval only when bound to the same `canonicalPlanHash`; never reuse approval for a different canonical plan.

## Structured executor output

The extension registers `execute_tasks` for runnable task dispatch. The main session still creates and updates pi-tasks and owns checkpoints, but it uses `execute_tasks` instead of `TaskExecute` during `/execute`.

`execute_tasks`:

- launches fresh `executor` agents through the pi-subagents workflow runtime;
- injects a closed native `structured_output` schema for `status`, `summary`, `filesTouched`, `validation`, `followUps`, and `blockers`;
- rejects assistant-text JSON as an executor result;
- dispatches at most four tasks per round, bounds prompts/results, and enforces a hard per-agent deadline;
- disables inherited extension tools and parent-bridge tools for executor and repair agents; only declared built-ins plus injected `structured_output` remain;
- performs exactly one report-only typed repair with the tool-less `executor-output-repair` agent when an executor finishes without native structured output;
- never repeats the mutating task during repair;
- accepts an optional closed-schema `tdd: boolean` on each task; omitted or `false` preserves non-TDD execution behavior; `tdd: true` fails before dispatch on platforms without nonzero `O_NOFOLLOW`, because safe contained-file mutation proof cannot be preserved there;
- assembles the complete model-visible executor prompt in one shared module, including the exported closed result schema JSON and sole-terminal-`structured_output` instruction; production and prompt evaluation use that same composer and schema source byte-for-byte;
- for `tdd: true`, loads only the trusted bundled `skills/tdd-workflow/SKILL.md` from a fixed package-relative path and injects its complete canonical content, including frontmatter, in a clearly delimited executor task envelope; callers cannot supply skill names or paths, caller task text is XML-escaped so it cannot forge reserved envelope delimiters, caller input remains limited to 50,000 characters, and the complete escaped/assembled dispatch prompt has a separate bound that reserves trusted composer overhead;
- requires every `tdd: true` result to include exactly one non-empty `validation` entry beginning with each of `RED:`, `GREEN:`, and `COVERAGE:`; `done` results must bind both RED and GREEN entries to the same conservatively recognized direct Bun, Deno, Jest/Vitest/Mocha/Ava, Pytest, Cargo, Go, .NET, Maven, Gradle wrapper, or Swift runner command, captured exit status, and runner-specific normal output that proves tests actually failed/passed (including mixed-count summaries); npm/pnpm/yarn scripts and `bun run` scripts are not authoritative TDD evidence because their hooks and workspace effects are opaque; shell `test`, token-only probes, no-tests-ran output, setup failures, and predicted prose are rejected; lightweight `bunx`/`npx` wrappers around a named supported runner remain accepted;
- validates a filtered, byte-bounded ordered tool trajectory captured only for `tdd: true`: test-file setup (including conventional `e2e` and `end-to-end` roots) may occur before RED, but all production mutations must occur strictly after RED and before final GREEN; only a successful discrete edit/write/patch proves the production implementation—mutation-capable shell calls constrain ordering but cannot prove a workspace delta; recognized Rust `#[cfg(test)]` edit metadata is conservatively test-affecting, while ordinary Rust production edits are not; source edits retain independently capped old/new delta snippets and persist classification only after those bounds are applied; dedicated test-file identities are extracted across evenly sampled payload segments under a strict aggregate scan budget so long preambles cannot hide a valid title beyond a first-prefix truncation; exact, balanced Vitest `describe`/`it`/`test` forms and standalone Python `>>>` doctest examples with only trailing whitespace/comments may be treated as test-only, but mixed or uncertain forms and every truncated delta are ambiguous test-and-production changes; npm/pnpm/yarn test scripts and `bun run test*` are opaque and mutation-ambiguous, cannot supply authoritative RED/GREEN evidence, and never prove implementation; direct supported runner commands are required, and every direct runner invocation receives bounded contained pre/post proofs of regular-file content, permissions, and identity plus no-follow symlink metadata; files and links that pre-exist the executor task inside runner-specific conventional generated-output directory segments (Pytest `.pytest_cache`/`__pycache__`, Gradle `.gradle`/`build`, .NET `bin`/`obj`, Cargo and Maven `target`, and Swift `.build`) remain protected across every RED/GREEN run, while regular artifacts first generated during that task may be created and updated; this provenance is task-scoped; unchanged symlinks pass without traversal, while created, changed, or deleted links invalidate evidence; harness/VCS/dependency state (`.pi`, `.git`, and `node_modules`) remains excluded; the separately proven `.coverage` target is omitted only for recognized terminal-only Pytest coverage commands, so runner hooks or plugins that create, change, or delete other behavior-relevant files invalidate the evidence; Bun's default `--coverage` text report is non-writing; Pytest `--cov` with a terminal-only `term` or `term-missing` report is permitted as an explicit coverage verification before a final focused rerun or after focused GREEN only when contained pre/post proof covers its fixed `.coverage` artifact target; missing proof, source/test deltas, non-terminal report destinations, lcov/html/json reporters, and output directories remain rejected; any test mutation after RED or other mutation-capable shell command or snapshot/report/artifact-writing test option after GREEN is rejected, while recognized read-only shell inspection and provably non-writing filters/reporters remain allowed; shell executable classification accepts plain command names plus the exact repository Gradle wrapper `./gradlew`, and fails closed on other slash-qualified or per-command environment-qualified invocations; this syntactic gate cannot attest what a plain name resolves to through the process `PATH`, so executors should prefer repository read tools for inspection; all shell Git commands are mutation-capable because repository/configured helpers can execute even for read-looking subcommands; retained bash results are byte-bounded with head-and-tail capture, and a truncated direct-runner result is accepted only when authoritative RED/GREEN proof survives in those retained segments; oversized unrelated read-only output is non-fatal, while retained args and tool metadata remain bounded and aggregate-accounted; active shell operators, substitutions, expansions, and redirections remain mutation-capable; duplicate starts, unmatched ends, pending starts at terminal status, aggregate overflow, or capture-correlation failures fail that task with bounded accounting; `structured_output` must be the sole terminal tool call without same-batch siblings or later activity; ordinary assertion REDs and missing-member/compile/import RED exceptions must correlate by normalized whole intent terms with bounded pre-RED test mutation metadata or safely bounded trusted task intent; a focused command path alone is only a fallback when trusted task intent is unavailable and cannot authorize an unrelated failure in the same file; broad and task-bound focused suites require an exact retained test title or missing symbol, or at least two discriminating terms after stopword filtering, so unrelated failures, substring lookalikes, and generic one-term intent are rejected; `done` coverage evidence must use a structurally valid measured statement/branch/function/line count, 0–100 percentage, bounded numerator/positive-denominator ratio, or explicitly met 0–100 threshold that exactly correlates with retained output from a successful observed test command; successful named focused test/behavior/failure-path evidence must correlate with successful trajectory or regression intent; a concrete `coverage tooling unavailable because ...` reason is accepted after valid focused GREEN evidence, while vague unavailable notes, impossible or unobserved numeric claims, zero measurements, bare counts, failed commands, unmet thresholds, and arbitrary labels are rejected; `blocked` and `needs_followup` require a non-empty blocker, and no-work results require consistent explicit unavailable/not-run reasons for RED, GREEN, and COVERAGE while partial work requires the same observed evidence and ordering as completed work;
- fails only the task whose TDD evidence is missing, without adding result fields or invoking report repair for that policy failure, while preserving settled siblings;
- returns a settled outcome for every dispatched task, preserving successful sibling results when another executor fails;
- marks report-only repair results `needs_verification`, so the orchestrator must independently verify claims before completing the task;
- returns the validated per-task payload to the main orchestrator, which reconciles all task and checkpoint state before stopping on a failed outcome.

Direct `executor` Agent calls retain JSON assistant text only as a compatibility fallback when no `structured_output` tool is available.

## Checkpoint storage

`execute_checkpoint` owns checkpoint identity and storage:

- callers provide `canonicalPlan`, not checkpoint IDs; old `planId`-only load/save calls hard-error;
- the checkpoint hash is `sha256(canonicalPlan.trim())`, so the same canonical plan resumes the same checkpoint;
- checkpoint files are `.pi/execute/execute-v1-<uuid>.json`; `.pi/execute/index.json` maps `canonicalPlanHash` to UUID as a repairable cache;
- checkpoint files are the source of truth: load is pure and does not create files, while save allocates the UUID when needed;
- v1 checkpoint files store `canonicalPlanHash`, not the canonical plan text;
- legacy checkpoint files are ignored by the v1 schema marker and left on disk;
- duplicate v1 files for the same hash use the newest `updatedAt` and return warning paths;
- `list_unfinished` returns v1 checkpoints only with `path`, `id`, `status`, `normalizedSummary`, `tasks`, and `canonicalPlanHash`.
