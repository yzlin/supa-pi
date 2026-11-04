# Boundary Discipline

Apply when: deciding where validation, narrowing, or error handling goes, or where logic lives relative to framework wiring.

Validate at system boundaries and trust internal code. Business logic lives in pure functions; the shell is thin and mechanical.

**Why:** Scattered validation is noisy, redundant, and gives false safety. Logic outside framework wiring can be tested without the framework.

- **At boundaries** (CLI args, config, external APIs, tool inputs, network, files): validate, return errors, handle defensively. Parse raw data into domain types there.
- **Inside:** typed data, error propagation, no re-validation, no deep redundant nil checks.
- **Across the boundary:** expose domain concepts, not transport, storage, framework, or wire types.
- Keep parsing, prompt construction, and scoring as pure transforms: structured state in, value out.

**Tests:** Is this data crossing a boundary right now? If not, the check is redundant. Can this be a pure function the shell calls? If yes, extract it.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-boundary-discipline`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
