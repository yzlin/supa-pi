# Model the Domain

Apply when: new behavior would add another branch, boolean, phase check, or repeated shape assumption.

Encode the real domain in a data structure instead of scattering it across conditionals. A structure that matches the domain makes invalid states unrepresentable and deletes branches. It is cheap at write time and gets deferred forever once it reads as a refactor.

Reach for:

- a state machine instead of scattered booleans, phases, or lifecycle checks;
- a typed model instead of loose parameters or repeated shape assumptions;
- a map, registry, lookup table, or discriminated union instead of branching spread across files;
- a reducer or command/event model instead of ad hoc mutation;
- a module organized around one body of domain knowledge, not a load/validate/transform/save sequence. Execution order is not ownership;
- a queue, cache, index, graph, tree, or normalized collection where the access pattern calls for it.

When none fits, work out what the code must never allow and how data is read, then pick the structure that encodes exactly that. Do not force it: keep boring code when the current shape is clear, local, and unlikely to grow. Distrust indirection that removes no branches, duplicated rules, invalid states, or lifecycle risk.

**Sign you skipped this:** a feature grows an if/else chain by one branch, or adds a second boolean that must stay in sync with the first. For vocabulary work, use the `domain-modeling` skill.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-model-the-domain`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
