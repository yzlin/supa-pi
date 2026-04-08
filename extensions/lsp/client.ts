/**
 * High-level LSP client.
 *
 * Manages the initialize handshake, document lifecycle, diagnostic collection,
 * and typed request helpers for all supported LSP operations.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { LspConnection } from "./protocol";
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  CodeActionContext,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  Position,
  PublishDiagnosticsParams,
  Range,
  ResolvedServerConfig,
  SymbolInformation,
} from "./types";

// ── Helpers ─────────────────────────────────────────────────────────────────

export function pathToUri(filePath: string): string {
  const abs = filePath.startsWith("/") ? filePath : resolve(filePath);
  return `file://${abs}`;
}

export function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? uri.slice(7) : uri;
}

function languageIdForFile(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".vue": "vue",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".zig": "zig",
    ".zon": "zig",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".java": "java",
    ".rb": "ruby",
    ".lua": "lua",
    ".css": "css",
    ".html": "html",
    ".json": "json",
    ".md": "markdown",
  };
  return map[ext] ?? "plaintext";
}

// ── Types ───────────────────────────────────────────────────────────────────

interface OpenDocument {
  uri: string;
  version: number;
  languageId: string;
}

interface DiagnosticWaiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Client ──────────────────────────────────────────────────────────────────

export class LspClient {
  private connection: LspConnection;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private openDocs = new Map<string, OpenDocument>();
  private diagnosticStore = new Map<string, Diagnostic[]>();
  private diagnosticWaiters = new Map<string, DiagnosticWaiter[]>();
  private serverCapabilities: Record<string, unknown> = {};
  private stderrLog: string[] = [];

  readonly config: ResolvedServerConfig;
  private rootPath: string;

  constructor(config: ResolvedServerConfig, rootPath: string) {
    this.config = config;
    this.rootPath = rootPath;
    this.connection = this.createConnection();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  private createConnection(): LspConnection {
    const conn = new LspConnection(this.config.command, this.config.args, {
      cwd: this.rootPath,
      env: this.config.env,
    });

    conn.setNotificationHandler((method, params) => {
      if (method === "textDocument/publishDiagnostics") {
        const { uri, diagnostics } = params as PublishDiagnosticsParams;
        this.diagnosticStore.set(uri, diagnostics);

        const waiters = this.diagnosticWaiters.get(uri);
        if (waiters?.length) {
          for (const w of waiters) {
            clearTimeout(w.timer);
            w.resolve();
          }
          this.diagnosticWaiters.delete(uri);
        }
      }
    });

    conn.setServerRequestHandler((id, _method, _params) => {
      conn.sendResponse(id, null);
    });

    conn.setStderrHandler((text) => {
      this.stderrLog.push(text);
      if (this.stderrLog.length > 100) this.stderrLog.shift();
    });

    conn.setExitHandler((_code) => {
      this.initialized = false;
      this.initializePromise = null;
    });

    return conn;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.doInitialize();
    return this.initializePromise;
  }

  private async doInitialize(): Promise<void> {
    if (!this.connection.alive) {
      this.connection.spawn();
    }

    const rootUri = pathToUri(this.rootPath);

    const result = (await this.connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: this.rootPath,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            codeDescriptionSupport: true,
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: false },
          references: {},
          implementation: {},
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
            },
          },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          callHierarchy: {},
          synchronization: {
            didSave: true,
            willSave: false,
            willSaveWaitUntil: false,
          },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          symbol: {},
        },
      },
      workspaceFolders: [
        { uri: rootUri, name: this.rootPath.split("/").pop() || "workspace" },
      ],
      initializationOptions: this.config.initializationOptions,
    })) as { capabilities?: Record<string, unknown> } | null;

    this.serverCapabilities = result?.capabilities ?? {};
    this.connection.sendNotification("initialized", {});
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (!this.connection.alive) return;

    try {
      if (this.initialized) {
        await this.connection.sendRequest("shutdown", null, 5_000);
        this.connection.sendNotification("exit", null);
      }
    } catch {
      // Best-effort
    }

    this.connection.dispose();
    this.initialized = false;
    this.initializePromise = null;
    this.openDocs.clear();
    this.diagnosticStore.clear();
    this.clearAllWaiters();
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get capabilities(): Record<string, unknown> {
    return this.serverCapabilities;
  }

  /** Check if the server advertised a specific capability. */
  hasCapability(name: string): boolean {
    return (
      this.serverCapabilities[name] !== undefined &&
      this.serverCapabilities[name] !== false
    );
  }

  // ── Document management ───────────────────────────────────────────────

  async openDocument(filePath: string): Promise<string> {
    await this.ensureInitialized();

    const uri = pathToUri(resolve(this.rootPath, filePath));
    const existing = this.openDocs.get(uri);

    const absolutePath = resolve(this.rootPath, filePath);
    const text = await readFile(absolutePath, "utf8");
    const languageId = languageIdForFile(filePath);

    if (existing) {
      existing.version++;
      this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }],
      });
    } else {
      const version = 1;
      this.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text },
      });
      this.openDocs.set(uri, { uri, version, languageId });
    }

    return uri;
  }

  async closeDocument(filePath: string): Promise<void> {
    const uri = pathToUri(resolve(this.rootPath, filePath));
    const doc = this.openDocs.get(uri);
    if (!doc) return;

    this.connection.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
    this.openDocs.delete(uri);
    this.diagnosticStore.delete(uri);
  }

  // ── Diagnostics ───────────────────────────────────────────────────────

  async getDiagnostics(
    filePath: string,
    timeoutMs = 10_000
  ): Promise<Diagnostic[]> {
    const uri = await this.openDocument(filePath);
    await this.waitForDiagnostics(uri, timeoutMs);
    return this.diagnosticStore.get(uri) ?? [];
  }

  private waitForDiagnostics(uri: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolveWait) => {
      const existing = this.diagnosticStore.get(uri);
      if (existing !== undefined) {
        setTimeout(resolveWait, 500);
        return;
      }

      const timer = setTimeout(() => {
        const waiters = this.diagnosticWaiters.get(uri);
        if (waiters) {
          const idx = waiters.findIndex((w) => w.resolve === resolveWait);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) this.diagnosticWaiters.delete(uri);
        }
        resolveWait();
      }, timeoutMs);

      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push({ resolve: resolveWait, timer });
      this.diagnosticWaiters.set(uri, waiters);
    });
  }

  private clearAllWaiters(): void {
    for (const [, waiters] of this.diagnosticWaiters) {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve();
      }
    }
    this.diagnosticWaiters.clear();
  }

  // ── Hover ─────────────────────────────────────────────────────────────

  async hover(filePath: string, position: Position): Promise<Hover | null> {
    const uri = await this.openDocument(filePath);
    const result = await this.connection.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position,
    });
    return (result as Hover) ?? null;
  }

  // ── Definition ────────────────────────────────────────────────────────

  async definition(filePath: string, position: Position): Promise<Location[]> {
    const uri = await this.openDocument(filePath);
    const result = await this.connection.sendRequest(
      "textDocument/definition",
      {
        textDocument: { uri },
        position,
      }
    );
    return normalizeLocations(result);
  }

  // ── References ────────────────────────────────────────────────────────

  async references(filePath: string, position: Position): Promise<Location[]> {
    const uri = await this.openDocument(filePath);
    const result = await this.connection.sendRequest(
      "textDocument/references",
      {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      }
    );
    return normalizeLocations(result);
  }

  // ── Implementation ────────────────────────────────────────────────────

  async implementation(
    filePath: string,
    position: Position
  ): Promise<Location[]> {
    const uri = await this.openDocument(filePath);
    const result = await this.connection.sendRequest(
      "textDocument/implementation",
      {
        textDocument: { uri },
        position,
      }
    );
    return normalizeLocations(result);
  }

  // ── Document Symbols ──────────────────────────────────────────────────

  async documentSymbol(
    filePath: string
  ): Promise<DocumentSymbol[] | SymbolInformation[]> {
    const uri = await this.openDocument(filePath);
    const result = await this.connection.sendRequest(
      "textDocument/documentSymbol",
      {
        textDocument: { uri },
      }
    );
    if (!Array.isArray(result)) return [];
    return result as DocumentSymbol[] | SymbolInformation[];
  }

  // ── Workspace Symbols ─────────────────────────────────────────────────

  async workspaceSymbol(query: string): Promise<SymbolInformation[]> {
    await this.ensureInitialized();
    const result = await this.connection.sendRequest("workspace/symbol", {
      query,
    });
    if (!Array.isArray(result)) return [];
    return result as SymbolInformation[];
  }

  // ── Call Hierarchy ────────────────────────────────────────────────────

  async prepareCallHierarchy(
    filePath: string,
    position: Position
  ): Promise<CallHierarchyItem[]> {
    const uri = await this.openDocument(filePath);
    const result = await this.connection.sendRequest(
      "textDocument/prepareCallHierarchy",
      {
        textDocument: { uri },
        position,
      }
    );
    if (!Array.isArray(result)) return [];
    return result as CallHierarchyItem[];
  }

  async incomingCalls(
    item: CallHierarchyItem
  ): Promise<CallHierarchyIncomingCall[]> {
    const result = await this.connection.sendRequest(
      "callHierarchy/incomingCalls",
      { item }
    );
    if (!Array.isArray(result)) return [];
    return result as CallHierarchyIncomingCall[];
  }

  async outgoingCalls(
    item: CallHierarchyItem
  ): Promise<CallHierarchyOutgoingCall[]> {
    const result = await this.connection.sendRequest(
      "callHierarchy/outgoingCalls",
      { item }
    );
    if (!Array.isArray(result)) return [];
    return result as CallHierarchyOutgoingCall[];
  }

  // ── Code Actions ──────────────────────────────────────────────────────

  async codeActions(
    filePath: string,
    range: Range,
    context: CodeActionContext
  ): Promise<CodeAction[]> {
    const uri = await this.openDocument(filePath);
    const result = await this.connection.sendRequest(
      "textDocument/codeAction",
      {
        textDocument: { uri },
        range,
        context,
      }
    );
    if (!Array.isArray(result)) return [];
    return result as CodeAction[];
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function normalizeLocations(result: unknown): Location[] {
  if (!result) return [];
  if (Array.isArray(result)) return result as Location[];
  if (
    typeof result === "object" &&
    "uri" in (result as Record<string, unknown>)
  ) {
    return [result as Location];
  }
  return [];
}
