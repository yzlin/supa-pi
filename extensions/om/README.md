# Observational Memory Extension

Repo-native pi extension under `extensions/om`.

## What it does

- restores branch-local OM state on `session_start`
- writes observer updates on `turn_end`
- injects a tiny hidden OM header during `context`
- augments compaction summaries via `session_before_compact` when a prior summary exists
- supports lightweight admin commands
- skips OM-owned persisted entries during observation so OM does not replay its own state or buffers
- rebuilds stale state immediately instead of waiting for the normal token threshold

## Admin commands

- `/om-status` — show current OM counts and restore state
- `/om-rebuild` — rebuild OM from the current branch
- `/om-clear` — clear OM state for the current branch

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
- stale-state rebuilds and `/om-rebuild` force an immediate pass with an effective threshold of `1`

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
