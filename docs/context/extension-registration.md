# Extension registration context

## Active Extensions

An Extension is active only when listed in `package.json -> pi.extensions`.

When documenting active capabilities, prefer `package.json` over directory presence. Extension code may exist in the repo without being loaded by Pi.

## Disabled Extension code

`extensions/om` is present in the repository but intentionally disabled because it is not listed in `package.json -> pi.extensions`.

Do not describe `extensions/om` as active runtime behavior unless package registration changes.

## Deployment model

This repo can be developed from any checkout path. The live Pi config is still the `~/.pi/agent` environment described by setup docs.

When changing setup or installation docs, keep this distinction clear:

- development clone — where the repo is edited
- live Pi config — where Pi loads agents, skills, prompts, rules, and extensions

## License context

The root project license is unresolved. Keep this as an open question until a license is chosen.

Copied or adapted upstream materials must include durable source and license attribution in README or nearby docs. Matt-derived materials should mention Matt Pocock, the MIT license name, and the upstream source URL.
