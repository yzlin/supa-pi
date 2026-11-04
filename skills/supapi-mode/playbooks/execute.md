# Execute

You own the plan's outcome and every Done Criterion's proof. The deliverable is a Spec whose criteria are each checked with evidence you observed, or an exact list of what is blocked.

`spec_log` is the only writer of `.pi/specs/<slug>.log.jsonl`. Never edit a log or a Snapshot ref by hand.

## 1. Pick the Spec

- `/execute @.pi/specs/<slug>.md` or a named Spec: use it.
- `/execute <plan text>`: follow the `to-spec` skill to write a Spec from that plan and the conversation, then continue here without pausing.
- Bare `/execute`: list `.pi/specs/` with `spec_log` `status` (or `/to-spec status`). Resume the most recently modified Spec that is accepted and not `done` or `stopped`. If none, use the latest Spec this session wrote that is not accepted. If messages followed that draft, ask once whether to run it or draft a new one. Otherwise draft a new Spec with the `to-spec` skill from the conversation.

A `legacy (pre-P4)` log cannot resume. Say so and ask for a new slug.

## 2. Lint, review, accept

1. Call `spec_log` `lint`. Fix every reported problem with the user's intent before going on.
2. Review the Spec before first acceptance when it has eight or more Done Criteria, touches a one-way door, or the user asks. Call two blocking `subagent` calls with agent `spec-reviewer` in one tool block, each with `schema` from `../schemas/spec-review.schema.json`, the Spec path, and a task naming its `Focus:` (one plan feasibility, one Done Criterion testability) plus the other's focus. Show the findings in an assistant message, then ask the reviewers' questions and `accept / revise / stop` in one `ask` call. Record the result with `spec_log` `review` (`decision`, `findings` count). On revise, edit the Spec with the user and lint again. At most two review rounds per Spec; after that offer only accept or stop.
3. Run a danger preflight over the whole plan. Destructive or irreversible actions, broad filesystem operations, secret exposure, production changes, and external side effects need explicit user approval that names them. For a safe local plan, state in one line why no approval is needed.
4. Call `spec_log` `accept`. If the Spec changed after an earlier acceptance, the tool returns the diff: show it, ask, and on approval call `accept` with `revise: true`; otherwise restore the accepted text.

## 3. Plan the work

Split the Plan into units that each prove one or more Done Criteria. Order them by dependency; put the riskiest unknown first. Write the unit list into your working plan with the criteria each one proves.

Run units in the main session by default. Use a child only for independent units with disjoint write scopes that can run in parallel, for work that would flood this context, or for a unit whose directory is outside the workspace.

## 4. Run each unit

- **In main:** edit only the unit's declared paths. Keep shell commands read-only or inside the scope, and check `git status` before verifying.
- **Delegated:** call one blocking `subagent` with agent `executor` and `schema` from `../schemas/executor-report.schema.json`. The task is self-contained: goal, exact write scope, the Done Criteria it proves, references with verified paths, safety gates, and TDD guidance for behavior changes (`skills/tdd-workflow/SKILL.md`). Run at most four children at once, only across disjoint scopes. Read the report from `structuredContent.structuredOutput`; a `done` is a claim.

## 5. Verify and record

For each Done Criterion the unit proves:

1. Run its named evidence yourself after the last edit: the targeted test, the check command, or the file read. A child's validation list is not your evidence.
2. Judge the result against the criterion text and the documented behavior, not against the reasoning that wrote the change.
3. On pass, call `spec_log` `check` with the `id` and evidence written from what you observed: command, exit code or result line, files inspected. Never record intent or a child's claim as evidence.

On a failed check, fix the unit and verify again. Each unit gets at most two repair attempts after its first try, counted across any renaming. After that, call `spec_log` `block` with the criterion `id` and the exact reason, and continue with units that do not depend on it. Read-only re-verification is not a repair. Do not undo correct code to manufacture a failing test.

Stop for human prerequisites, credentials, inaccessible state, ambiguous ownership, material behavior choices, or consequential external effects. Record them with `spec_log` `block` (no `id` for a plan-wide blocker). On a user stop, call `spec_log` `stop` with the reason.

## 6. Resume

A resumed Spec keeps its checked boxes as history, not proof of today. Re-run the evidence for every checked criterion that a remaining unit could affect before you build on it. A criterion marked blocked stays blocked until its prerequisite is resolved; then fix and check it. Start remaining units from the current workspace state; inspect `git status` and run current tests first.

## 7. Finish

`spec_log` writes `done` when every criterion is checked. Then run `bun run check` or the repository's check command once more on the final state.

**Principles:** `prove-it-works`, `sequence-verifiable-units`, `outcome-oriented-execution`, `attack-the-premise`, `never-block-on-the-human`, `guard-the-context-window`.

**Reply:** the Spec status from `spec_log` `status`, what was built, each criterion's evidence, blockers with exact prerequisites, files touched, and follow-ups. Never present a blocked or open criterion as done. Close with a Final report per the `plain-report` skill.

## Not guaranteed

Since P4 no runtime gate enforces scope, repair limits, verification order, or approval. `spec_log` checks only Spec shape, the accepted hash, and that a check names a criterion and has evidence text. Whether that evidence is real is your responsibility.
