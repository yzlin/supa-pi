---
name: performance-optimization
description: Use when performance requirements exist, users report slow behavior, monitoring shows regressions, Core Web Vitals or load times need improvement, or code handles large datasets/high traffic. Measure first; avoid speculative optimization.
origin: addyosmani/agent-skills adapted
---

# Performance Optimization

Measure before optimizing. Performance work without measurement is guessing. Profile first, identify the actual bottleneck, fix it, measure again, then add a guard when feasible.

## When to Activate

- Performance requirements exist in the spec, such as load-time budgets or response-time SLAs
- Users, monitoring, or tests report slow behavior
- Core Web Vitals or Lighthouse scores regress
- A change introduces high-volume data, large lists, heavy rendering, or high-traffic endpoints
- Profiling identifies a bottleneck that needs fixing

Do **not** use this skill for speculative micro-optimization without evidence or a plausible regression path.

## Workflow

1. **Measure**: establish baseline numbers with synthetic tests, profiling, logs, traces, or production data.
2. **Identify**: name the bottleneck, not just the symptom.
3. **Fix**: make the smallest targeted change that addresses the bottleneck.
4. **Verify**: rerun the same measurement and compare before/after.
5. **Guard**: add a benchmark, perf test, monitoring, budget, or documented follow-up when feasible.

If measurement is blocked, state what is missing and why the risk is still concrete.

## Web Vitals Targets

| Metric | Good | Needs Improvement | Poor |
| --- | --- | --- | --- |
| LCP | ≤ 2.5s | ≤ 4.0s | > 4.0s |
| INP | ≤ 200ms | ≤ 500ms | > 500ms |
| CLS | ≤ 0.1 | ≤ 0.25 | > 0.25 |

## Where to Measure First

| Symptom | Start Here |
| --- | --- |
| First page load slow | Network waterfall, TTFB, render-blocking resources, bundle size, LCP element |
| Interaction lag | Main-thread long tasks, re-renders, expensive event handlers, synchronous work |
| Navigation slow | Data waterfalls, API response times, route-level code splitting, duplicate fetches |
| API endpoint slow | Query logs, indexes, N+1 patterns, external calls, serialization size |
| Intermittent latency | lock contention, GC pauses, connection pools, retries, third-party dependency latency |
| Memory growth | heap snapshots, retained references, unbounded caches, large in-memory queues |

## Common Anti-Patterns

### Backend / Data

- N+1 database or network calls
- fetching all rows instead of paginating/limiting
- missing indexes tied to changed query patterns
- unbounded caches without TTL/max size/invalidation
- synchronous CPU-heavy work in request handlers
- large response payloads or duplicated serialization
- slow third-party calls without timeout, cancellation, fallback, or isolation

### Frontend / Web

- large initial bundle from broad imports or heavy dependencies
- route or component code not split when rarely used
- images without dimensions, responsive sizes, lazy loading, or format optimization
- render-blocking scripts/styles when deferral is possible
- layout shifts from late-loading content or fonts
- controlled input lag from excessive re-rendering

### React

- memoization everywhere without profiling
- unstable object/function props passed to memoized or expensive children
- expensive computations in render paths
- components defined inside components causing remounts
- effects that create waterfalls or duplicate fetches

Use `skills/react-best-practices` for React/Next.js-specific rules and `skills/react-native-skills` for React Native/mobile performance.

## Performance Budgets

Use project-specific budgets when available. If none exist, these are starting points, not universal law:

- initial JavaScript bundle: < 200KB gzipped
- CSS: < 50KB gzipped
- above-the-fold image: < 200KB where practical
- API response time: < 200ms p95 for common read paths
- Time to Interactive: < 3.5s on representative mobile network/device
- Lighthouse Performance: ≥ 90 for key pages

Do not fail work solely on generic budgets when the project has different constraints. Use budgets to start the review conversation.

## Verification Checklist

After performance-related changes:

- [ ] before/after measurements exist, or missing measurement is explained
- [ ] the specific bottleneck is identified
- [ ] the change addresses the bottleneck directly
- [ ] existing behavior tests still pass
- [ ] Web Vitals or Lighthouse checked for page-load work
- [ ] bundle size checked when client imports/dependencies changed
- [ ] endpoint/query timing checked when backend data paths changed
- [ ] no new unbounded data fetch, cache, loop, or queue introduced
- [ ] regression guard added when the risk is recurring

## Red Flags

- optimization without measurement or a concrete regression path
- “fast on my machine” as the only evidence
- broad rewrites sold as optimization
- caching without invalidation or max size
- concurrency without cancellation/error handling
- `useMemo` / `React.memo` everywhere
- list endpoints without limits
- no production monitoring for user-facing performance risks
