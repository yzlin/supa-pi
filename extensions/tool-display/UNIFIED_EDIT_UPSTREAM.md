# Unified-edit upstream pin

The parser, planner, and matcher in this directory are ported from
[`mitsuhiko/agent-stuff`](https://github.com/mitsuhiko/agent-stuff) at immutable
commit **`4bce45560fa55ace2f5dc8634a63a2af464ddc8b`**, file
`extensions/unified-edit.ts`.

The upstream work is Copyright Armin Ronacher and contributors and licensed
under the Apache License 2.0. Local files retain prominent source notices.

Supa-pi modifications isolate focused APIs, expose the product as a local
unified-edit dialect, reject ambiguous fuzzy matches and argument objects, and
preserve BOM/line-ending intent in planning results. Retired local classic,
`multi`, and `edits` argument shapes are not supported.
