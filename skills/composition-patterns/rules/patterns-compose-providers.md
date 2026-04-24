---
title: Compose Multiple Providers with a Provider Utility
impact: MEDIUM
impactDescription: flattens provider setup and keeps app roots readable
tags: composition, providers, context, utilities
---

## Compose Multiple Providers with a Provider Utility

When a route, app root, or feature needs multiple context providers, avoid
manually nesting providers in JSX. Deep provider pyramids are hard to scan and
make provider ordering changes noisy. Keep the provider stack in an array and
compose it with a small utility.

If the utility does not already exist, add it at `lib/provider.tsx`.

**Incorrect (nested providers):**

```tsx
function Providers({ children }: React.PropsWithChildren) {
  return (
    <ProviderA>
      <ProviderB>
        <ProviderC>{children}</ProviderC>
      </ProviderB>
    </ProviderA>
  )
}
```

**Correct (provider utility):**

```tsx
export interface ProviderProps {
  children: React.ReactNode
}

export interface ComposeProvidersProps {
  providers: React.ComponentType<ProviderProps>[]
  children: React.ReactNode
}

export function ComposeProviders({
  providers,
  children,
}: ComposeProvidersProps) {
  return providers.reduceRight(
    (acc, Provider) => (
      // biome-ignore lint/correctness/useJsxKeyInIterable: no need to add keys here since it's not a list
      <Provider>{acc}</Provider>
    ),
    children,
  )
}
```

**Correct (feature usage):**

```tsx
const providers = [ProviderA, ProviderB, ProviderC]

function Providers({ children }: React.PropsWithChildren) {
  return <ComposeProviders providers={providers}>{children}</ComposeProviders>
}
```

Provider order still matters. The first provider in the array becomes the
outermost provider. Keep the array near the root or feature boundary that owns
that stack, and only use this pattern for providers that share the same simple
`children` props shape.
