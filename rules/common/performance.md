# Performance Optimization

## Application Performance Policy

Measure before optimizing. Do not add complexity for speculative performance gains.

Use this workflow for performance work:
1. **Measure**: establish a baseline with reproducible numbers or production data.
2. **Identify**: name the specific bottleneck.
3. **Fix**: change the smallest thing that addresses that bottleneck.
4. **Verify**: measure again and compare before/after.
5. **Guard**: add a benchmark, test, budget, monitoring, or documented follow-up when feasible.

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

## Model Selection Strategy

Use measured GPT-5.6 routes:

- **gpt-5.6-luna, low**: codebase exploration
- **gpt-5.6-terra, low**: documentation and E2E verification
- **gpt-5.6-sol, medium**: validated execution, build-fix, dead-code cleanup, and TDD execution
- **gpt-5.6-sol, high**: main sessions, planning, architecture, research, and high-risk reviews

Use `xhigh`, `max`, or Pro mode only when a route-specific eval proves a quality gain. Preserve `transport: "auto"` unless a benchmark proves otherwise.

## Context Window Management

Avoid last 20% of context window for:
- Large-scale refactoring
- Feature implementation spanning multiple files
- Debugging complex interactions

Lower context sensitivity tasks:
- Single-file edits
- Independent utility creation
- Documentation updates
- Simple bug fixes

## Build Troubleshooting

If build fails:
1. Use **build-error-resolver** agent
2. Analyze error messages
3. Fix incrementally
4. Verify after each fix
