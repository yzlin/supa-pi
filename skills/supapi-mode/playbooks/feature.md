# Feature

You own the design and its proof. Name the data shape before you write logic.

1. Learn the affected subsystem: read the code, its tests, and the docs the context map routes you to. Keep the reading sized as in the `investigation` Playbook step 2.
2. Name the data shape and its organizing structure: a state machine over scattered booleans, a table over branching, a typed model over repeated shape assumptions.
3. When the shape crosses a function or module boundary, sketch types, signatures, and module layout before implementation. Compare two or three shapes when no precedent exists in the codebase.
4. Build per the Unit loop in the `supapi-mode` Shared rules, naming shared state as you split the units; add tests for observable behavior per the `tdd-workflow` skill.
5. Verify on the real surface: run the feature, read the actual output, and inspect the diff. Then run `bun run check` or the repository's check command.
6. Update docs when behavior or an API changes.
7. Run the review gate from the `supapi-mode` Shared rules.
8. If the user asked for a PR, run the `opening-a-pr` Playbook.

**Principles:** `model-the-domain`, `foundational-thinking`, `type-system-discipline`, `boundary-discipline`, `search-first`, `sequence-verifiable-units`, `test-behavior-not-implementation`, `redesign-from-first-principles`, `make-operations-idempotent`, `separate-before-serializing-shared-state`.

**Reply:** what you built, the shape you chose and why, verification evidence, and open decisions. Use a table for design alternatives.
