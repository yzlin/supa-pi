# Common Patterns

## Skeleton Projects

When the user explicitly requests a scaffold or skeleton:
1. Search the repository's existing patterns and capabilities first.
2. If no suitable local pattern fits, compare relevant battle-tested skeletons; use parallel agents only when the comparisons are independent and materially useful.
3. Clone or adapt the selected foundation only after choosing it, then iterate within the requested scope and validate incrementally.

For ordinary feature work, reuse existing functionality and repository patterns. Do not search for, parallelize, or clone a skeleton by default.

## Design Patterns

### Repository Pattern

Encapsulate data access behind a consistent interface:
- Define standard operations: findAll, findById, create, update, delete
- Concrete implementations handle storage details (database, API, file, etc.)
- Business logic depends on the abstract interface, not the storage mechanism
- Enables easy swapping of data sources and simplifies testing with mocks

### API Response Format

Use a consistent envelope for all API responses:
- Include a success/status indicator
- Include the data payload (nullable on error)
- Include an error message field (nullable on success)
- Include metadata for paginated responses (total, page, limit)
