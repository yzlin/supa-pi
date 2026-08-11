---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---
# TypeScript/JavaScript Coding Style

> This file extends [common/coding-style.md](../common/coding-style.md) with TypeScript/JavaScript specific content.

## Tailwind Class Composition

- Keep static `className` values as plain strings
- Do not interpolate conditional classes inside template literals
- When `tailwind-variants` is installed, import and use its `cn()` for simple conditional classes and caller-provided `className` merging
- Prefer `tv()` for named, reusable, or compound component variants
- Without `tailwind-variants`, use the project's existing `cn()` utility

```tsx
import { cn } from 'tailwind-variants'

className={cn(
  'bg-background',
  isActive ? 'text-blue' : 'text-black',
  className
)}
```

## Immutability

Use spread operator for immutable updates:

```typescript
// WRONG: Mutation
function updateUser(user, name) {
  user.name = name  // MUTATION!
  return user
}

// CORRECT: Immutability
function updateUser(user, name) {
  return {
    ...user,
    name
  }
}
```

## Error Handling

Use async/await with try-catch:

```typescript
try {
  const result = await riskyOperation()
  return result
} catch (error) {
  console.error('Operation failed:', error)
  throw new Error('Detailed user-friendly message')
}
```

## Input Validation

Use Zod for schema-based validation:

```typescript
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150)
})

const validated = schema.parse(input)
```

## Console.log

- No `console.log` statements in production code
- Use proper logging libraries instead
- See hooks for automatic detection
