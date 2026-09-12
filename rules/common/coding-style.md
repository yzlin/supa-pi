# Coding Style

## Immutability (CRITICAL)

Treat shared and caller-owned values as immutable: do not mutate objects or arrays that other code may observe.

Encapsulated mutation is allowed when ownership is local and clear. Keep it inside the owning function or module and do not expose mutable state.

```text
// Pseudocode
WRONG:  modify(callerOwned, field, value) → changes caller-owned value in-place
CORRECT: update(callerOwned, field, value) → returns new copy with change
ALLOWED: build local object, mutate it privately, then return it
```

Rationale: protecting shared and caller-owned data prevents hidden side effects while allowing simple local construction.

## File Organization

MANY SMALL FILES > FEW LARGE FILES:
- High cohesion, low coupling
- Treat 200-400 lines as typical and roughly 800 lines as a review signal; do not refactor unrelated files solely to hit a size threshold.
- Extract utilities from large modules when it improves cohesion or reduces coupling, or when the requested work needs it.
- Organize by feature/domain, not by type

## Simplicity & Abstraction

Minimum code that solves the request:
- No features beyond what was asked
- No abstractions for single-use code unless an existing pattern requires one
- No new config or extension points for hypothetical future needs
- Prefer simple local code until there is a second real use case

## Error Handling

ALWAYS handle errors comprehensively:
- Handle errors explicitly at every level
- Provide user-friendly error messages in UI-facing code
- Log detailed error context on the server side
- Never silently swallow errors

## Input Validation

ALWAYS validate at system boundaries:
- Validate all user input before processing
- Use schema-based validation where available
- Fail fast with clear error messages
- Never trust external data (API responses, user input, file content)

## Code Quality Checklist

Before marking work complete:
- [ ] Code is readable and well-named
- [ ] Functions are small (<50 lines)
- [ ] Files are focused; roughly 800 lines is a review signal, not an automatic refactor mandate
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling
- [ ] No unexplained magic values (use named constants or config when appropriate)
- [ ] Shared and caller-owned values are not mutated; encapsulated local mutation stays private

## Comment Policy

### Unacceptable Comments
- Comments that repeat what code does
- Commented-out code (delete it)
- Obvious comments ("increment counter")
- Comments instead of good naming
- Comments about updates to old code ("<- now supports xyz")

### Principle
Code should be self-documenting. If you need a comment to explain WHAT the code does, consider refactoring to make it clearer.

When a comment is needed, place it at the boundary that owns the behavior and explain the non-obvious rationale. Include constraints or invalidation conditions only when maintainers need them to recognize when the rationale or code is no longer valid. Do not restate the code, preserve abandoned attempts, or speculate about future work.
