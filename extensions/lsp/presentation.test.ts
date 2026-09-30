import { afterEach, describe, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import {
  initTheme,
  theme,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import lspExtension from "./index";
import {
  cleanupLspPresentation,
  cleanupLspPresentationTimers,
  type DiagnosticCounts,
  type LspPresentationState,
  renderLspToolCall,
  renderLspToolResult,
} from "./presentation";
import { registerLspTool, type ServerManager } from "./tools";
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  SymbolInformation,
} from "./types";

const FILE_ARGS = {
  filePath: "src/example.ts",
  line: 3,
  character: 5,
};
const FILE_ONLY_ARGS = { filePath: "src/example.ts" };
const QUERY_ARGS = { query: "Thing" };

const plainTheme = {
  bg: (_token: string, text: string) => text.trimEnd(),
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
};

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  details: unknown;
  isError: boolean;
}

interface HookResult {
  details?: unknown;
}

type HookHandler = (
  event: unknown,
  context: unknown,
) => HookResult | undefined | Promise<HookResult | undefined>;

interface MockClient {
  config: { name: string };
  getDiagnostics: (filePath: string) => Promise<Diagnostic[]>;
  hover: (
    filePath: string,
    position: { line: number; character: number },
  ) => Promise<Hover | null>;
  definition: (
    filePath: string,
    position: { line: number; character: number },
  ) => Promise<Location[]>;
  references: (
    filePath: string,
    position: { line: number; character: number },
  ) => Promise<Location[]>;
  implementation: (
    filePath: string,
    position: { line: number; character: number },
  ) => Promise<Location[]>;
  documentSymbol: (
    filePath: string,
  ) => Promise<DocumentSymbol[] | SymbolInformation[]>;
  workspaceSymbol: (query: string) => Promise<SymbolInformation[]>;
  prepareCallHierarchy: (
    filePath: string,
    position: { line: number; character: number },
  ) => Promise<CallHierarchyItem[]>;
  incomingCalls: (
    item: CallHierarchyItem,
  ) => Promise<CallHierarchyIncomingCall[]>;
  outgoingCalls: (
    item: CallHierarchyItem,
  ) => Promise<CallHierarchyOutgoingCall[]>;
  codeActions: (
    filePath: string,
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    },
    context: { diagnostics: Diagnostic[] },
  ) => Promise<CodeAction[]>;
}

type ClientOverrides = Partial<{
  [K in keyof MockClient]: MockClient[K];
}>;

const RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 4 },
};
const LOCATION: Location = {
  uri: "file:///workspace/src/other.ts",
  range: RANGE,
};
const DIAGNOSTIC_ERROR: Diagnostic = {
  range: RANGE,
  severity: 1,
  source: "typescript",
  message: "Broken type",
};
const DIAGNOSTIC_WARNING: Diagnostic = {
  range: RANGE,
  severity: 2,
  source: "eslint",
  message: "Use a safer pattern",
};
const DIAGNOSTIC_INFORMATION: Diagnostic = {
  range: RANGE,
  severity: 3,
  source: "typescript",
  message: "Informational note",
};
const DIAGNOSTIC_HINT: Diagnostic = {
  range: RANGE,
  severity: 4,
  source: "typescript",
  message: "Consider a narrower type",
};
const DIAGNOSTIC_OTHER: Diagnostic = {
  range: RANGE,
  source: "custom",
  message: "Unknown severity",
};
const SYMBOL_CHILD: DocumentSymbol = {
  name: "child",
  kind: 12,
  range: RANGE,
  selectionRange: RANGE,
};
const SYMBOL_PARENT: DocumentSymbol = {
  name: "parent",
  kind: 5,
  range: RANGE,
  selectionRange: RANGE,
  children: [SYMBOL_CHILD],
};
const CALL_ITEM: CallHierarchyItem = {
  name: "run",
  kind: 12,
  uri: "file:///workspace/src/example.ts",
  range: RANGE,
  selectionRange: RANGE,
};

function method<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

function createClient(overrides: ClientOverrides = {}): MockClient {
  const client: MockClient = {
    config: { name: "typescript" },
    getDiagnostics: method([]),
    hover: method(null),
    definition: method([]),
    references: method([]),
    implementation: method([]),
    documentSymbol: method([]),
    workspaceSymbol: method([]),
    prepareCallHierarchy: method([]),
    incomingCalls: method([]),
    outgoingCalls: method([]),
    codeActions: method([]),
  };
  return { ...client, ...overrides };
}

function captureTool(clients: MockClient[]): RegisteredTool {
  const tools: RegisteredTool[] = [];
  const manager: ServerManager = {
    clientsForFile: () => clients,
    clientForFileWithCapability: () => clients[0] as never,
    anyClient: () => clients[0] as never,
    getRootPath: () => "/workspace",
  };
  registerLspTool(
    {
      registerTool(registeredTool: RegisteredTool) {
        tools.push(registeredTool);
      },
    },
    manager,
  );
  const tool = tools[0];
  if (!tool) {
    throw new Error("LSP tool was not registered");
  }
  return tool;
}

function captureExtensionHooks(): Map<string, HookHandler> {
  const handlers = new Map<string, HookHandler>();
  const pi = {
    registerTool() {
      return;
    },
    registerCommand() {
      return;
    },
    on(event: string, handler: HookHandler) {
      handlers.set(event, handler);
    },
  };
  lspExtension(pi as never);
  return handlers;
}

function executeTool(
  tool: RegisteredTool,
  id: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  return Reflect.apply(tool.execute, tool, [
    id,
    params,
    undefined,
    undefined,
    { cwd: "/workspace" },
  ]) as Promise<ToolResult>;
}

function renderResult(
  tool: RegisteredTool,
  result: ToolResult,
  args: Record<string, unknown>,
  options: { expanded: boolean; isPartial?: boolean } = { expanded: false },
  state: LspPresentationState = {},
  toolCallId = "render-call",
): string[] {
  const component = tool.renderResult?.(
    result as never,
    { expanded: options.expanded, isPartial: options.isPartial ?? false },
    plainTheme as never,
    {
      args,
      toolCallId,
      state,
      invalidate() {
        return;
      },
      isError: result.isError === true,
    } as never,
  );
  return component?.render(120) ?? [];
}

function operationArgs(operation: string): Record<string, unknown> {
  if (operation === "workspaceSymbol") {
    return { operation, ...QUERY_ARGS };
  }
  if (operation === "diagnostics" || operation === "documentSymbol") {
    return { operation, ...FILE_ONLY_ARGS };
  }
  return { operation, ...FILE_ARGS };
}

function errorMethod<T>(message: string): () => Promise<T> {
  return () => Promise.reject(new Error(message));
}

afterEach(() => {
  cleanupLspPresentationTimers();
  cleanupLspPresentation();
});

describe("LSP tool registration and presentation", () => {
  test("registers render hooks without changing the public schema", async () => {
    const tool = captureTool([
      createClient({
        hover: method({ contents: "const value: string" }),
      }),
    ]);

    if (!Type.IsObject(tool.parameters)) {
      throw new Error("Expected object parameters schema");
    }
    expect(Object.keys(tool.parameters.properties)).toEqual([
      "operation",
      "filePath",
      "line",
      "character",
      "query",
    ]);
    expect(Object.keys(tool.parameters.properties)).not.toContain("reasoning");
    expect(tool.renderShell).toBe("self");
    expect(tool.renderCall).toBeFunction();
    expect(tool.renderResult).toBeFunction();

    const result = await executeTool(tool, "schema-call", {
      operation: "hover",
      ...FILE_ARGS,
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Hover at src/example.ts:3:5:\n\nconst value: string",
      },
    ]);
  });

  test("renders every operation from structured results, including empty outcomes", async () => {
    const populated = createClient({
      getDiagnostics: method([DIAGNOSTIC_ERROR, DIAGNOSTIC_WARNING]),
      hover: method({ contents: "const value: string" }),
      definition: method([LOCATION]),
      references: method([LOCATION, LOCATION]),
      implementation: method([LOCATION]),
      documentSymbol: method([SYMBOL_PARENT]),
      workspaceSymbol: method([
        {
          name: "Thing",
          kind: 5,
          location: LOCATION,
        },
      ]),
      prepareCallHierarchy: method([CALL_ITEM]),
      incomingCalls: method([{ from: CALL_ITEM, fromRanges: [RANGE] }]),
      outgoingCalls: method([{ to: CALL_ITEM, fromRanges: [RANGE] }]),
      codeActions: method([{ title: "Fix it" }]),
    });
    const populatedTool = captureTool([populated]);

    const populatedExpectations: Array<{
      operation: string;
      contains: string;
      summary: string;
    }> = [
      { operation: "diagnostics", contains: "1 error", summary: "1 error" },
      { operation: "hover", contains: "const value: string", summary: "found" },
      {
        operation: "goToDefinition",
        contains: "1 result",
        summary: "1 definition found",
      },
      {
        operation: "findReferences",
        contains: "2 results",
        summary: "2 references found",
      },
      {
        operation: "goToImplementation",
        contains: "1 result",
        summary: "1 implementation found",
      },
      {
        operation: "documentSymbol",
        contains: "parent",
        summary: "2 symbols found",
      },
      {
        operation: "workspaceSymbol",
        contains: "Thing",
        summary: "1 symbol found",
      },
      {
        operation: "prepareCallHierarchy",
        contains: "run",
        summary: "1 call hierarchy item found",
      },
      {
        operation: "incomingCalls",
        contains: "run",
        summary: "1 incoming call found",
      },
      {
        operation: "outgoingCalls",
        contains: "run",
        summary: "1 outgoing call found",
      },
      {
        operation: "codeActions",
        contains: "Fix it",
        summary: "1 code action found",
      },
    ];

    for (const expectation of populatedExpectations) {
      const args = operationArgs(expectation.operation);
      const toolCallId = `populated-${expectation.operation}`;
      const result = await executeTool(populatedTool, toolCallId, args);
      expect(result.content[0]?.text).toContain(expectation.contains);
      expect(
        renderResult(
          populatedTool,
          result,
          args,
          { expanded: false },
          {},
          toolCallId,
        ).join("\n"),
      ).toContain(expectation.summary);
    }

    const empty = createClient();
    const emptyTool = captureTool([empty]);
    const emptyExpectations: Array<{ operation: string; contains: string }> = [
      { operation: "diagnostics", contains: "No diagnostics" },
      { operation: "hover", contains: "No hover information" },
      { operation: "goToDefinition", contains: "No Definition found" },
      { operation: "findReferences", contains: "No References found" },
      { operation: "goToImplementation", contains: "No Implementation found" },
      { operation: "documentSymbol", contains: "No symbols found" },
      { operation: "workspaceSymbol", contains: "No workspace symbols" },
      { operation: "prepareCallHierarchy", contains: "No call hierarchy item" },
      { operation: "incomingCalls", contains: "No call hierarchy item" },
      { operation: "outgoingCalls", contains: "No call hierarchy item" },
      { operation: "codeActions", contains: "No code actions" },
    ];

    for (const expectation of emptyExpectations) {
      const toolCallId = `empty-${expectation.operation}`;
      const result = await executeTool(
        emptyTool,
        toolCallId,
        operationArgs(expectation.operation),
      );
      expect(result.content[0]?.text).toContain(expectation.contains);
      const lines = renderResult(
        emptyTool,
        result,
        operationArgs(expectation.operation),
        { expanded: false },
        {},
        toolCallId,
      );
      expect(lines.join("\n")).toContain("no");
    }
  });

  test("counts nested document symbols and keeps workspace counts above formatter caps", async () => {
    const symbols = Array.from({ length: 55 }, (_, index) => ({
      name: `Thing${index}`,
      kind: 12 as const,
      location: LOCATION,
    }));
    const tool = captureTool([
      createClient({
        documentSymbol: method([SYMBOL_PARENT]),
        workspaceSymbol: method(symbols),
      }),
    ]);

    const documentResult = await executeTool(tool, "nested-symbols", {
      operation: "documentSymbol",
      ...FILE_ONLY_ARGS,
    });
    expect(
      renderResult(
        tool,
        documentResult,
        { operation: "documentSymbol", ...FILE_ONLY_ARGS },
        { expanded: false },
        {},
        "nested-symbols",
      ).join("\n"),
    ).toContain("2 symbols found");

    const workspaceResult = await executeTool(tool, "workspace-symbols", {
      operation: "workspaceSymbol",
      ...QUERY_ARGS,
    });
    expect(
      renderResult(
        tool,
        workspaceResult,
        {
          operation: "workspaceSymbol",
          ...QUERY_ARGS,
        },
        { expanded: false },
        {},
        "workspace-symbols",
      ).join("\n"),
    ).toContain("55 symbols found");
  });

  test("keeps every operation an execution error while rendering an error outcome", async () => {
    const operations = [
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
    ];

    for (const operation of operations) {
      const error = new Error(`${operation} failed`);
      const overrides: ClientOverrides = {};
      if (operation === "diagnostics") {
        overrides.getDiagnostics = errorMethod(error.message);
      } else if (operation === "workspaceSymbol") {
        overrides.workspaceSymbol = errorMethod(error.message);
      } else if (operation === "hover") {
        overrides.hover = errorMethod(error.message);
      } else if (operation === "goToDefinition") {
        overrides.definition = errorMethod(error.message);
      } else if (operation === "findReferences") {
        overrides.references = errorMethod(error.message);
      } else if (operation === "goToImplementation") {
        overrides.implementation = errorMethod(error.message);
      } else if (operation === "documentSymbol") {
        overrides.documentSymbol = errorMethod(error.message);
      } else if (operation === "prepareCallHierarchy") {
        overrides.prepareCallHierarchy = errorMethod(error.message);
      } else if (operation === "incomingCalls") {
        overrides.prepareCallHierarchy = method([CALL_ITEM]);
        overrides.incomingCalls = errorMethod(error.message);
      } else if (operation === "outgoingCalls") {
        overrides.prepareCallHierarchy = method([CALL_ITEM]);
        overrides.outgoingCalls = errorMethod(error.message);
      } else {
        overrides.codeActions = errorMethod(error.message);
      }

      const tool = captureTool([createClient(overrides)]);
      const toolCallId = `error-${operation}`;
      await expect(
        executeTool(tool, toolCallId, operationArgs(operation)),
      ).rejects.toThrow(error.message);
      const lines = renderResult(
        tool,
        { content: [{ type: "text", text: error.message }], isError: true },
        operationArgs(operation),
        { expanded: false },
        {},
        toolCallId,
      );
      expect(lines.join("\n")).toContain("error");
    }
  });

  test("distinguishes diagnostic findings from unavailable and incomplete failures", async () => {
    const successful = createClient({
      getDiagnostics: method([DIAGNOSTIC_ERROR, DIAGNOSTIC_WARNING]),
    });
    const successTool = captureTool([successful]);
    const successResult = await executeTool(
      successTool,
      "diagnostics-success",
      {
        operation: "diagnostics",
        ...FILE_ONLY_ARGS,
      },
    );
    expect(
      renderResult(
        successTool,
        successResult,
        {
          operation: "diagnostics",
          ...FILE_ONLY_ARGS,
        },
        { expanded: false },
        {},
        "diagnostics-success",
      ).join("\n"),
    ).toContain("1 error · 1 warning");

    const unavailableTool = captureTool([]);
    await expect(
      executeTool(unavailableTool, "diagnostics-unavailable", {
        operation: "diagnostics",
        ...FILE_ONLY_ARGS,
      }),
    ).rejects.toThrow("unavailable");
    const unavailable = renderResult(
      unavailableTool,
      {
        content: [{ type: "text", text: "LSP diagnostics unavailable" }],
        isError: true,
      },
      { operation: "diagnostics", ...FILE_ONLY_ARGS },
      { expanded: false },
      {},
      "diagnostics-unavailable",
    ).join("\n");
    expect(unavailable).toContain("unavailable");
    expect(unavailable).not.toContain("0 diagnostics");

    const incompleteTool = captureTool([
      successful,
      createClient({
        config: { name: "eslint" },
        getDiagnostics: errorMethod("connection closed"),
      }),
    ]);
    let incompleteMessage = "";
    try {
      await executeTool(incompleteTool, "diagnostics-incomplete", {
        operation: "diagnostics",
        ...FILE_ONLY_ARGS,
      });
    } catch (error) {
      incompleteMessage =
        error instanceof Error ? error.message : String(error);
    }
    expect(incompleteMessage).toContain("Broken type");
    expect(incompleteMessage).toContain("connection closed");
    const incomplete = renderResult(
      incompleteTool,
      { content: [{ type: "text", text: incompleteMessage }], isError: true },
      { operation: "diagnostics", ...FILE_ONLY_ARGS },
      { expanded: true },
      {},
      "diagnostics-incomplete",
    );
    expect(incomplete[0]).toContain("1 error · 1 warning · incomplete");
    expect(incomplete.join("\n")).toContain("Broken type");
    expect(incomplete.join("\n")).toContain("connection closed");
  });

  test("uses an LSP header, two-row shells, theme backgrounds, and elapsed time", async () => {
    initTheme("dark", false);
    const tool = captureTool([
      createClient({
        hover: method({ contents: "type information" }),
      }),
    ]);
    const args = { operation: "hover", ...FILE_ARGS };
    const state: LspPresentationState = {};
    const context = {
      args,
      state,
      invalidate() {
        return;
      },
    };
    const call = tool.renderCall?.(args as never, theme, context as never);
    expect(call?.render(64)).toHaveLength(2);
    expect(
      stripVTControlCharacters(call?.render(64).join("\n") ?? ""),
    ).toContain("🔎 LSP hover");
    expect(call?.render(64).join("\n")).toContain("src/example.ts:3:5");
    expect(
      call
        ?.render(64)
        .every((line) => line.includes(theme.getBgAnsi("toolPendingBg"))),
    ).toBe(true);

    const result = await executeTool(tool, "elapsed-call", args);
    const renderedResult = tool.renderResult?.(
      result as never,
      { expanded: false, isPartial: false },
      theme,
      { ...context, toolCallId: "elapsed-call", isError: false } as never,
    );
    const settled = renderedResult?.render(64) ?? [];
    expect(settled).toHaveLength(1);
    expect(settled[0]).toContain("found");
    expect(settled[0]).toContain("<1s");
    expect(settled[0]).toContain(theme.getBgAnsi("toolSuccessBg"));

    const errorResult = tool.renderResult?.(
      { content: [{ type: "text", text: "failed" }], isError: true } as never,
      { expanded: false, isPartial: false },
      theme,
      { ...context, toolCallId: "error-render", isError: true } as never,
    );
    expect(errorResult?.render(64)[0]).toContain(
      theme.getBgAnsi("toolErrorBg"),
    );
  });

  test("sanitizes collapsed targets and preserves their tail at narrow widths", () => {
    const args = {
      operation: "workspaceSymbol",
      query: "\u001b[31mfirst\n\tsecond\u0007 tail-token\u001b[0m",
    };
    const state: LspPresentationState = {};
    const component = renderLspToolCall(args, plainTheme, {
      state,
      invalidate() {
        return;
      },
    });
    const rows = component.render(28);
    expect(rows).toHaveLength(2);
    expect(rows.every((line) => visibleWidth(line) <= 28)).toBe(true);
    expect(rows.every((line) => !line.includes("\u001b"))).toBe(true);
    expect(rows.every((line) => !line.includes("\n"))).toBe(true);
    expect(rows.every((line) => !line.includes("\r"))).toBe(true);
    expect(rows.every((line) => !line.includes("\t"))).toBe(true);
    expect(stripVTControlCharacters(rows.join("\n"))).toContain("tail-token");
  });

  test("Ctrl+O expansion keeps all existing result lines and empty lines", () => {
    const tool = captureTool([createClient()]);
    const args = { operation: "hover", ...FILE_ARGS };
    const existingText = [
      "first line",
      "",
      ...Array.from({ length: 2100 }, (_, index) => `existing-${index}`),
      "last line",
    ].join("\n");
    const result = {
      content: [{ type: "text", text: existingText }],
      details: {
        lspPresentation: {
          operation: "hover",
          result: { kind: "information", found: true },
        },
      },
      isError: false,
    };

    const component = new ToolExecutionComponent(
      "lsp",
      "expand-call",
      args,
      {},
      tool,
      {
        requestRender() {
          /* noop */
        },
      } as never,
      "/workspace",
    );
    component.setArgsComplete();
    component.updateResult(result, false);
    component.setExpanded(true);

    const rows = component.render(120).slice(1);
    const rendered = rows.join("\n");
    expect(rendered).toContain("first line");
    expect(stripVTControlCharacters(rows[3] ?? "").trim()).toBe("");
    expect(rendered).toContain("existing-2099");
    expect(rendered).toContain("last line");
    expect(rows.length).toBeGreaterThan(2100);
  });

  test("wraps wide expanded output without dropping text or blank lines", () => {
    const tool = captureTool([createClient()]);
    const args = { operation: "hover", ...FILE_ARGS };
    const wideLine = `wide-start-${"0123456789".repeat(12)}-wide-end`;
    const result = {
      content: [
        {
          type: "text",
          text: ["before", "", wideLine, "", "after"].join("\n"),
        },
      ],
      details: {
        lspPresentation: {
          operation: "hover",
          result: { kind: "information", found: true },
        },
      },
      isError: false,
    };

    const component = new ToolExecutionComponent(
      "lsp",
      "wide-call",
      args,
      {},
      tool,
      {
        requestRender() {
          /* noop */
        },
      } as never,
      "/workspace",
    );
    component.setArgsComplete();
    component.updateResult(result, false);
    component.setExpanded(true);

    const rows = component.render(32).slice(1);
    const plainRows = rows.map((row) => stripVTControlCharacters(row));
    const rendered = plainRows.join("\n");
    expect(rows.every((row) => visibleWidth(row) <= 32)).toBe(true);
    expect(rendered).toContain("wide-start-");
    expect(rendered).toContain("wide-end");
    expect(rendered).toContain("after");
    expect(plainRows.filter((row) => row.trim() === "")).toHaveLength(2);
  });

  test("preserves every diagnostic severity count in renderer metadata", async () => {
    const toolCallId = "all-diagnostic-severities";
    const tool = captureTool([
      createClient({
        getDiagnostics: method([
          DIAGNOSTIC_ERROR,
          DIAGNOSTIC_WARNING,
          DIAGNOSTIC_INFORMATION,
          DIAGNOSTIC_HINT,
          DIAGNOSTIC_OTHER,
        ]),
      }),
    ]);
    const args = { operation: "diagnostics", ...FILE_ONLY_ARGS };
    const result = await executeTool(tool, toolCallId, args);
    const hooks = captureExtensionHooks();
    const toolResultHook = hooks.get("tool_result");
    if (!toolResultHook) {
      throw new Error("LSP tool_result hook was not registered");
    }

    const hookResult = await toolResultHook(
      {
        toolName: "lsp",
        toolCallId,
        input: args,
        content: result.content,
        details: result.details,
        isError: false,
      } satisfies ToolResultEvent,
      {},
    );
    const details = (hookResult as HookResult | undefined)?.details;
    const counts = (
      details as {
        lspPresentation?: { result?: { counts?: DiagnosticCounts } };
      }
    ).lspPresentation?.result?.counts;
    expect(counts).toEqual({
      errors: 1,
      warnings: 1,
      information: 1,
      hints: 1,
      other: 1,
      total: 5,
    });
    expect(
      renderLspToolResult(
        { content: result.content, details, isError: false },
        { expanded: false, isPartial: false },
        plainTheme,
        { args, toolCallId, state: {}, isError: false },
      )
        .render(100)
        .join("\n"),
    ).toContain("1 error · 1 warning · 1 info · 1 hint · 1 other");
  });

  test("persists structured diagnostic failures through tool_result and replay", async () => {
    const hooks = captureExtensionHooks();
    const toolResultHook = hooks.get("tool_result");
    if (!toolResultHook) {
      throw new Error("LSP tool_result hook was not registered");
    }

    const scenarios = [
      {
        id: "persist-unavailable",
        tool: captureTool([]),
        args: { operation: "diagnostics", ...FILE_ONLY_ARGS },
        expectedStatus: "unavailable",
      },
      {
        id: "persist-incomplete",
        tool: captureTool([
          createClient({
            getDiagnostics: method([DIAGNOSTIC_ERROR, DIAGNOSTIC_WARNING]),
          }),
          createClient({
            config: { name: "eslint" },
            getDiagnostics: errorMethod("connection closed"),
          }),
        ]),
        args: { operation: "diagnostics", ...FILE_ONLY_ARGS },
        expectedStatus: "incomplete",
      },
    ] as const;

    for (const scenario of scenarios) {
      let thrown: unknown;
      try {
        await executeTool(scenario.tool, scenario.id, scenario.args);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("Error");

      const message = (thrown as Error).message;
      const hookResult = await toolResultHook(
        {
          toolName: "lsp",
          toolCallId: scenario.id,
          input: scenario.args,
          content: [{ type: "text", text: message }],
          details: {},
          isError: true,
        } satisfies ToolResultEvent,
        {},
      );
      const persistedDetails = (hookResult as HookResult | undefined)?.details;
      expect(persistedDetails).toBeDefined();
      expect(JSON.parse(JSON.stringify(persistedDetails))).toEqual(
        persistedDetails,
      );

      const metadata = (
        persistedDetails as {
          lspPresentation?: {
            operation?: string;
            result?: {
              kind?: string;
              status?: string;
              counts?: DiagnosticCounts;
            };
          };
        }
      ).lspPresentation;
      expect(metadata?.operation).toBe("diagnostics");
      expect(metadata?.result?.kind).toBe("diagnostics");
      expect(metadata?.result?.status).toBe(scenario.expectedStatus);

      cleanupLspPresentation();
      const replay = renderLspToolResult(
        {
          content: [{ type: "text", text: message }],
          details: persistedDetails,
          isError: true,
        },
        { expanded: true, isPartial: false },
        plainTheme,
        {
          args: scenario.args,
          toolCallId: `replayed-${scenario.id}`,
          state: {},
          isError: true,
        },
      );
      const replayed = replay.render(100).join("\n");
      expect(replayed).toContain(
        scenario.expectedStatus === "unavailable"
          ? "diagnostics unavailable"
          : "1 error · 1 warning · incomplete",
      );
      expect(replayed).toContain(message);
    }
  });

  test("cleans presentation timers through the session_shutdown lifecycle hook", async () => {
    const hooks = captureExtensionHooks();
    const shutdown = hooks.get("session_shutdown");
    if (!shutdown) {
      throw new Error("LSP session_shutdown hook was not registered");
    }

    const state: LspPresentationState = {};
    renderLspToolCall({ operation: "hover", ...FILE_ARGS }, plainTheme, {
      state,
      invalidate() {
        return;
      },
    });
    expect(state.lspPresentation?.timer).toBeDefined();

    await shutdown({}, {});
    expect(state.lspPresentation?.timer).toBeUndefined();
  });

  test("cleans pending timers and keeps independent or replayed rows safe", async () => {
    let firstInvalidations = 0;
    let secondInvalidations = 0;
    const firstState: LspPresentationState = {};
    const secondState: LspPresentationState = {};
    renderLspToolCall(
      { operation: "hover", ...FILE_ARGS, filePath: "first.ts" },
      plainTheme,
      {
        state: firstState,
        invalidate() {
          firstInvalidations += 1;
        },
      },
    );
    renderLspToolCall(
      { operation: "hover", ...FILE_ARGS, filePath: "second.ts" },
      plainTheme,
      {
        state: secondState,
        invalidate() {
          secondInvalidations += 1;
        },
      },
    );

    await sleep(1050);
    expect(firstInvalidations).toBeGreaterThanOrEqual(1);
    expect(firstInvalidations).toBeLessThanOrEqual(2);
    expect(secondInvalidations).toBeGreaterThanOrEqual(1);
    expect(secondInvalidations).toBeLessThanOrEqual(2);

    cleanupLspPresentationTimers();
    expect(firstState.lspPresentation?.timer).toBeUndefined();
    expect(secondState.lspPresentation?.timer).toBeUndefined();

    const replayed = renderLspToolResult(
      {
        content: [{ type: "text", text: "replayed\nresult" }],
        details: {
          lspPresentation: {
            operation: "hover",
            result: { kind: "information", found: true },
            durationMs: 1200,
          },
        },
      },
      { expanded: true, isPartial: false },
      plainTheme,
      {
        args: { operation: "hover", ...FILE_ARGS },
        toolCallId: "replayed-call",
        state: {},
        invalidate() {
          return;
        },
        isError: false,
      } as never,
    );
    expect(replayed.render(80).join("\n")).toContain("replayed\nresult");
  });
});
