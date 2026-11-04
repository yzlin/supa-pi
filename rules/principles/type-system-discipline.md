# Type System Discipline

Apply when: defining types, crossing a data boundary, or handling special cases.

Make the compiler reject impossible states, mismatched primitives, and unhandled variants. Define errors and special cases out of existence instead of adding handlers. Language specifics live in `rules/typescript/`, `rules/swift/`, and `rules/python/`.

- **Brand semantic primitives.** `UserId` and `OrderId` should not be interchangeable even if both are strings. Validate once at creation; trust the type downstream.
- **External data is untyped until parsed.** RPC payloads, JSON, IPC, CLI args, config, env vars, database rows: parse each into the typed model at the boundary, per [boundary-discipline](boundary-discipline.md).
- **Derive types from the owning schema** (OpenAPI, GraphQL, protobuf, migrations, JSON Schema/TypeBox) instead of hand-rolling a parallel type.
- No `any`, unchecked casts, or suppressed type errors to get green.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-type-system-discipline`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
