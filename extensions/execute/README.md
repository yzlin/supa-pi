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
- checkpoint progress under `.pi/execute/`, apply bounded automatic recovery to safe local failures, and stop/report only for terminal or human-required blockers;
- auto-resume an unfinished checkpoint for the same `canonicalPlan` hash;
- leave different-plan unfinished checkpoints untouched and unannounced so they never gate or redirect the current invocation;
- load and resume checkpoints only by the current `canonicalPlan`, without listing different-plan checkpoints during normal orchestration;
- persist dangerous-action approval only when bound to the same `canonicalPlanHash`; never reuse approval for a different canonical plan.

## Structured executor output

The extension registers `execute_tasks` for runnable task dispatch. The main session still creates and updates pi-tasks and owns checkpoints, but it uses `execute_tasks` instead of `TaskExecute` during `/execute`.

The public closed input has an optional top-level `cwd` plus the `tasks` array. `cwd` may be absolute or session-relative, must resolve to an existing directory, and defaults to the session cwd. An alternate workspace with trust-requiring project resources must already have an affirmative Pi trust-store decision; otherwise dispatch fails before launch. Each task has `taskId`, `subject`, and `prompt`, plus optional `tdd` and `tddShape`. Managed TDD prompts also receive a trusted pre-submit checklist: complete tests and helpers before RED, report and adapt when a meaningful RED is unavailable, use explicit absence sentinels instead of defaulted `undefined` fixtures, never fabricate RED, run exact final GREEN after the last production edit when applicable, avoid mutations after GREEN, and cite only coverage facts retained in observed output. Broader type/lint verification remains main-session work after settlement because evidence acceptance proves trajectory ordering rather than repository code health. The Task-shape declaration is this exact closed object:

```ts
{
  behavior: string; // non-blank, at most 2,000 characters
  redGreenCommand: string; // non-blank supported direct managed-TDD runner command, at most 2,000 characters
  productionComponent: string; // non-blank, at most 2,000 characters
  mutations: Array<{
    kind: "test" | "production";
    path: string; // canonical workspace-relative file path, at most 500 characters
  }>; // 2-6 ordered operations
}
```

The manifest must name exactly one distinct test target and at least one production target, with every test operation before every production operation. Canonical paths identify files relative to the selected `cwd` workspace and reject absolute/drive paths, backslashes, trailing slashes, glob characters, control characters, empty/`.`/`..` segments, and protected `.pi`, `.git`, or `node_modules` roots. The command is the intended direct runner for RED and the first GREEN.

### Adaptive TDD settlement

`tdd: true` injects the canonical TDD skill as the preferred implementation strategy. The evidence validator still evaluates the strict method, but a process deviation is advisory when the settled trajectory retains report integrity, a task-correlated RED or honest RED-unavailable reason, a proven production mutation, and an authentic passing supported runner afterward. Command drift, weak RED identity, strict ordering deviations, and vague nonnumeric coverage then return `needs_verification` with `repaired: false` and one bounded warning. The main orchestrator must inspect the files, rerun current targeted validation, and run applicable diagnostics before completing the task or dispatching dependents.

Malformed reports, incomplete/corrupt trajectories, non-terminal structured output, unsafe runner workspace proof, hypothetical or contradictory claims, uncorrelated RED, missing authentic GREEN, unresolved later test failures, and fabricated numeric coverage remain hard failures. One bounded exception applies: `needs_followup` with no blocker but one or more non-blocking `followUps` settles as `needs_verification` only when the same trajectory passes the complete `done` evidence assessment. Shape validation and unsupported safe-proof platforms remain pre-dispatch hard failures.

### Automatic recovery

The main-session orchestrator handles safe local recovery without a questionnaire. It independently verifies `needs_verification`, creates separate non-TDD cleanup Tasks for scoped formatting, lint, type, fixture, or generated-output work, and reruns the affected behavior test. Recovery is limited to two rounds per Task. A hard-failed `invalidResult` never completes its TDD Slice; a new recovery Task must produce fresh evidence.

User input remains required for destructive or irreversible action, external or production effects, credentials or inaccessible state, ambiguous file ownership, material scope or behavior choices, and blockers that remain after the bounded recovery rounds. Generated output is always separate from a TDD Slice so generation commands cannot invalidate the RED-to-GREEN window.

`execute_tasks`:

- launches fresh `executor` agents through the pi-subagents workflow runtime in the selected canonical `cwd`; workflow execution, child built-in tools, TDD mutation/runner proof, and private debug artifacts share that root;
- injects a closed native `structured_output` schema for `status`, `summary`, `filesTouched`, `validation`, `followUps`, and `blockers`;
- rejects assistant-text JSON as an executor result;
- dispatches at most four tasks per round, bounds prompts/results, and enforces a hard per-agent deadline;
- disables inherited extension tools and parent-bridge tools for executor and repair agents; only declared built-ins plus injected `structured_output` remain;
- performs exactly one report-only typed repair with the tool-less `executor-output-repair` agent when an executor finishes without native structured output;
- never repeats the mutating task during repair;
- accepts optional closed-schema `tdd: boolean` and `tddShape` fields on each task, with an immediate if-and-only-if cutover: `tddShape` is required when `tdd` is exactly `true` and rejected when `tdd` is false or omitted; there is no compatibility path for unshaped TDD tasks; on platforms without nonzero `O_NOFOLLOW`, each otherwise-valid `tdd: true` task returns a synthetic failed outcome without dispatch while non-TDD siblings still run;
- assembles the complete model-visible executor prompt in one shared module, including the exported closed result schema JSON and sole-terminal-`structured_output` instruction; production and prompt evaluation use that same composer and schema source byte-for-byte;
- for `tdd: true`, loads only the trusted bundled `skills/tdd-workflow/SKILL.md` from a fixed package-relative path and injects its complete canonical content, including frontmatter, in a clearly delimited executor task envelope; it also serializes the validated declaration into a separate XML-escaped `<trusted-task-shape>` prompt section that tells the Agent to continue toward GREEN if actual work grows and that the runtime checks for a settled warning; callers cannot supply skill names or paths, caller task text and shape strings are escaped so they cannot forge reserved envelope delimiters, caller input remains limited to 50,000 characters, and the complete escaped/assembled dispatch prompt has a separate bound that reserves trusted composer overhead;
- deterministically rejects only each missing, unknown-field, semantically invalid, or declared-oversized `tddShape` before its Agent starts; valid siblings continue and results remain in input order; semantic checks include the supported direct command, canonical paths, one distinct test target, a production target, test-before-production ordering, and the 2-6-operation bound;
- after a TDD Agent settles with otherwise-valid evidence, compares the proven successful mutation target path sequence against the declaration; if that observed sequence is not a bounded subsequence of the manifest, the completed result receives at most one bounded `warnings` string (1,000 characters) rather than being failed; declared oversize is rejected, while actual growth is warning-only at this stage and can still exhaust the unchanged trajectory, file-proof, aggregate-proof, or result limits before settlement;
- classifies strict TDD evidence deviations separately from integrity failures: authentic but method-imperfect work settles as `needs_verification`, while unsafe, malformed, fabricated, or currently failing evidence remains fail-closed; diagnostics stay bounded and privacy-safe;
- requires every `tdd: true` result to include exactly one non-empty `validation` entry beginning with each of `RED:`, `GREEN:`, and `COVERAGE:`; `done` results must bind both RED and GREEN entries to the same conservatively recognized direct Bun, Deno, Jest/Vitest/Mocha/Ava, Pytest, Cargo, Go, .NET, Maven, Gradle wrapper, or Swift runner command, captured exit status, and runner-specific normal output that proves tests actually failed/passed (including mixed-count summaries); npm/pnpm/yarn scripts and `bun run` scripts are not authoritative TDD evidence because package-manager wrappers, hooks, and workspace effects are opaque; shell `test`, token-only probes, no-tests-ran output, setup failures, and predicted prose are rejected; lightweight `bunx`/`npx` wrappers around a named supported runner remain accepted;
- validates a filtered, byte-bounded ordered tool trajectory captured only for `tdd: true`: test-file setup (including conventional `e2e` and `end-to-end` roots) may occur before RED, but all production mutations must occur strictly after RED and before final GREEN; only a successful discrete edit/write/patch proves the production implementation—mutation-capable shell calls constrain ordering but cannot prove a workspace delta; recognized Rust `#[cfg(test)]` edit metadata is conservatively test-affecting, while ordinary Rust production edits are not; source edits retain independently capped old/new delta snippets and persist classification only after those bounds are applied; dedicated test-file identities, including GoogleTest `TEST(Suite, Name)` names, are extracted across evenly sampled payload segments under a strict aggregate scan budget so long preambles cannot hide a valid title beyond a first-prefix truncation; exact, balanced Vitest `describe`/`it`/`test` forms and standalone Python `>>>` doctest examples with only trailing whitespace/comments may be treated as test-only, but mixed or uncertain forms and every truncated delta are ambiguous test-and-production changes; npm/pnpm/yarn test scripts and `bun run test*` remain opaque, cannot supply authoritative RED/GREEN evidence, and never prove implementation; every authoritative runner invocation receives bounded contained pre/post proofs of regular-file content, permissions, and identity plus no-follow symlink metadata; Gatsby workspaces use bounded, helper-disabled Git tracked-file enumeration to omit only untracked root `.cache` and `public` output while protecting force-added output and ignored files elsewhere; when that enumeration is unavailable, the filesystem scan remains fail-closed at 10,000 entries or 128 MiB; files and links that pre-exist the executor task inside runner-specific conventional generated-output directory segments (Pytest `.pytest_cache`/`__pycache__`, Gradle `.gradle`/`build`, .NET `bin`/`obj`, Cargo and Maven `target`, and Swift `.build`) remain protected across every RED/GREEN run, while regular artifacts first generated during that task may be created and updated; this provenance is task-scoped; unchanged symlinks pass without traversal, while created, changed, or deleted links invalidate evidence; harness/VCS/dependency state (`.pi`, `.git`, and `node_modules`) remains excluded; untracked `.yarn/cache` content is omitted only after bounded helper-disabled Git enumeration, while tracked Yarn cache, release, plugin, and patch inputs remain protected; the separately proven `.coverage` target is omitted only for recognized terminal-only Pytest coverage commands, so runner hooks or plugins that create, change, or delete other behavior-relevant files invalidate the evidence; Bun's default `--coverage` text report is non-writing; Pytest `--cov` with a terminal-only `term` or `term-missing` report is permitted as an explicit coverage verification before a final focused rerun or after focused GREEN only when contained pre/post proof covers its fixed `.coverage` artifact target; missing proof, source/test deltas, non-terminal report destinations, lcov/html/json reporters, and output directories remain rejected; any test mutation after RED or other mutation-capable shell command or snapshot/report/artifact-writing test option after GREEN is rejected, while recognized read-only shell inspection and provably non-writing filters/reporters remain allowed; shell executable classification accepts plain command names plus the exact repository Gradle wrapper `./gradlew`, and fails closed on other slash-qualified or per-command environment-qualified invocations; this syntactic gate cannot attest what a plain name resolves to through the process `PATH`, so executors should prefer repository read tools for inspection; all shell Git commands are mutation-capable because repository/configured helpers can execute even for read-looking subcommands; retained bash results are byte-bounded with head-and-tail capture, and a truncated direct-runner result is accepted only when authoritative RED/GREEN proof survives in those retained segments; oversized unrelated read-only output is non-fatal, while retained args and tool metadata remain bounded and aggregate-accounted; active shell operators, substitutions, expansions, and redirections remain mutation-capable; duplicate starts, unmatched ends, pending starts at terminal status, aggregate overflow, or capture-correlation failures fail that task with bounded accounting; `structured_output` must be the sole terminal tool call without same-batch siblings or later activity; ordinary assertion REDs and missing-member/compile/import RED exceptions must correlate by normalized whole intent terms with bounded pre-RED test mutation metadata or safely bounded trusted task intent; a focused command path alone is only a fallback when trusted task intent is unavailable and cannot authorize an unrelated failure in the same file; broad and task-bound focused suites require an exact retained test title or missing symbol, or at least two discriminating terms after stopword filtering, so unrelated failures, substring lookalikes, and generic one-term intent are rejected; `done` coverage evidence must use a structurally valid measured statement/branch/function/line count, 0–100 percentage, bounded numerator/positive-denominator ratio, or explicitly met 0–100 threshold that exactly correlates with retained output from a successful observed test command; successful named focused test/behavior/failure-path evidence must correlate with successful trajectory or regression intent; a concrete `coverage tooling unavailable because ...` reason is accepted after valid focused GREEN evidence, while vague unavailable notes, impossible or unobserved numeric claims, zero measurements, bare counts, failed commands, unmet thresholds, and arbitrary labels are rejected; `blocked` and `needs_followup` require a non-empty blocker, and no-work results require consistent explicit unavailable/not-run reasons for RED, GREEN, and COVERAGE while partial work requires the same observed evidence and ordering as completed work;
- fails only the task whose TDD evidence is missing and preserves only bounded `filesTouched`, `validation`, and `blockers` under non-authoritative `invalidResult` diagnostics; status, summary, and follow-up actions remain absent from the returned diagnostics; it does not invoke report repair, and it preserves settled siblings;
- persists a private local debug artifact for hard-rejected TDD evidence and returns its workspace-relative `debugArtifactPath`; persistence failure instead returns `debugArtifactError` without replacing the original evidence error;
- returns a settled outcome for every dispatched task, preserving successful sibling results when another executor fails; a completed outcome may include the Task-shape `warnings` field alongside `taskId`, `outcome`, `result`, and `repaired`;
- marks report-only repair results `needs_verification` with `repaired: true`, and authentic TDD strategy deviations `needs_verification` with `repaired: false` plus one bounded warning; both require independent orchestrator verification before completion;
- returns the validated per-task payload to the main orchestrator, which reconciles all task and checkpoint state before stopping on a failed outcome; settled Task-shape warnings persist through the optional per-task checkpoint `warnings` field (at most one 1,000-character entry).

Task shaping does not raise, waive, or replace any existing TDD evidence, trajectory-capture, contained-file proof, prompt, result, or aggregate budget. Therefore an actual slice overrun is only warning-only when the Agent reaches a valid settled result; growth may instead exhaust an existing proof limit and fail TDD evidence validation.

### TDD debug artifacts

Rejected TDD evidence writes a versioned JSON artifact under `.pi/execute/debug/` in the selected `cwd`. It contains the task prompt, complete structured executor result, evidence rejection, specific trajectory capture errors, and the already byte-bounded filtered tool trajectory. Captured command output and edit snippets may contain sensitive project data.

The debug directory is mode `0700`, each artifact is mode `0600`, file creation uses no-follow exclusive open plus descriptor identity validation, and symlinked storage paths fail closed. Each artifact is capped at 1 MiB, and persistence stops at 20 retained artifacts. `.pi/` is repository-ignored. Artifacts remain until manually removed; share only after reviewing and redacting their contents.

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
