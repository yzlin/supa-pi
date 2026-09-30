/**
 * Single unified `lsp` tool registration.
 *
 * 11 operations routed to the right server by file extension.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { LspClient } from "./client";
import {
  formatCallHierarchy,
  formatCodeActions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatIncomingCalls,
  formatLocations,
  formatOutgoingCalls,
  formatWorkspaceSymbols,
} from "./formatting";
import {
  attachLspPresentation,
  type DiagnosticCounts,
  getLspPresentation,
  type LspPresentationDetails,
  rememberLspPresentation,
  renderLspToolCall,
  renderLspToolResult,
} from "./presentation";
import type { Diagnostic, DocumentSymbol, SymbolInformation } from "./types";
import {
  DiagnosticSeverity,
  FILE_ONLY_OPERATIONS,
  LSP_OPERATIONS,
  type LspOperation,
  POSITION_OPERATIONS,
  QUERY_OPERATIONS,
} from "./types";

const TOP_LEVEL_REGEX_1 = /^@/;

// ── Helpers ─────────────────────────────────────────────────────────────────

function cleanPath(path: string): string {
  return path.replace(TOP_LEVEL_REGEX_1, "");
}

function toZeroIndexed(oneIndexed: number): number {
  return Math.max(0, oneIndexed - 1);
}

function validateParams(
  operation: LspOperation,
  filePath?: string,
  line?: number,
  character?: number,
  query?: string,
): string | null {
  if (POSITION_OPERATIONS.includes(operation)) {
    if (!filePath) {
      return `Operation '${operation}' requires filePath`;
    }
    if (line === undefined) {
      return `Operation '${operation}' requires line`;
    }
    if (character === undefined) {
      return `Operation '${operation}' requires character`;
    }
  }
  if (FILE_ONLY_OPERATIONS.includes(operation) && !filePath) {
    return `Operation '${operation}' requires filePath`;
  }
  if (QUERY_OPERATIONS.includes(operation) && !query) {
    return `Operation '${operation}' requires query`;
  }
  return null;
}

// ── Types ───────────────────────────────────────────────────────────────────

interface DiagnosticsClient {
  readonly config: { readonly name: string };
  getDiagnostics: (filePath: string) => Promise<Diagnostic[]>;
}

export interface ServerManager {
  /** Get all LSP clients that handle a given file extension. */
  clientsForFile: (filePath: string) => DiagnosticsClient[];
  /** Get the first LSP client that handles a file and has a capability. */
  clientForFileWithCapability: (
    filePath: string,
    capability: string,
  ) => LspClient | null;
  /** Get any initialized client (for workspace-wide ops). */
  anyClient: () => LspClient | null;
  /** Current root path. */
  getRootPath: () => string;
}

function emptyDiagnosticCounts(): DiagnosticCounts {
  return {
    errors: 0,
    warnings: 0,
    information: 0,
    hints: 0,
    other: 0,
    total: 0,
  };
}

function countDiagnosticGroups(
  groups: { diagnostics: Diagnostic[] }[],
): DiagnosticCounts {
  const counts = emptyDiagnosticCounts();
  for (const group of groups) {
    for (const diagnostic of group.diagnostics) {
      counts.total += 1;
      switch (diagnostic.severity) {
        case DiagnosticSeverity.Error:
          counts.errors += 1;
          break;
        case DiagnosticSeverity.Warning:
          counts.warnings += 1;
          break;
        case DiagnosticSeverity.Information:
          counts.information += 1;
          break;
        case DiagnosticSeverity.Hint:
          counts.hints += 1;
          break;
        default:
          counts.other += 1;
          break;
      }
    }
  }
  return counts;
}

function countDocumentSymbols(
  symbols: DocumentSymbol[] | SymbolInformation[],
): number {
  return symbols.reduce((count, symbol) => {
    if ("selectionRange" in symbol) {
      return count + 1 + countDocumentSymbols(symbol.children ?? []);
    }
    return count + 1;
  }, 0);
}

function countOutcome(
  operation: LspOperation,
  noun: string,
  count: number,
  emptyLabel?: string,
): LspPresentationDetails {
  return {
    operation,
    result: { kind: "count", noun, count, emptyLabel },
  };
}

function informationOutcome(
  operation: LspOperation,
  found: boolean,
): LspPresentationDetails {
  return { operation, result: { kind: "information", found } };
}

function diagnosticsOutcome(
  status: "success" | "incomplete" | "unavailable",
  counts: DiagnosticCounts,
  failures?: string[],
): LspPresentationDetails {
  return {
    operation: "diagnostics",
    result: { kind: "diagnostics", status, counts, failures },
  };
}

class LspExecutionError extends Error {
  readonly presentation: LspPresentationDetails;

  constructor(message: string, presentation: LspPresentationDetails) {
    super(message);
    this.presentation = presentation;
  }
}

function errorPresentation(
  operation: LspOperation,
  error: unknown,
): LspPresentationDetails {
  if (error instanceof LspExecutionError) {
    return error.presentation;
  }
  return {
    operation,
    result: {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function withoutLspPresentation(details: unknown): unknown {
  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details) ||
    !("lspPresentation" in details)
  ) {
    return details;
  }
  const { lspPresentation: _presentation, ...rest } = details as Record<
    string,
    unknown
  >;
  return rest;
}

function withPresentationDuration<T extends { details?: unknown }>(
  result: T,
  presentation: LspPresentationDetails,
  durationMs: number,
  toolCallId: string,
): T {
  const settledPresentation = { ...presentation, durationMs };
  rememberLspPresentation(toolCallId, settledPresentation);
  return {
    ...result,
    details: withoutLspPresentation(result.details),
  };
}

// ── Capability map ──────────────────────────────────────────────────────────

const CAPABILITY_MAP: Record<LspOperation, string> = {
  diagnostics: "textDocumentSync", // all servers with sync support
  hover: "hoverProvider",
  goToDefinition: "definitionProvider",
  findReferences: "referencesProvider",
  goToImplementation: "implementationProvider",
  documentSymbol: "documentSymbolProvider",
  workspaceSymbol: "workspaceSymbolProvider",
  prepareCallHierarchy: "callHierarchyProvider",
  incomingCalls: "callHierarchyProvider",
  outgoingCalls: "callHierarchyProvider",
  codeActions: "codeActionProvider",
};

// ── Registration ────────────────────────────────────────────────────────────

export function registerLspTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  mgr: ServerManager,
) {
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: [
      "Interact with Language Server Protocol servers for code intelligence.",
      "",
      "Supported operations:",
      "  goToDefinition    — find where a symbol is defined",
      "  findReferences    — find all references to a symbol",
      "  hover             — get type info and documentation for a symbol",
      "  diagnostics       — get type errors and lint warnings for a file",
      "  documentSymbol    — get all symbols in a file",
      "  workspaceSymbol   — search for symbols across the workspace",
      "  goToImplementation — find implementations of an interface/abstract method",
      "  prepareCallHierarchy — get call hierarchy item at a position",
      "  incomingCalls     — find callers of a function/method",
      "  outgoingCalls     — find callees of a function/method",
      "  codeActions       — get quick fixes and refactoring suggestions",
      "",
      "Parameters:",
      "  operation (required) — one of the operations above",
      "  filePath  — file path relative to project root (required for most operations)",
      "  line      — line number, 1-indexed (required for position-based operations)",
      "  character — column number, 1-indexed (required for position-based operations)",
      "  query     — search string (required for workspaceSymbol)",
    ].join("\n"),
    promptSnippet:
      "Interact with LSP servers for code intelligence: definitions, references, hover, diagnostics, symbols, call hierarchy, code actions",
    promptGuidelines: [
      "Use `diagnostics` after editing files to check for type errors and lint issues.",
      "Use `hover` to understand types, `goToDefinition` to navigate, `findReferences` before refactoring.",
      "Line and character are 1-indexed — use the line numbers shown by the read tool.",
      "LSP servers are auto-detected by file extension. Use /lsp to check status.",
    ],
    parameters: Type.Object({
      operation: StringEnum(LSP_OPERATIONS),
      filePath: Type.Optional(
        Type.String({ description: "File path relative to project root" }),
      ),
      line: Type.Optional(
        Type.Number({ description: "Line number (1-indexed)" }),
      ),
      character: Type.Optional(
        Type.Number({ description: "Column number (1-indexed)" }),
      ),
      query: Type.Optional(
        Type.String({ description: "Search query (for workspaceSymbol)" }),
      ),
    }),
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderLspToolCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderLspToolResult(result, options, theme, context);
    },
    async execute(toolCallId, params, _signal, _onUpdate) {
      const startedAt = Date.now();
      try {
        const result = await (async () => {
          const operation = params.operation as LspOperation;
          const filePath = params.filePath
            ? cleanPath(params.filePath)
            : undefined;
          const line = params.line;
          const character = params.character;
          const query = params.query;
          const rootPath = mgr.getRootPath();

          // Validate required params
          const validationError = validateParams(
            operation,
            filePath,
            line,
            character,
            query,
          );
          if (validationError) {
            throw new Error(validationError);
          }

          // ── diagnostics (aggregate from all matching servers) ──
          if (operation === "diagnostics") {
            return executeDiagnostics(mgr, filePath!, rootPath);
          }

          // ── workspaceSymbol (doesn't need a file-based server lookup) ──
          if (operation === "workspaceSymbol") {
            return executeWorkspaceSymbol(mgr, query!, rootPath);
          }

          // ── all other operations: route to first capable server ──
          const capability = CAPABILITY_MAP[operation];
          const client = mgr.clientForFileWithCapability(filePath!, capability);
          if (!client) {
            throw new Error(
              `No LSP server with '${operation}' capability found for ${filePath}. Check /lsp status.`,
            );
          }

          const pos = {
            line: toZeroIndexed(line!),
            character: toZeroIndexed(character!),
          };

          switch (operation) {
            case "hover": {
              const hoverResult = await client.hover(filePath!, pos);
              return ok(
                formatHover(hoverResult, filePath!, pos.line, pos.character),
                informationOutcome("hover", hoverResult !== null),
              );
            }

            case "goToDefinition": {
              const locs = await client.definition(filePath!, pos);
              return ok(
                formatLocations(
                  locs,
                  "Definition",
                  filePath!,
                  pos.line,
                  pos.character,
                  rootPath,
                ),
                countOutcome("goToDefinition", "definition", locs.length),
              );
            }

            case "findReferences": {
              const locs = await client.references(filePath!, pos);
              return ok(
                formatLocations(
                  locs,
                  "References",
                  filePath!,
                  pos.line,
                  pos.character,
                  rootPath,
                ),
                countOutcome("findReferences", "reference", locs.length),
              );
            }

            case "goToImplementation": {
              const locs = await client.implementation(filePath!, pos);
              return ok(
                formatLocations(
                  locs,
                  "Implementation",
                  filePath!,
                  pos.line,
                  pos.character,
                  rootPath,
                ),
                countOutcome(
                  "goToImplementation",
                  "implementation",
                  locs.length,
                ),
              );
            }

            case "documentSymbol": {
              const symbols = await client.documentSymbol(filePath!);
              return ok(
                formatDocumentSymbols(symbols, filePath!, rootPath),
                countOutcome(
                  "documentSymbol",
                  "symbol",
                  countDocumentSymbols(symbols),
                ),
              );
            }

            case "prepareCallHierarchy": {
              const items = await client.prepareCallHierarchy(filePath!, pos);
              return ok(
                formatCallHierarchy(
                  items,
                  filePath!,
                  pos.line,
                  pos.character,
                  rootPath,
                ),
                countOutcome(
                  "prepareCallHierarchy",
                  "call hierarchy item",
                  items.length,
                  "call hierarchy information",
                ),
              );
            }

            case "incomingCalls": {
              const items = await client.prepareCallHierarchy(filePath!, pos);
              if (items.length === 0) {
                return ok(
                  `No call hierarchy item at ${filePath!}:${line}:${character}`,
                  countOutcome(
                    "incomingCalls",
                    "incoming call",
                    0,
                    "call hierarchy information",
                  ),
                );
              }
              const calls = await client.incomingCalls(items[0]);
              return ok(
                formatIncomingCalls(calls, items[0], rootPath),
                countOutcome("incomingCalls", "incoming call", calls.length),
              );
            }

            case "outgoingCalls": {
              const items = await client.prepareCallHierarchy(filePath!, pos);
              if (items.length === 0) {
                return ok(
                  `No call hierarchy item at ${filePath!}:${line}:${character}`,
                  countOutcome(
                    "outgoingCalls",
                    "outgoing call",
                    0,
                    "call hierarchy information",
                  ),
                );
              }
              const calls = await client.outgoingCalls(items[0]);
              return ok(
                formatOutgoingCalls(calls, items[0], rootPath),
                countOutcome("outgoingCalls", "outgoing call", calls.length),
              );
            }

            case "codeActions": {
              const diagsForFile = await client.getDiagnostics(filePath!);
              const zeroLine = toZeroIndexed(line!);
              const lineDiags = diagsForFile.filter(
                (d) =>
                  d.range.start.line <= zeroLine &&
                  d.range.end.line >= zeroLine,
              );
              const range = {
                start: { line: zeroLine, character: 0 },
                end: { line: zeroLine, character: Number.MAX_SAFE_INTEGER },
              };
              const actions = await client.codeActions(filePath!, range, {
                diagnostics: lineDiags,
              });
              return ok(
                formatCodeActions(actions, filePath!, zeroLine),
                countOutcome("codeActions", "code action", actions.length),
              );
            }

            default:
              throw new Error(`Unknown operation: ${operation}`);
          }
        })();
        const metadata = getLspPresentation(result.details);
        return metadata
          ? withPresentationDuration(
              result,
              metadata,
              Date.now() - startedAt,
              toolCallId,
            )
          : result;
      } catch (error) {
        const operation = params.operation as LspOperation;
        rememberLspPresentation(toolCallId, {
          ...errorPresentation(operation, error),
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
  });
}

// ── Operation executors ─────────────────────────────────────────────────────

async function executeDiagnostics(
  mgr: ServerManager,
  filePath: string,
  _rootPath: string,
) {
  const groups: { source: string; diagnostics: Diagnostic[] }[] = [];
  const errors: string[] = [];
  const successfulSources: string[] = [];
  const clients = mgr.clientsForFile(filePath);
  if (clients.length === 0) {
    throw new LspExecutionError(
      `LSP diagnostics unavailable for ${filePath}: no matching LSP servers. Check /lsp status.`,
      diagnosticsOutcome("unavailable", emptyDiagnosticCounts()),
    );
  }

  for (const client of clients) {
    try {
      const diags = await client.getDiagnostics(filePath);
      successfulSources.push(client.config.name);
      if (diags.length > 0) {
        groups.push({ source: client.config.name, diagnostics: diags });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${client.config.name}: ${message}`);
    }
  }

  if (successfulSources.length === 0) {
    throw new LspExecutionError(
      `LSP diagnostics unavailable for ${filePath}: all matching servers failed.\nServer errors: ${errors.join("; ")}`,
      diagnosticsOutcome("unavailable", emptyDiagnosticCounts(), errors),
    );
  }

  const counts = countDiagnosticGroups(groups);
  if (errors.length > 0) {
    const successfulResult =
      groups.length > 0
        ? formatDiagnostics(filePath, groups)
        : `${successfulSources.join(", ")} returned no diagnostics.`;
    throw new LspExecutionError(
      `LSP diagnostics incomplete for ${filePath}.\n\n${successfulResult}\n\nServer errors: ${errors.join("; ")}`,
      diagnosticsOutcome("incomplete", counts, errors),
    );
  }

  const text = formatDiagnostics(filePath, groups);
  const presentation = diagnosticsOutcome("success", counts, errors);
  return {
    content: [{ type: "text" as const, text }],
    details: attachLspPresentation(
      {
        groups: groups.map((g) => ({
          source: g.source,
          count: g.diagnostics.length,
        })),
        errors,
      },
      presentation,
    ),
  };
}

async function executeWorkspaceSymbol(
  mgr: ServerManager,
  query: string,
  rootPath: string,
) {
  const client = mgr.anyClient();
  if (!client) {
    throw new Error("No LSP server available for workspace symbol search.");
  }

  const symbols = await client.workspaceSymbol(query);
  return ok(
    formatWorkspaceSymbols(symbols, query, rootPath),
    countOutcome("workspaceSymbol", "symbol", symbols.length),
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ok(text: string, presentation: LspPresentationDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details: attachLspPresentation({}, presentation),
  };
}
