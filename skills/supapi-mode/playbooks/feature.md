# Feature

You own the design and its proof. Name the data shape before you write logic.

1. Learn the affected subsystem: read the code, its tests, and the docs the context map routes you to. Keep the reading sized as in the `investigation` Playbook step 2.
2. Name the data shape and its organizing structure: a state machine over scattered booleans, a table over branching, a typed model over repeated shape assumptions.
3. When the shape crosses a function or module boundary, sketch types, signatures, and module layout before implementation. Compare two or three shapes when no precedent exists in the codebase.
4. Plan the decomposition: blocking first steps, independent workstreams with disjoint write scopes, and shared state. Delegate parallel disjoint slices with the `subagent` tool; otherwise implement in the main session.
5. Build in small units that each end in a verifiable state. Add tests for observable behavior per the `tdd-workflow` skill.
6. Verify on the real surface: run the feature, read the actual output, and inspect the diff. Then run `bun run check` or the repository's check command. When the change renames or moves strings, formats, or files other code may read, run the `blast-radius` skill on the change first.
7. Update docs when behavior or an API changes.
8. Run the review gate from the `supapi-mode` Shared rules.
9. If the user asked for a PR, run the `opening-a-pr` Playbook.

**Principles:** `model-the-domain`, `foundational-thinking`, `type-system-discipline`, `boundary-discipline`, `search-first`, `sequence-verifiable-units`, `test-behavior-not-implementation`, `redesign-from-first-principles`, `make-operations-idempotent`.

**Reply:** what you built, the shape you chose and why, verification evidence, and open decisions. Use a table for design alternatives.
