import { describe, expect, it } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerLspTool, type ServerManager } from "./tools";
import type { Diagnostic } from "./types";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

interface DiagnosticClientMock {
  config: { name: string };
  getDiagnostics: (filePath: string) => Promise<Diagnostic[]>;
}

const TEST_DIAGNOSTIC: Diagnostic = {
  range: {
    start: { line: 1, character: 2 },
    end: { line: 1, character: 5 },
  },
  severity: 1,
  source: "ts",
  code: 1234,
  message: "Broken type",
};

function client(
  name: string,
  result: Diagnostic[] | Error
): DiagnosticClientMock {
  return {
    config: { name },
    getDiagnostics() {
      return result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
    },
  };
}

function captureTool(clients: DiagnosticClientMock[]): RegisteredTool {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  };
  const manager: ServerManager = {
    clientsForFile: () => clients,
    clientForFileWithCapability: () => null,
    anyClient: () => null,
    getRootPath: () => "/workspace",
  };

  registerLspTool(pi, manager);

  const registeredTool = tools[0];
  if (!registeredTool) {
    throw new Error("LSP tool was not registered");
  }
  return registeredTool;
}

function executeDiagnostics(tool: RegisteredTool): Promise<unknown> {
  return Promise.resolve(
    Reflect.apply(tool.execute, tool, [
      "test-call",
      { operation: "diagnostics", filePath: "src/example.ts" },
    ])
  );
}

async function rejectionMessage(tool: RegisteredTool): Promise<string> {
  try {
    await executeDiagnostics(tool);
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw error;
  }
  throw new Error("Expected diagnostics to fail");
}

describe("LSP diagnostics aggregation", () => {
  it("fails as unavailable when no clients match the file", async () => {
    const message = await rejectionMessage(captureTool([]));

    expect(message).toContain("unavailable");
    expect(message).toContain("src/example.ts");
  });

  it("fails as unavailable with every server cause when all clients fail", async () => {
    const message = await rejectionMessage(
      captureTool([
        client("typescript", new Error("server stopped")),
        client("eslint", new Error("startup failed")),
      ])
    );

    expect(message).toContain("unavailable");
    expect(message).toContain("typescript: server stopped");
    expect(message).toContain("eslint: startup failed");
    expect(message).not.toContain("all clean");
  });

  it("fails as incomplete without claiming all clean when a clean result is partial", async () => {
    const message = await rejectionMessage(
      captureTool([
        client("typescript", []),
        client("eslint", new Error("timed out")),
      ])
    );

    expect(message).toContain("incomplete");
    expect(message).toContain("typescript returned no diagnostics");
    expect(message).toContain("eslint: timed out");
    expect(message).not.toContain("all clean");
  });

  it("fails as incomplete while retaining populated diagnostics and server causes", async () => {
    const message = await rejectionMessage(
      captureTool([
        client("typescript", [TEST_DIAGNOSTIC]),
        client("eslint", new Error("connection closed")),
      ])
    );

    expect(message).toContain("incomplete");
    expect(message).toContain("Broken type");
    expect(message).toContain("typescript");
    expect(message).toContain("eslint: connection closed");
    expect(message).not.toContain("all clean");
  });

  it("keeps successful empty diagnostics unchanged", async () => {
    const result = await executeDiagnostics(
      captureTool([client("typescript", [])])
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "src/example.ts: No diagnostics — all clean ✓",
        },
      ],
      details: { groups: [], errors: [] },
    });
  });

  it("keeps successful populated diagnostics unchanged", async () => {
    const result = await executeDiagnostics(
      captureTool([client("typescript", [TEST_DIAGNOSTIC])])
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: [
            "Diagnostics for src/example.ts: 1 error",
            "",
            "── typescript ──",
            "1. ERROR line 2:3-6 [ts](1234)",
            "   Broken type",
          ].join("\n"),
        },
      ],
      details: {
        groups: [{ source: "typescript", count: 1 }],
        errors: [],
      },
    });
  });
});
