---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---
# TypeScript/JavaScript Patterns

> This file extends [common/patterns.md](../common/patterns.md) with TypeScript/JavaScript specific content.

## API Response Format

```typescript
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  meta?: {
    total: number
    page: number
    limit: number
  }
}
```

## Custom Hooks Pattern

```typescript
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(handler)
  }, [value, delay])

  return debouncedValue
}
```

## Repository Pattern

```typescript
interface Repository<T> {
  findAll(filters?: Filters): Promise<T[]>
  findById(id: string): Promise<T | null>
  create(data: CreateDto): Promise<T>
  update(id: string, data: UpdateDto): Promise<T>
  delete(id: string): Promise<void>
}
```

## React Guidance

For React/TSX work, favor these skills and read them before implementing when relevant:

- `vercel-composition-patterns` for:
  - boolean prop proliferation
  - compound components
  - provider/context API design
  - reusable component APIs
  - refactors from mode flags to composition
- `vercel-react-best-practices` for:
  - React component and page performance
  - Next.js patterns and data fetching
  - bundle optimization
  - rendering strategy and UI update costs
  - React/Next refactors where performance guidance matters
- `react-native-best-practices` for:
  - React Native performance profiling and optimization
  - FPS, TTI, memory leaks, bundle size, and re-render issues
  - Hermes, JS thread blocking, bridge overhead, FlashList, and native modules
  - debugging jank, frame drops, and startup performance
- `vercel-react-native-skills` for:
  - React Native and Expo app architecture
  - list and scroll performance
  - Reanimated and gesture-driven animations
  - Expo/native UI patterns, images, navigation, and platform APIs
  - Expo/React Native refactors where mobile best practices matter

Project preference:

- prefer composition over boolean mode props
- prefer explicit variant components over feature flags
- prefer provider-backed compound components for complex shared state
- prefer established React/Next performance patterns over ad hoc optimizations
- for React Native or Expo work, prefer established mobile performance and platform patterns over web-first abstractions
