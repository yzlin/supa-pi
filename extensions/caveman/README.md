# caveman

Standalone Pi extension for `/caveman` mode.

## Attribution

Inspired by Matt Pocock's caveman skill:
- https://github.com/mattpocock/skills/blob/main/caveman/SKILL.md

It provides:
- `/caveman`, `/caveman on`, `/caveman off`, and `/caveman status`
- per-session persistence with `caveman:mode`
- read fallback for legacy `pieditor:caveman-mode` session entries
- system-prompt injection while active
- generic extension status with key `caveman` and value `🪨 caveman`

Status UIs can display the active mode through Pi's generic extension status channel. `pieditor` also has a dedicated `caveman` status-bar segment that reads the same status key when this extension is loaded.
