# Redesign From First Principles

Apply when: adding a new requirement to an existing design.

Do not bolt the change onto the current design. Design as if the requirement had been a basic assumption from the start, then deliver that design in small steps.

- Read every affected file and understand the current design first.
- Ask: "If we wrote this from scratch with this requirement, what would we build?"
- Carry the change through every reference: types, tests, docs, examples, and rationale sections.
- Plan the whole redesign, then ship it in verifiable units per [Sequence Verifiable Units](sequence-verifiable-units.md). Keep each step within [Laziness Protocol](laziness-protocol.md).

This keeps options open: a bolted-on change makes the next requirement harder.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-redesign-from-first-principles`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
