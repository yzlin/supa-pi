# ADR 0002: Use Pi fullscreen instead of pieditor fixed mode

- Status: Accepted
- Date: 2026-08-06
- Deciders: Ethan
- Supersedes: none
- Superseded by: none

## Context

Pi 0.84 adds an official fullscreen TUI mode with a sticky editor and footer dock, an independently scrollable transcript, and configurable scrollbar behavior. Pieditor previously supplied a fixed-editor compositor and a replacement-surface lease API used by SupaPi's Questionnaire Extension. The compositor-free pieditor work removed both so Pi alone owns viewport rendering; it is published as pieditor 2.0.0.

At decision time, SupaPi supported Pi 0.80.6, generated no TUI-mode setting for fresh installs, and directly integrated Questionnaire with pieditor's lease API. Existing live settings could already contain an explicit TUI-mode preference and must not be overwritten by setup.

## Decision

- Raise SupaPi's minimum supported Pi version and aligned local Pi development pins to 0.84.0.
- Make Pi's official `fullscreen` mode the default in settings newly created by `setup.sh`.
- Do not set `fullscreenScrollbar`; inherit Pi's `auto` default.
- Keep both Pi-owned `regular` and `fullscreen` modes supported. Fullscreen is a setup default, not a hard runtime requirement.
- Do not rewrite existing settings. Document `/settings` and `--tui-mode fullscreen` for existing users.
- Remove SupaPi's pieditor replacement-surface lease integration and call `ctx.ui.custom` directly.
- Keep pieditor for its remaining editor UX and require the compositor-free 2.0.0 runtime package.

## Consequences

Pi becomes the sole owner of regular/fullscreen viewport composition, eliminating SupaPi's obsolete fixed-mode coordination path. Fresh installs receive the intended fullscreen experience while existing user preferences remain stable.

The supported-host floor becomes Pi 0.84.0, so the aligned dependency upgrade and Pi 0.84 breaking changes must pass repository validation. Regular and fullscreen modes both remain in the acceptance matrix. Pinning setup to pieditor 2.0.0 prevents npm-based setup from resolving the older fixed-mode releases.

## Alternatives considered

- Keep fullscreen opt-in: rejected because fresh SupaPi installs would not migrate to the official replacement mode.
- Rewrite existing settings: rejected because setup should not override an explicit UI preference.
- Force an always-visible scrollbar: rejected in favor of Pi's less intrusive `auto` default.
- Drop regular-mode support: rejected because Pi supports runtime mode switching and pieditor is expected to work in either Pi-owned layout.
- Remove pieditor entirely: rejected because its file picker, shell completion, raw paste, status bar, and command-remapping behavior remain useful.
- Point setup at a local pieditor checkout: rejected because it would break SupaPi's reusable installation model.
