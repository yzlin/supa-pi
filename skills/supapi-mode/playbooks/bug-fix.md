# Bug fix

You own the fix and its proof. Every shipped line traces to runtime evidence. A change that "might help" is a hypothesis, not a fix.

1. Reproduce the defect yourself on the surface where it was reported. Use existing tests, commands, or the `web-browser` skill for web UI. Record the exact command and failing output. If it will not reproduce, tighten conditions or instrument until it does, or report what is missing.
2. Find the root cause. List candidate causes, then rule them out with runtime evidence until one survives. Seed the candidates by learning how the affected code works, sized as in the `investigation` Playbook step 2; for a regression, ask why it is shaped that way with the `why` skill. When the cause is unclear or disputed, switch to the `diagnose` Playbook.
   If the user asked only why it fails, and did not ask for a fix, stop here: report the root cause with its runtime evidence, and make no edits.
3. Write a failing regression test at an honest seam first when one exists, per the `tdd-workflow` skill. Skip it when the seam is expensive, integration-heavy, or unclear, and say why.
4. Apply the smallest fix at the first place the system went wrong. A guard is a fix only when the state it handles is legitimate.
5. Verify on the same surface: the original repro now passes, the regression test passes, and targeted checks pass. "Inconclusive" or a different surface is not a pass.
6. Run `bun run check` or the repository's check command.
7. Run the review gate from the `supapi-mode` Shared rules.
8. If the user asked for a PR, run the `opening-a-pr` Playbook.

**Principles:** `fix-root-causes`, `attack-the-premise`, `prove-it-works`, `test-behavior-not-implementation`, `encode-lessons-in-structure`.

**Reply:** what was broken, the root cause, the fix, and failing-then-passing output.
