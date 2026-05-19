# Extension registration context

## Active Extensions

An Extension is active only when listed in `package.json -> pi.extensions`.

When documenting active capabilities, prefer `package.json` over directory presence. Extension code may exist in the repo without being loaded by Pi.

## Disabled Extension code

`extensions/om` is present in the repository but intentionally disabled because it is not listed in `package.json -> pi.extensions`.

Do not describe `extensions/om` as active runtime behavior unless package registration changes.

`read-patch` is retired. Its skill-file full-read behavior now belongs to active `extensions/tool-display`; do not re-add `extensions/read-patch.ts` or `extensions/read-patch/` docs.

`extensions/obsidian` is active. It loads vault-local `CLAUDE.md` / `CLAUDE.MD` context from configured Obsidian vaults in `~/.pi/agent/obsidian.json`, injects loaded context through provider payload hooks, and exposes `/obsidian status`.

## Tool ownership and registration order

`extensions/tool-display` owns `read` and optional compact renderers for `grep`, `find`, `ls`, `edit`, and `write`.

`extensions/rtk` owns `bash` execution, output rewrite, statistics, and compaction metadata. RTK may reuse tool-display bash rendering helpers, but tool-display must not register `bash`.

Keep `./extensions/rtk` before `./extensions/tool-display` in `package.json -> pi.extensions` so ownership stays explicit and reviewable.

## Companion packages

Web access tools come from the external `npm:pi-web-access` companion package, not vendored repo code.

## Deployment model

This repo can be developed from any checkout path. The live Pi config is still the `~/.pi/agent` environment described by setup docs.

When changing setup or installation docs, keep this distinction clear:

- development clone — where the repo is edited
- live Pi config — where Pi loads agents, skills, prompts, rules, and extensions

## License context

The root project license is MIT, as declared by `package.json` and `LICENSE.md`.

Copied or adapted upstream materials must include durable source and license attribution in README or nearby docs. Matt-derived materials should mention Matt Pocock, the MIT license name, and the upstream source URL.
