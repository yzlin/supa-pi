# LSP extension

Language-agnostic code intelligence for [pi](https://github.com/badlogic/pi-mono) via Language Server Protocol. Purely config-driven — you define which servers to use per project.

> Credit: this extension was originally authored by Juan Albarran in [`dreki-gg/pi-extensions`](https://github.com/dreki-gg/pi-extensions/tree/main/packages/lsp). This repo vendors that work under `extensions/lsp` and may modify it over time.

## Install

Bundled in this repo as `extensions/lsp` and registered from `package.json -> pi.extensions`.

## Tool

Single unified `lsp` tool with 11 operations:

| Operation | Description | Required params |
|-----------|-------------|-----------------|
| `diagnostics` | Type errors + lint warnings | `filePath` |
| `hover` | Type info and documentation | `filePath`, `line`, `character` |
| `goToDefinition` | Find where a symbol is defined | `filePath`, `line`, `character` |
| `findReferences` | Find all references to a symbol | `filePath`, `line`, `character` |
| `goToImplementation` | Find implementations of interface/abstract | `filePath`, `line`, `character` |
| `documentSymbol` | List all symbols in a file | `filePath` |
| `workspaceSymbol` | Search symbols across the workspace | `query` |
| `prepareCallHierarchy` | Get call hierarchy item at position | `filePath`, `line`, `character` |
| `incomingCalls` | Find callers of a function | `filePath`, `line`, `character` |
| `outgoingCalls` | Find callees of a function | `filePath`, `line`, `character` |
| `codeActions` | Quick fixes and refactoring suggestions | `filePath`, `line`, `character` |

All `line`/`character` params are **1-indexed** (matching the `read` tool output).

## Configuration

Servers are configured via two config files (project overrides global):

| File | Scope |
|------|-------|
| `~/.pi/agent/lsp.json` | Global defaults |
| `.pi/lsp.json` | Project-local overrides |

By default, the scaffolded global config includes a conservative starter set inspired by `lsp-pi`: TypeScript/JavaScript, Vue, Svelte, Python, Go, Rust, and Ruby.

### Example: TypeScript + oxlint

`.pi/lsp.json`:
```json
{
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]
    }
  }
}
```

`typescript-language-server` automatically uses the project's local `node_modules/typescript`, so your project's TS version is always respected.

### Adding other servers

`.pi/lsp.json`:
```json
{
  "lsp": {
    "rust": {
      "command": ["rust-analyzer"],
      "extensions": [".rs"]
    },
    "python": {
      "command": ["pyright-langserver", "--stdio"],
      "extensions": [".py"],
      "initialization": {
        "python": { "analysis": { "typeCheckingMode": "basic" } }
      }
    }
  }
}
```

### Disabling a server

```json
{
  "lsp": {
    "typescript": { "disabled": true }
  }
}
```

### Disabling all LSP

```json
{
  "lsp": false
}
```

### Server config options

| Property | Type | Description |
|----------|------|-------------|
| `command` | `string[]` | Command + args to spawn (e.g. `["rust-analyzer"]`) |
| `extensions` | `string[]` | File extensions with leading dot |
| `disabled` | `boolean` | Disable this server |
| `env` | `object` | Environment variables for the server process |
| `initialization` | `object` | Options sent during LSP initialize handshake |

## How it works

- **Auto-detection**: Servers are matched to files by extension. Multiple servers can handle the same extension.
- **Routing**: `diagnostics` aggregates from all matching servers. Other operations use the first server with the required capability.
- **Lazy probe + start**: Server commands are checked only when needed for a matching request, then spawned on first tool use and kept alive for the session.
- **Config merge**: Project `.pi/lsp.json` overrides global `~/.pi/agent/lsp.json`.

## Commands

| Command | Description |
|---------|-------------|
| `/lsp` or `/lsp status` | Show server status, detected servers, and extensions |
| `/lsp restart` | Stop all servers (reinitialize on next tool use) |
| `/lsp help` | Show command help |

## Architecture

```
extensions/lsp/
├── index.ts       — Entry point, server manager, lifecycle
├── protocol.ts    — JSON-RPC over stdio transport
├── client.ts      — High-level LSP client (all 11 operations)
├── config.ts      — Config loading, merging, server resolution
├── tools.ts       — Single unified `lsp` tool registration
├── formatting.ts  — Format all LSP responses for LLM consumption
└── types.ts       — LSP protocol types, config types, operation enums
```
