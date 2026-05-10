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

For React/TSX UI work, read local skills `skills/composition-patterns` and, when performance matters, `skills/react-best-practices`.

Project defaults:

- prefer composition over boolean mode props
- prefer explicit variant components over feature flags
- prefer provider-backed compound components for complex shared state
- prefer children/composition over render-prop sprawl unless a callback API is actually needed

## Import Cycles

Avoid import cycles. No exceptions.

- Do not introduce direct or indirect circular imports between TypeScript/JavaScript modules.
- If modules need shared behavior or types, extract the shared dependency into a lower-level module.
- Keep dependency direction one-way across layers and feature boundaries.
- Before merging non-trivial module wiring changes, check with the repo's cycle detector when available (for example `madge`, `dpdm`, `dependency-cruiser`, or the project lint command).
