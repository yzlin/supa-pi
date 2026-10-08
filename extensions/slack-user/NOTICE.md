# Upstream attribution

The TypeScript implementation, original test cases, and setup documentation in this directory are copied or adapted from `pi-slack-user` by the `ferologics/pi-extensions` project:

- Repository: <https://github.com/ferologics/pi-extensions>
- Source directory: `pi-slack-user/`
- Pinned commit: `4099ff811f1f95a63c3aef6abb449e2a9bee0813`
- Source: <https://github.com/ferologics/pi-extensions/tree/4099ff811f1f95a63c3aef6abb449e2a9bee0813/pi-slack-user>
- Published npm package: `@ferologics/pi-extensions` version `0.8.0`
- License declaration: that package's metadata declares `MIT`.

The inspected upstream checkout and published package contain no dedicated root or Slack Extension license text. This notice records the available MIT declaration; it does not invent an upstream copyright holder, copyright date, or missing license text. SupaPi's root MIT license is separate from this upstream metadata evidence.

Local changes adapt imports and formatting for Pi 1.0.1, replace Vitest with Bun tests, add regression assertions, shorten tool guidance, and document SupaPi-local setup and privacy limits. SupaPi also adds terminal-only masked `/slack-user init`, validated private local token storage, and environment-first credential resolution. No upstream browser OAuth workflow or helper scripts are added.
