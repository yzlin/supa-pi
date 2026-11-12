# Triage

You own the choice of Playbook and of how much process the job gets. Pick the kind, learn enough to size it, state the tier, then dispatch.

1. Restate the user's goal in one sentence.
2. Explicit commands skip triage: `/execute`, `/pr`, `/diagnose`, `/correct`, and `/review-fix` open their Playbook directly.
3. Pick the first kind below whose trigger fits. A non-build kind opens its Playbook now, with no tier, except `execute`, which is always Spec-backed: call the `tier` tool with tier 2 and reason `execute` first. The build kinds are `bug-fix`, `feature`, and `refactoring`.

   | Playbook | Trigger |
   | --- | --- |
   | `investigation` | Read-only question with no failing behavior: how X works, why Y is shaped this way, should we do X or Y. A question about why something fails is not an investigation. |
   | `diagnose` | Explicit only: `/diagnose`, or a request that names the Diagnose skill. Other failures route to `bug-fix`. |
   | `bug-fix` | A reported defect to reproduce, root-cause, fix, and verify. |
   | `feature` | New or changed behavior. |
   | `refactoring` | Behavior-preserving change to structure: rename, extract, inline, dedupe, move, simplify. |
   | `prototype` | A throwaway sketch to settle a design or empirical fork by observation. |
   | `execute` | `/execute`, or running a Spec or an accepted multi-step plan to verified Done Criteria. |
   | `correct` | `/correct`, or making a repeated agent mistake impossible with a structural check. |
   | `fix-review-findings` | `/review-fix`, or fixing findings from a review report. A request for a review alone loads the `review-orchestration` skill instead. |
   | `opening-a-pr` | `/pr`, or writing, opening, or submitting a pull request. Other Playbooks end here when the user asks for a PR. |

4. Learn before you size a build kind. When the request names a typo or one local line, read that line and search for its other uses; if nothing else reads it, size it T0 and skip the rest of this step. Otherwise read the touched code, its tests, and the docs the context map routes you to, sized as in the `investigation` Playbook step 2. For a bug-fix, reproduce first, per its step 1. If what you learned contradicts the kind, re-pick it from the table; a non-build kind then opens its Playbook as in step 3. Carry the learning forward: it counts as the chosen Playbook's learning step, including bug-fix step 2's code reading and investigation step 2's search; do not repeat it. Read further only to fill gaps the chosen kind needs.
5. Size the job. A hard trigger sets a minimum tier:
   - **T2 or higher:** a one-way door (a data or schema migration; a change to a public API, file format, or output that code outside this repository reads; deleting data or files the user did not name); the user asks for a Spec, proof, or `/execute`; or the work spans two or more subsystems that `CONTEXT-MAP.md` lists separately.
   - **T3:** the work runs unattended or across sessions, needs several phases that each land on their own, or fits no Playbook.
   - With no hard trigger, soft signals pick T1 or T2: three or more user-visible outcomes, four or more units, an area with no tests or docs, or a fix that already failed once. Name the signals you weighed.
   - **T0** only for a typo, one local line, or a lookup.
6. Before the first edit, call the `tier` tool with the tier and the hard trigger or soft signals that set it. Call it right after sizing, before any tool call that writes, including a Spec; a tier declared after work started does not count. Use the tool, not a text line: some models return prose written between tool calls as a summarized thinking block, which drops the line. The `tier-guard` extension refuses an `edit`, `write`, or `executor` call until the tier is declared, and at T2 refuses them outside `.pi/specs/` until `spec_log` `accept` succeeds.
7. Dispatch:
   - **T0:** work directly.
   - **T1:** follow the kind Playbook. Its build steps follow the Unit loop in the `supapi-mode` Shared rules.
   - **T2:** run the kind Playbook's design steps (feature 1–3, bug-fix 1–2, refactoring 1–2), then follow the `execute` Playbook from step 1 with the plan as `/execute <plan text>`. Carry kind evidence into the Spec: a bug-fix repro becomes a Done Criterion and a `(baseline)` lane; a refactoring pin becomes a Done Criterion.
   - **T3:** load the `figure-it-out` skill.
8. Escalate when a T1 run hits a hard trigger. Stop at the next verifiable state, call the `tier` tool again with tier 2 and the trigger, and continue at T2 from the current workspace. The Spec names the edits made so far in its Execution Scope and Plan, and Done Criteria cover them. No `(baseline)` lane covers behavior those edits already changed, because the base snapshot already holds them. Never lower a tier on your own; a user instruction can.

**Principles:** `attack-the-premise`, `subtract-before-you-add`, `never-block-on-the-human`.

**Reply:** for a build kind, start with a `Tier: T<n> — <reason>` line for each `tier` call you made; then give the chosen Playbook's reply.
