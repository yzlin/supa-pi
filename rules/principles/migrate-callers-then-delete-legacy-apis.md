# Migrate Callers Then Delete Legacy APIs

Apply when: introducing a new internal API, path, or contract while old callers or files still exist.

For repo-owned contracts, migrate every caller and delete the old path in the same change. No indefinite compatibility layers.

- Find callers with `grep` and LSP `findReferences`, including strings, docs, tests, and config.
- Update tests to assert the new contract. Delete tests that only protect pre-refactor internals.
- Runtime, external, or persisted-state compatibility needs a stated reason and a removal trigger.

**Applies when:** no external user depends on the old shape, the repo can absorb a coordinated break, and the change is part of a simplification or refactor.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-migrate-callers-then-delete-legacy-apis`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
