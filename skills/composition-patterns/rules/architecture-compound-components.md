---
title: Use Compound Components
impact: HIGH
impactDescription: enables flexible composition without prop drilling
tags: composition, compound-components, architecture
---

## Use Compound Components

Structure complex components as compound components with a shared context. Each
subcomponent accesses shared state via context, not props. Consumers compose the
pieces they need.

**Incorrect (monolithic component with render props):**

```tsx
function Composer({
  renderHeader,
  renderFooter,
  renderActions,
  showAttachments,
  showFormatting,
  showEmojis,
}: Props) {
  return (
    <form>
      {renderHeader?.()}
      <Input />
      {showAttachments && <Attachments />}
      {renderFooter ? (
        renderFooter()
      ) : (
        <Footer>
          {showFormatting && <Formatting />}
          {showEmojis && <Emojis />}
          {renderActions?.()}
        </Footer>
      )}
    </form>
  )
}
```

**Correct (compound components with a shared context helper):**

Put the reusable context factory in the target project's shared utilities. If
there is no existing helper, add one at `lib/context.tsx`.

```tsx
// lib/context.tsx
import React from "react"

export interface CreateContextOptions {
  /**
   * If `true`, React will throw if context is `null` or `undefined`
   * In some cases, you might want to support nested context, so you can set it to `false`
   */
  strict?: boolean
  /**
   * Error message to throw if the context is `undefined`
   */
  errorMessage?: string
  /**
   * The display name of the context
   */
  name?: string
}

export type CreateContextReturn<T> = [
  React.Provider<T>,
  () => T,
  React.Context<T>,
]

/**
 * Creates a named context, provider, and hook.
 *
 * @param options create context options
 */
export function createContext<ContextType>(
  options: CreateContextOptions = {},
) {
  const {
    strict = true,
    errorMessage = "useContext: `context` is undefined. Seems you forgot to wrap component within the Provider",
    name,
  } = options

  const Context = React.createContext<ContextType | undefined>(undefined)

  Context.displayName = name

  function useContext() {
    const context = React.useContext(Context)

    if (!context && strict) {
      const error = new Error(errorMessage)

      error.name = "ContextError"
      Error.captureStackTrace?.(error, useContext)
      throw error
    }

    return context
  }

  return [Context.Provider, useContext, Context] as CreateContextReturn<ContextType>
}
```

Then create the provider and hook from that helper instead of calling
`React.createContext` inline in the component module.

```tsx
import React from "react"
import { createContext } from "@/lib/context"

interface ComposerContextValue {
  state: ComposerState
  actions: {
    update: (updater: (state: ComposerState) => ComposerState) => void
    submit: () => void
  }
  meta: {
    inputRef: React.RefObject<TextInput | null>
  }
}

const [ComposerContextProvider, useComposerContext] =
  createContext<ComposerContextValue>({
    name: "ComposerContext",
  })

function ComposerProvider({ children, state, actions, meta }: ProviderProps) {
  const value = React.useMemo(
    () => ({ state, actions, meta }),
    [state, actions, meta],
  )

  return (
    <ComposerContextProvider value={value}>
      {children}
    </ComposerContextProvider>
  )
}

function ComposerFrame({ children }: { children: React.ReactNode }) {
  return <form>{children}</form>
}

function ComposerInput() {
  const {
    state,
    actions: { update },
    meta: { inputRef },
  } = useComposerContext()

  return (
    <TextInput
      ref={inputRef}
      value={state.input}
      onChangeText={(text) => update((s) => ({ ...s, input: text }))}
    />
  )
}

function ComposerSubmit() {
  const {
    actions: { submit },
  } = useComposerContext()

  return <Button onPress={submit}>Send</Button>
}

// Export as compound component
const Composer = {
  Provider: ComposerProvider,
  Frame: ComposerFrame,
  Input: ComposerInput,
  Submit: ComposerSubmit,
  Header: ComposerHeader,
  Footer: ComposerFooter,
  Attachments: ComposerAttachments,
  Formatting: ComposerFormatting,
  Emojis: ComposerEmojis,
}
```

**Same helper, domain-specific context:**

```tsx
interface AddCommentContextValue {
  activity: ActivityResponse
  commentInputRef: React.RefObject<EnrichedTextInputInstance | null>
}

const [AddCommentContextProvider, useAddCommentContext] =
  createContext<AddCommentContextValue>({
    name: "AddCommentContext",
  })
```

**Usage:**

```tsx
<Composer.Provider state={state} actions={actions} meta={meta}>
  <Composer.Frame>
    <Composer.Header />
    <Composer.Input />
    <Composer.Footer>
      <Composer.Formatting />
      <Composer.Submit />
    </Composer.Footer>
  </Composer.Frame>
</Composer.Provider>
```

Consumers explicitly compose exactly what they need. No hidden conditionals. And the state, actions and meta are dependency-injected by a parent provider, allowing multiple usages of the same component structure.
