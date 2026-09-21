---
summary: "Default-off paid JEV routing over Pi's effective skill catalog, with native fallback and separate authentication and consent."
read_when:
  - "Changing skill-router registration, routing policy, privacy bounds, consent, authentication, limits, lifecycle handling, or rollout claims."
---

# Skill router

`extensions/skill-router` is registered but defaults off. Before a fresh model request, it can ask TypeSafe JEV which skills from Pi's effective catalog apply, replace the native prompt catalog with the selected local skill bodies, and retain a metadata-only recovery catalog for the existing `read` tool. It adds no model tool and does not manage or discover skills itself.

## Commands and paid consent

```text
/skill-router [status|login|logout|enable|disable]
```

- `status` reports enablement, credential source/usability, the session request count, fallback state, and model without sending input.
- `login` is interactive and hidden-input only. After a separate warning and confirmation, it sends one tiny synthetic verification request that may incur a charge, then stores the verified key in the router's owner-only `auth.json`. It does not send repository or conversation content and leaves existing routing consent unchanged.
- `enable` requires an interactive TUI, a usable credential, and explicit consent to paid conversation transfer. It persists `{ "enabled": true }` in the strict owner-only global `PI_CODING_AGENT_DIR/skill-router/config.json`. Headless and worker sessions may consume existing consent but cannot grant it.
- `disable` cancels in-flight routing and persists `false`.
- `logout` cancels in-flight routing, persists `false`, and clears only the router's stored credential. A `TYPESAFE_API_KEY` environment credential remains available after logout and always takes precedence over `auth.json`.

Missing config means disabled. Invalid, unreadable, or unsafely permissioned config fails closed. Registration alone does not enable routing, and this delivery does not write or reload live config.

## Routing contract

The authoritative universe is `before_agent_start.systemPromptOptions.skills`, Pi's effective catalog. The router does not scan the filesystem or add skills. Source and `baseDir` metadata are preserved. Named preloads are honored only when represented in that effective catalog. An empty effective catalog, or exclusion of this Extension, opts out.

Upstream `DefaultResourceLoader.extendResources` and `resources_discover` can repopulate the effective catalog despite original `noSkills` or `skills: false` caller flags. Those original flags are not observable at this hook, so the router does not promise to enforce them. Existing exclusions in `agents/executor.md` and `agents/review-synthesizer.md` remain unchanged.

Skills are automatically eligible unless they set native `disableModelInvocation` or have one of these audited exact names: `execute`, `diagnose`, `grill-me`, `review-orchestration`, `review-fix`, or `simplify`. Unknown imported skills are not quarantined; JEV interprets other description restrictions probabilistically. Slash/explicit input bypasses routing for native handling. A plain-text mention of an audited name conservatively falls back to native discovery. Injected skill text never authorizes gated workflows or actions.

On a successful, certain classification, and only when no earlier handler supplied `forceSystemPrompt`, the router clears the native catalog for that request and injects selected bodies from the frozen effective-catalog paths. It does not claim to remove catalog text already embedded in an opaque inherited prompt. Confidently selecting no skills is valid. Missing capture, Extension-origin input, images, explicit input, oversized or uncertain input, disabled consent, credential/config errors, deadline, cancellation, malformed results, body-read failure, or forced prompts preserve native discovery.

Queued steering/follow-up intent is not sent to JEV; it receives an identity-anchored native-catalog fallback. Provider-only projections preserve prior prefixes through continuations, settling, and fresh requests without mutating canonical history. Selected bodies are source-aware deduplicated and recovered from a frozen snapshot after compaction. Branch/reload/session boundaries reset ephemeral state. The implementation does not promise byte-identical resume caches or projection persistence across process restarts. Known raw-input memory is bounded, and inactive context handling is passive.

## Privacy and limits

The current request is bounded raw input captured before prompt/template expansion. Recent context contains only plain assistant text and previously captured, source-vetted plain user text. The router does not automatically include tool results, files, images, attachments, or skill bodies in JEV requests. Source filtering is not secret detection, and captured raw history can omit resumed or expanded user messages when provenance is unavailable. Conversation text can contain sensitive information.

Routing uses `https://api.typesafe.ai/v1/systemone` with model `jev-latest`. One routing operation has a two-second overall deadline, including preparation, and no automatic retry. Limits are:

- 100 fresh classified requests per `session_start` scope; Extension reload/session start resets the count. This is not a daily or hierarchical dollar cap.
- 256 catalog skills; 16 candidates per JEV batch; at most four batches concurrently.
- 64 bytes per skill name, 1,024 bytes per description, 8,192 bytes each for current-request and recent-context fields, and 65,536 bytes per JEV request.
- At most eight selected skills and 65,536 total selected-body bytes; recovery catalogs are also capped at 65,536 bytes.

Scores at or above `0.9` select and scores at or below `0.1` reject; values between them fall back. These thresholds are experimental and not calibrated.

## Verification and rollout status

Implemented evidence is offline: unit and mocked-transport coverage; real public-SDK faux-provider tests with controlled manual compaction; representative headless config; forced-prompt ordering in both tested orders; transformed/repeated queued prompts; and canonical-history non-mutation assertions. Existing public-SDK tests also prove successful catalog replacement and native fallback around prompt writers. The repository registration test fixes this Extension at the first manifest position.

Not yet verified: live JEV batching compatibility, threshold calibration, latency, actual automatic/overflow compactors, real upstream worker-process E2E, task success or required-skill coverage, and combined JEV/main/worker dollar or provider-cache effects. No live routing experiment, login, activation, or actual credential was used for this implementation. Sift's earlier live verification is not router validation.

Rollout requires user-approved representative live comparisons. A smaller prompt alone is not evidence of success or savings.

## Attribution

Authentication storage is adapted from `pi-typesafe` under the MIT License; see [`LICENSE.pi-typesafe`](LICENSE.pi-typesafe).
