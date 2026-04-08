/**
 * Format LSP responses into concise text for the LLM.
 */

import { uriToPath } from "./client";
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  Range,
  SymbolInformation,
} from "./types";
import { DiagnosticSeverity, SymbolKind } from "./types";

// ── Shared ──────────────────────────────────────────────────────────────────

function severityLabel(severity?: number): string {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "ERROR";
    case DiagnosticSeverity.Warning:
      return "WARN";
    case DiagnosticSeverity.Information:
      return "INFO";
    case DiagnosticSeverity.Hint:
      return "HINT";
    default:
      return "UNKNOWN";
  }
}

function symbolKindLabel(kind: SymbolKind): string {
  const labels: Record<number, string> = {
    [SymbolKind.File]: "file",
    [SymbolKind.Module]: "module",
    [SymbolKind.Namespace]: "namespace",
    [SymbolKind.Package]: "package",
    [SymbolKind.Class]: "class",
    [SymbolKind.Method]: "method",
    [SymbolKind.Property]: "property",
    [SymbolKind.Field]: "field",
    [SymbolKind.Constructor]: "constructor",
    [SymbolKind.Enum]: "enum",
    [SymbolKind.Interface]: "interface",
    [SymbolKind.Function]: "function",
    [SymbolKind.Variable]: "variable",
    [SymbolKind.Constant]: "constant",
    [SymbolKind.String]: "string",
    [SymbolKind.Number]: "number",
    [SymbolKind.Boolean]: "boolean",
    [SymbolKind.Array]: "array",
    [SymbolKind.Object]: "object",
    [SymbolKind.Key]: "key",
    [SymbolKind.Null]: "null",
    [SymbolKind.EnumMember]: "enum-member",
    [SymbolKind.Struct]: "struct",
    [SymbolKind.Event]: "event",
    [SymbolKind.Operator]: "operator",
    [SymbolKind.TypeParameter]: "type-param",
  };
  return labels[kind] ?? `kind(${kind})`;
}

function fmtRange(range: Range): string {
  const sl = range.start.line + 1;
  const sc = range.start.character + 1;
  const el = range.end.line + 1;
  const ec = range.end.character + 1;
  return sl === el ? `line ${sl}:${sc}-${ec}` : `lines ${sl}:${sc}-${el}:${ec}`;
}

function relativePath(uri: string, rootPath: string): string {
  let p = uriToPath(uri);
  if (p.startsWith(rootPath + "/")) p = p.slice(rootPath.length + 1);
  return p;
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

interface DiagnosticGroup {
  source: string;
  diagnostics: Diagnostic[];
}

export function formatDiagnostics(
  filePath: string,
  groups: DiagnosticGroup[]
): string {
  const allDiags = groups.flatMap((g) => g.diagnostics);

  const totalErrors = allDiags.filter(
    (d) => d.severity === DiagnosticSeverity.Error
  ).length;
  const totalWarnings = allDiags.filter(
    (d) => d.severity === DiagnosticSeverity.Warning
  ).length;
  const totalOther = allDiags.length - totalErrors - totalWarnings;

  if (allDiags.length === 0) {
    return `${filePath}: No diagnostics — all clean ✓`;
  }

  const summaryParts: string[] = [];
  if (totalErrors > 0)
    summaryParts.push(`${totalErrors} error${totalErrors !== 1 ? "s" : ""}`);
  if (totalWarnings > 0)
    summaryParts.push(
      `${totalWarnings} warning${totalWarnings !== 1 ? "s" : ""}`
    );
  if (totalOther > 0) summaryParts.push(`${totalOther} info/hint`);

  const lines = [`Diagnostics for ${filePath}: ${summaryParts.join(", ")}`];

  for (const group of groups) {
    if (group.diagnostics.length === 0) continue;
    lines.push("", `── ${group.source} ──`);
    for (let i = 0; i < group.diagnostics.length; i++) {
      const d = group.diagnostics[i];
      const sev = severityLabel(d.severity);
      const loc = fmtRange(d.range);
      const src = d.source ? `[${d.source}]` : "";
      const code = d.code ? `(${d.code})` : "";
      lines.push(`${i + 1}. ${sev} ${loc} ${src}${code}`);
      lines.push(`   ${d.message}`);
      if (d.codeDescription?.href)
        lines.push(`   Docs: ${d.codeDescription.href}`);
    }
  }

  return lines.join("\n");
}

// ── Hover ───────────────────────────────────────────────────────────────────

export function formatHover(
  hover: Hover | null,
  filePath: string,
  line: number,
  character: number
): string {
  if (!hover)
    return `No hover information at ${filePath}:${line + 1}:${character + 1}`;

  const contents = hover.contents;
  let text: string;

  if (typeof contents === "string") {
    text = contents;
  } else if (Array.isArray(contents)) {
    text = contents
      .map((c) =>
        typeof c === "string" ? c : `\`\`\`${c.language}\n${c.value}\n\`\`\``
      )
      .join("\n\n");
  } else if ("value" in contents) {
    text = contents.value;
  } else {
    text = JSON.stringify(contents);
  }

  return `Hover at ${filePath}:${line + 1}:${character + 1}:\n\n${text}`;
}

// ── Locations (definition / references / implementation) ────────────────────

export function formatLocations(
  locations: Location[],
  kind: string,
  filePath: string,
  line: number,
  character: number,
  rootPath: string
): string {
  const queryPos = `${filePath}:${line + 1}:${character + 1}`;

  if (locations.length === 0)
    return `No ${kind} found for symbol at ${queryPos}`;

  const formatted = locations.map((loc, i) => {
    const p = relativePath(loc.uri, rootPath);
    return `${i + 1}. ${p}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  });

  return `${kind} for symbol at ${queryPos} (${locations.length} result${locations.length !== 1 ? "s" : ""}):\n\n${formatted.join("\n")}`;
}

// ── Document Symbols ────────────────────────────────────────────────────────

function isDocumentSymbol(
  item: DocumentSymbol | SymbolInformation
): item is DocumentSymbol {
  return "selectionRange" in item;
}

function formatDocSymbolTree(
  symbols: DocumentSymbol[],
  indent: number
): string[] {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);
  for (const sym of symbols) {
    const kind = symbolKindLabel(sym.kind);
    const line = sym.selectionRange.start.line + 1;
    const detail = sym.detail ? ` — ${sym.detail}` : "";
    lines.push(`${prefix}${sym.name} (${kind}) line ${line}${detail}`);
    if (sym.children?.length) {
      lines.push(...formatDocSymbolTree(sym.children, indent + 1));
    }
  }
  return lines;
}

export function formatDocumentSymbols(
  symbols: (DocumentSymbol | SymbolInformation)[],
  filePath: string,
  rootPath: string
): string {
  if (symbols.length === 0) return `No symbols found in ${filePath}`;

  if (symbols.length > 0 && isDocumentSymbol(symbols[0])) {
    const tree = formatDocSymbolTree(symbols as DocumentSymbol[], 0);
    return `Symbols in ${filePath} (${symbols.length} top-level):\n\n${tree.join("\n")}`;
  }

  // Flat SymbolInformation
  const formatted = (symbols as SymbolInformation[]).map((sym, i) => {
    const kind = symbolKindLabel(sym.kind);
    const p = relativePath(sym.location.uri, rootPath);
    const line = sym.location.range.start.line + 1;
    const container = sym.containerName ? ` in ${sym.containerName}` : "";
    return `${i + 1}. ${sym.name} (${kind}) ${p}:${line}${container}`;
  });

  return `Symbols in ${filePath} (${symbols.length}):\n\n${formatted.join("\n")}`;
}

// ── Workspace Symbols ───────────────────────────────────────────────────────

export function formatWorkspaceSymbols(
  symbols: SymbolInformation[],
  query: string,
  rootPath: string
): string {
  if (symbols.length === 0) return `No workspace symbols matching "${query}"`;

  const formatted = symbols.slice(0, 50).map((sym, i) => {
    const kind = symbolKindLabel(sym.kind);
    const p = relativePath(sym.location.uri, rootPath);
    const line = sym.location.range.start.line + 1;
    const container = sym.containerName ? ` in ${sym.containerName}` : "";
    return `${i + 1}. ${sym.name} (${kind}) ${p}:${line}${container}`;
  });

  const truncated =
    symbols.length > 50 ? `\n\n(showing 50 of ${symbols.length})` : "";
  return `Workspace symbols matching "${query}" (${symbols.length}):\n\n${formatted.join("\n")}${truncated}`;
}

// ── Call Hierarchy ──────────────────────────────────────────────────────────

function formatCallItem(item: CallHierarchyItem, rootPath: string): string {
  const kind = symbolKindLabel(item.kind);
  const p = relativePath(item.uri, rootPath);
  const line = item.selectionRange.start.line + 1;
  const detail = item.detail ? ` — ${item.detail}` : "";
  return `${item.name} (${kind}) ${p}:${line}${detail}`;
}

export function formatCallHierarchy(
  items: CallHierarchyItem[],
  filePath: string,
  line: number,
  character: number,
  rootPath: string
): string {
  const queryPos = `${filePath}:${line + 1}:${character + 1}`;

  if (items.length === 0) return `No call hierarchy item at ${queryPos}`;

  const formatted = items.map(
    (item, i) => `${i + 1}. ${formatCallItem(item, rootPath)}`
  );
  return `Call hierarchy at ${queryPos}:\n\n${formatted.join("\n")}`;
}

export function formatIncomingCalls(
  calls: CallHierarchyIncomingCall[],
  target: CallHierarchyItem,
  rootPath: string
): string {
  if (calls.length === 0) return `No incoming calls to ${target.name}`;

  const formatted = calls.map(
    (call, i) => `${i + 1}. ${formatCallItem(call.from, rootPath)}`
  );
  return `Incoming calls to ${target.name} (${calls.length}):\n\n${formatted.join("\n")}`;
}

export function formatOutgoingCalls(
  calls: CallHierarchyOutgoingCall[],
  source: CallHierarchyItem,
  rootPath: string
): string {
  if (calls.length === 0) return `No outgoing calls from ${source.name}`;

  const formatted = calls.map(
    (call, i) => `${i + 1}. ${formatCallItem(call.to, rootPath)}`
  );
  return `Outgoing calls from ${source.name} (${calls.length}):\n\n${formatted.join("\n")}`;
}

// ── Code Actions ────────────────────────────────────────────────────────────

export function formatCodeActions(
  actions: CodeAction[],
  filePath: string,
  line: number
): string {
  if (actions.length === 0)
    return `No code actions available at ${filePath}:${line + 1}`;

  const formatted = actions.map((action, i) => {
    const parts = [`${i + 1}. ${action.title}`];
    if (action.kind) parts[0] += ` [${action.kind}]`;
    if (action.isPreferred) parts[0] += " ★ preferred";

    if (action.edit?.changes) {
      const files = Object.keys(action.edit.changes);
      const totalEdits = files.reduce(
        (s, f) => s + (action.edit!.changes![f]?.length ?? 0),
        0
      );
      parts.push(
        `   Changes: ${totalEdits} edit${totalEdits !== 1 ? "s" : ""} across ${files.length} file${files.length !== 1 ? "s" : ""}`
      );
    }

    return parts.join("\n");
  });

  return `Code actions at ${filePath}:${line + 1} (${actions.length} available):\n\n${formatted.join("\n\n")}`;
}
