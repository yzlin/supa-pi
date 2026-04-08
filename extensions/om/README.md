# Observational Memory Extension

Repo-native pi extension under `extensions/om`.

## What it does

- restores branch-local OM state on `session_start`
- writes observer updates on `turn_end`
- injects a tiny hidden OM header during `context`, including optional continuation hints (`currentTask`, `suggestedNextResponse`) when present
- augments compaction summaries via `session_before_compact` when a prior summary exists
- supports lightweight admin commands
- skips OM-owned persisted entries during observation so OM does not replay its own state or buffers
- rebuilds stale state immediately instead of waiting for the normal token threshold

## Admin commands

- `/om status` — show a centered status modal with current OM counts, observer/reflector thresholds, buffer load, a compact grouped recent-failure summary, recent OM activity, and tabs for browsing facts, threads, observations, and reflections
- `/om rebuild` — rebuild OM from the current branch
- `/om clear` — clear OM state for the current branch

## TUI activity

On meaningful `turn_end` transitions, OM emits TUI notifications and keeps a bounded recent-activity log for `/om status`. In the TUI modal, use `←→`/`tab` to switch tabs, then `↑↓` to move within the selected entity list.

Examples:

- observer applied
- observer skipped because no model/auth was available
- observer returned invalid/empty output, with compact response metadata such as model, stop reason, part counts, content types, and provider error messages when available
- OM raw completion calls now send a non-empty system prompt so codex-style providers that require `instructions` can run observer/reflector/compaction requests
- observer returned no durable memory for a processed window
- observation buffer precompute skipped/failed with a surfaced reason
- grouped failure summary in `/om status` such as `invalid-json×2, missing-model×1`
- buffered observation created/activated/superseded
- cursor advanced with no durable memory extracted
- reflection applied
- buffered reflection created/activated/superseded

## Config file

OM reads optional project-local config from `.pi/om.json` when the extension loads.

Precedence:

1. `.pi/om.json`
2. `DEFAULT_OM_CONFIG_SNAPSHOT`

Notes:

- invalid or malformed `.pi/om.json` falls back to defaults
- OM loads the file on extension load, so config changes require `/reload` or restart
- persisted OM state keeps its `configSnapshot`, but runtime config is re-applied from the current file/defaults when OM restores state

Example `.pi/om.json`:

```json
{
  "enabled": true,
  "shareTokenBudget": false,
  "headerMaxTokens": 800,
  "compactionMaxTokens": 1200,
  "observation": {
    "messageTokens": 12000,
    "previousObserverTokens": 2000,
    "bufferTokens": 0.2,
    "bufferActivation": 0.8,
    "blockAfter": 1.2
  },
  "reflection": {
    "observationTokens": 8000,
    "bufferActivation": 0.5,
    "blockAfter": 1.2
  }
}
```

## Canonical token-budget API

Use the nested `observation` and `reflection` objects going forward.

```ts
const omConfig = {
  shareTokenBudget: false,
  headerMaxTokens: 800,
  compactionMaxTokens: 1200,
  observation: {
    messageTokens: 12000,
    previousObserverTokens: 2000,
    bufferTokens: 0.2,
    bufferActivation: 0.8,
    blockAfter: 1.2,
  },
  reflection: {
    observationTokens: 8000,
    bufferActivation: 0.5,
    blockAfter: 1.2,
  },
};
```

Current defaults in `DEFAULT_OM_CONFIG_SNAPSHOT`:

- `observation.messageTokens: 12000`
- `observation.previousObserverTokens: 2000`
- `observation.bufferTokens: 0.2`
- `observation.bufferActivation: 0.8`
- `observation.blockAfter: 1.2`
- `reflection.observationTokens: 8000`
- `reflection.bufferActivation: 0.5`
- `reflection.blockAfter: 1.2`
- `shareTokenBudget: false`
- `headerMaxTokens: 800`
- `compactionMaxTokens: 1200`

## Alias migration

OM still accepts the legacy flat token-budget aliases during migration:

- `observationMessageTokens` → `observation.messageTokens`
- `observationPreviousTokens` → `observation.previousObserverTokens`
- `reflectionObservationTokens` → `reflection.observationTokens`

Migration rules:

- nested fields are canonical for new config
- if both shapes are provided, nested fields win
- OM normalizes config through `createOmConfigSnapshot`
- normalized snapshots keep the nested canonical fields and compatibility mirrors so restore paths stay compatible with older persisted OM state

## Runtime behavior

### Observation lifecycle

- OM estimates tokens from serialized pending branch turns since `lastProcessedEntryId`
- if pending serialized turns stay below `observation.messageTokens`, OM returns `threshold-not-met`
- in that below-threshold case, OM does not advance `lastProcessedEntryId`, so pending turns keep accumulating until a later `turn_end` crosses the threshold
- once the threshold is crossed, OM observes the full pending branch window and still caps prompt input with `observerMaxTurns`
- if observer invocation fails, returns invalid/empty output, or returns a valid empty result, OM surfaces that reason in recent activity/notifications for the current window
- empty-output diagnostics now include compact response metadata when available (for example `model=openai/gpt-5-mini stop=stop parts=1 textParts=0 textChars=0 types=tool-call`)
- provider-side failures now surface as an error diagnostic instead of being collapsed into `empty-output`, including `error=...` when the provider returns an explicit message
- invalid JSON diagnostics now include a compact truncated `preview="..."` of the raw text response so format drift is visible in `/om status`
- when parsed JSON fails strict observer schema validation, invalid JSON diagnostics also include the first failing `schemaPath=...` and `schemaError="..."`
- `/om status` now wraps long invalid-json previews across multiple recent-activity lines so the payload is inspectable in the TUI
- observer parsing now tolerates close codex-style JSON by defaulting omitted top-level arrays to `[]` and unwrapping a single JSON-string payload before strict schema validation
- observer results may optionally include short `currentTask` / `suggestedNextResponse` continuation hints; provided values overwrite prior hints, omitted values retain prior hints, and blank strings do not auto-clear the current continuation
- retryable observer failures (`missing-model`, `auth-failed`, `aborted`, `empty-output`, `invalid-output`, `completion-error`) do not advance `lastProcessedEntryId`, so the same raw window can be retried later
- stale-state rebuilds and `/om rebuild` force an immediate pass with an effective threshold of `1`

### `shareTokenBudget`

`shareTokenBudget` only changes how much prior observation history is shown back to the observer.

- `false`: use `observation.previousObserverTokens` as configured
- `true`: reserve budget for new raw turns first, then shrink previous observations to whatever token space remains inside `observation.messageTokens`
- if `observation.previousObserverTokens === false`, OM can use the entire remaining shared budget for previous observations

This keeps new branch turns first-class and trims replayed observation context before cutting fresh message history.

### `blockAfter`

`blockAfter` is a synchronous safety valve.

- observer: if the ready pending-turn window reaches `observation.messageTokens * observation.blockAfter`, the window reason becomes `block-after`
- reflector: if retained observation load reaches `reflection.observationTokens * reflection.blockAfter`, the window reason becomes `block-after`

OM still uses the same apply path, but `block-after` documents that buffering is no longer allowed to defer the work.

### Token-first reflection

Reflection readiness is token-first now.

- OM sums retained observation tokens
- if the total stays below `reflection.observationTokens`, reflection is `threshold-not-met`
- once the token threshold is crossed, OM reflects the oldest observations and keeps the newest observations that still fit under the threshold
- `reflectionMinObservationCount` remains on the config snapshot for compatibility and prompt shaping, but runtime readiness is driven by observation tokens

## Buffering behavior

OM supports persisted observation and reflection buffers for near-parity with Mastra-style preparation.

### Observation buffering

- `observation.bufferTokens` controls when OM precomputes buffered observation work
- ratio values below `1` are resolved against `observation.messageTokens`; integer values are treated as absolute token counts; `false` disables observation buffering
- OM precomputes a buffer from the older pending prefix once pending turn tokens cross the buffer step
- `observation.bufferActivation` controls how much raw message pressure the buffer clears on activation by keeping only the newest tail of raw turns live
- with the default `0.8`, OM buffers older turns and keeps roughly the newest `20%` of the observation threshold as raw tail
- buffered observation work is persisted as `om-observation-buffer`
- activation only happens when the later ready observer window still matches the buffered cursor and source entry prefix; otherwise the pending buffer is marked `superseded`
- failed or empty buffer precompute attempts now surface their reason in recent activity/notifications instead of disappearing silently

### Reflection buffering

- `reflection.bufferActivation` controls when OM precomputes reflection work
- OM starts prebuffering once observation tokens reach `reflection.observationTokens * reflection.bufferActivation`
- the buffer covers the older observation prefix and retains the newest observations that still fit inside the activation threshold
- buffered reflection work is persisted as `om-reflection-buffer`
- activation only happens when the later ready reflection window still matches the buffered source observation prefix; otherwise the pending buffer is marked `superseded`

Both buffer types survive restore/restart and can activate on a later `turn_end` without re-invoking the observer or reflector.

## Validation

Run:

```bash
bunx @biomejs/biome check extensions/om
bun test extensions/om
```
