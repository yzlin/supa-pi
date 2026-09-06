# Performance Optimization

## Application Performance Policy

Measure before optimizing. Do not add complexity for speculative performance gains.

For actual performance work—performance requirements, a reported or suspected regression, or a measured bottleneck—MUST read and follow the canonical [Performance Optimization](../../skills/performance-optimization/SKILL.md) skill.

Routine work that is already bounded and has no concrete performance signal does not require a performance investigation.

## Mandatory Performance Checks

For non-trivial features or suspected regressions, check for:
- N+1 queries or repeated network/database calls in loops
- unbounded fetches, list endpoints, result sets, queues, or file reads
- missing pagination, streaming, batching, cancellation, or backpressure where data can grow
- unbounded in-memory caches or retained references
- synchronous CPU-heavy work on hot paths or UI/main threads
- large payloads, duplicated serialization, or unnecessary client data
- request waterfalls where independent work could run in parallel

## Review Standard

- Prefer measured evidence over intuition.
- Do not optimize code just because it looks inefficient unless impact is plausible and tied to the change.
- Do not add memoization, caching, concurrency, or new dependencies without clear invalidation, lifecycle, and failure behavior.
- For performance fixes, include before/after numbers when practical.
- If measurement is blocked, state what is missing and why the risk still matters.
