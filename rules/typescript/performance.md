---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---
# TypeScript/JavaScript Performance

> This file extends [common/performance.md](../common/performance.md) with TypeScript/JavaScript specific content.

## Async and Data Loading

- Start independent async work early and await it together with `Promise.all` or an equivalent pattern.
- Avoid serial `await` in loops unless each step depends on the previous result.
- Avoid client/server data waterfalls; fetch at the highest practical boundary and pass only needed data.
- Add pagination, limits, cancellation, or streaming for data that can grow.

## API and Backend Hot Paths

- Keep request handlers bounded in CPU, memory, network calls, and result size.
- Avoid synchronous CPU-heavy work in request paths; offload, chunk, cache, or precompute when justified.
- Avoid unbounded process-level caches; define TTL, max size, and invalidation behavior.
- Log or measure endpoint timing when performance matters or regressions are suspected.

## Web UI and Bundles

- Avoid broad imports that pull large client bundles; use direct imports or dynamic imports for heavy, rarely used code.
- Lazy-load expensive UI only when it is not required for the initial interaction.
- Provide image dimensions; use responsive sizes and lazy loading for below-the-fold images.
- Avoid layout shifts from late-loading images, fonts, or injected content.

## React

- Do not add `useMemo`, `useCallback`, or `React.memo` everywhere by default; profile or tie to a concrete re-render issue.
- Stabilize non-primitive props only when they cross memoized or expensive component boundaries.
- Keep expensive computation out of render paths unless memoized with correct dependencies.
- Avoid defining components inside components when it causes remounts or expensive re-renders.

## Verification

For performance-related changes, prefer:
- before/after measurements with the same scenario and environment
- bundle-size diff when client imports change
- endpoint/query timing when backend data paths change
- Web Vitals or Lighthouse evidence for page-load regressions
- regression guard in CI or monitoring when the risk is recurring
