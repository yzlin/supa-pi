// ── LSP protocol types (minimal subset) ─────────────────────────────────────

/** 0-indexed line/character position. */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export const enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface DiagnosticRelatedInformation {
  location: Location;
  message: string;
}

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: number | string;
  codeDescription?: { href: string };
  source?: string;
  message: string;
  relatedInformation?: DiagnosticRelatedInformation[];
}

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export interface Hover {
  contents:
    | MarkupContent
    | string
    | Array<string | { language: string; value: string }>;
  range?: Range;
}

export interface CodeActionContext {
  diagnostics: Diagnostic[];
  only?: string[];
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  edit?: WorkspaceEdit;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
}

export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
  version?: number;
}

// ── Symbol types ────────────────────────────────────────────────────────────

export const enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: SymbolKind;
  location: Location;
  containerName?: string;
}

// ── Call hierarchy types ────────────────────────────────────────────────────

export interface CallHierarchyItem {
  name: string;
  kind: SymbolKind;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

// ── JSON-RPC types ──────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

// ── Server configuration ────────────────────────────────────────────────────

/** Config for a single LSP server as written in config files. */
export interface LspServerUserConfig {
  /** Command + args to spawn the server. e.g. ["typescript-language-server", "--stdio"] */
  command?: string[];
  /** File extensions this server handles (with leading dot). */
  extensions?: string[];
  /** Disable this server. */
  disabled?: boolean;
  /** Environment variables for the server process. */
  env?: Record<string, string>;
  /** Initialization options sent during LSP initialize. */
  initialization?: Record<string, unknown>;
}

/** Top-level config file shape. */
export interface LspConfigFile {
  /** Set to false to disable all LSP servers. */
  lsp?: false | Record<string, LspServerUserConfig>;
}

/** Normalized server config from config files before command resolution. */
export interface ConfiguredServerConfig {
  /** Server name (key from config). */
  name: string;
  /** Command + args from config. */
  command: string[];
  /** File extensions this server handles (with leading dot). */
  extensions: string[];
  /** Environment variables for the server process. */
  env: Record<string, string>;
  /** Initialization options. */
  initializationOptions: Record<string, unknown>;
}

/** Resolved server config ready to use. */
export interface ResolvedServerConfig {
  /** Server name (key from config). */
  name: string;
  /** Command to spawn. */
  command: string;
  /** Command arguments. */
  args: string[];
  /** File extensions this server handles (with leading dot). */
  extensions: string[];
  /** Environment variables for the server process. */
  env: Record<string, string>;
  /** Initialization options. */
  initializationOptions: Record<string, unknown>;
}

// ── Operations ──────────────────────────────────────────────────────────────

export const LSP_OPERATIONS = [
  "diagnostics",
  "hover",
  "goToDefinition",
  "findReferences",
  "goToImplementation",
  "documentSymbol",
  "workspaceSymbol",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "codeActions",
] as const;

export type LspOperation = (typeof LSP_OPERATIONS)[number];

/** Operations that require filePath + line + character. */
export const POSITION_OPERATIONS: LspOperation[] = [
  "hover",
  "goToDefinition",
  "findReferences",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "codeActions",
];

/** Operations that require filePath only. */
export const FILE_ONLY_OPERATIONS: LspOperation[] = [
  "diagnostics",
  "documentSymbol",
];

/** Operations that require query only. */
export const QUERY_OPERATIONS: LspOperation[] = ["workspaceSymbol"];
