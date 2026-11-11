# Refactoring

You own the behavior contract. The structure changes; the behavior does not. A refactor that reveals a bug or a missing feature splits that work out to `bug-fix` or `feature`.

1. Learn how the affected code works first, sized as in the `investigation` Playbook step 2. Then pin current behavior before structure moves: existing tests, a characterization test, a snapshot, or an equivalence script. Type check and lint are not a pin.
2. Name the target shape: module layout, types, and call graph as you would build them today. The reshape must delete branches, layers, or invalid states, not add indirection.
3. Subtract first: delete dead code, collapse one-caller wrappers, and drop redundant checks before you add the new shape.
4. For `/simplify` or a scoped cleanup request, load the `simplify` skill and follow it as canonical for edit boundaries, baseline, audit, and report.
5. Move in small behavior-preserving steps that keep the pin green, per the Unit loop in the `supapi-mode` Shared rules. When an internal API changes, migrate every caller and delete the old API in the same change. Check renames against strings, docs, and back-references.
6. Prove behavior is unchanged on the real artifact, then run `bun run check` or the repository's check command.
7. Keep the change only if it lowers reader load somewhere, as `minimize-reader-load` measures it. Otherwise revert it.
8. Run the review gate from the `supapi-mode` Shared rules; skip its `simplify` pass when step 4 already ran it.
9. If the user asked for a PR, run the `opening-a-pr` Playbook.

**Principles:** `subtract-before-you-add`, `laziness-protocol`, `migrate-callers-then-delete-legacy-apis`, `prove-it-works`, `minimize-reader-load`, `redesign-from-first-principles`.

**Reply:** the structure that changed, the pin, the equivalence evidence, the reader-load gain, and what you reverted.
