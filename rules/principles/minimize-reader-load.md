# Minimize Reader Load

Apply when: shaping, reviewing, or refactoring code that is hard to trace, or judging whether a refactor was worth keeping.

Maintainability is the work a reader does to understand code. Measure two separate things: **layers to trace** (indirections between a question and its answer) and **state to hold** (hidden or mutable context the reader must remember). Line count and complexity scores are proxies. A flat file with many globals can cost as much as a deep adapter stack. This is [Guard the Context Window](guard-the-context-window.md) for human readers.

- Collapse layers that cost more than they save: wrappers with one caller, adapters with one implementation, indirection nothing needed.
- Each layer must change the abstraction. A layer that repeats the same methods and arguments only adds load.
- Prefer boundaries that hide real decisions. A broad interface over little logic makes the reader learn both.
- Shrink state scope: returns over mutation, locals over fields, fields over module state, module state over globals. Derive values instead of syncing them.
- State an invariant once at the boundary, not in every consumer.
- Before you add a layer or a piece of state, check that it removes at least as much load somewhere else.

**The test:** can a new reader answer "where does X come from?" and "what can change X?" in under 30 seconds? If not, cut layers or state.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-minimize-reader-load`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
