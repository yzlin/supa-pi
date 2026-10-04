import { describe, expect, test } from "bun:test";

import { companionCallSummary, companionResultSummary } from "./companion";

// Additional installed success/mode shapes: pi-mcp-adapter 5.0.0 gateway,
// pi-web-access 0.30.0 index.ts search/content response details.
describe("guarded companion shapes", () => {
  test("gateway summaries identify the active mode", () => {
    for (const [args, summary] of [
      [{}, "status"],
      [{ action: "auth-start", server: "docs" }, "auth-start · docs"],
      [{ search: "themes" }, "search · themes"],
      [{ describe: "docs_lookup" }, "describe · docs_lookup"],
      [{ connect: "docs" }, "connect · docs"],
      [{ instructions: "docs" }, "instructions · docs"],
    ] as const) {
      expect(companionCallSummary("mcp", args)).toBe(summary);
    }
    expect(
      companionResultSummary(
        "mcp",
        {},
        {
          mode: "status",
          servers: [],
          totalTools: 12,
          connectedCount: 2,
          disabledCount: 1,
        },
        "Status",
      ),
    ).toBe("2 connected · 12 tools");
    expect(
      companionResultSummary(
        "mcp",
        { describe: "docs_lookup" },
        { mode: "describe", server: "docs", tool: "lookup" },
        "Tool schema",
      ),
    ).toBe("Tool schema");
  });

  test("search and stored content success details use compact counts", () => {
    expect(
      companionResultSummary(
        "web_search",
        { query: "Pi" },
        {
          queries: ["Pi"],
          queryCount: 1,
          successfulQueries: 1,
          totalResults: 5,
          searchId: "r1",
          includeContent: false,
        },
        "Search results",
      ),
    ).toBe("5 results · 1/1 queries");
    expect(
      companionResultSummary(
        "get_search_content",
        { responseId: "r1", queryIndex: 0 },
        { query: "Pi", resultCount: 5 },
        "Results",
      ),
    ).toBe("5 results · Pi");
    expect(
      companionResultSummary(
        "get_search_content",
        { responseId: "r1", urlIndex: 0 },
        {
          url: "https://example.com",
          title: "Example",
          contentLength: 100,
          offset: 0,
          returnedChars: 50,
        },
        "Content",
      ),
    ).toBe("50/100 chars · https://example.com");
  });

  test("mismatched consumed fields degrade rather than stringifying objects", () => {
    for (const [name, args] of [
      ["TaskCreate", { subject: [], description: "test" }],
      ["TaskUpdate", { taskId: "1", status: {} }],
      ["TaskOutput", { task_id: "1", block: "yes", timeout: 5 }],
      ["TaskStop", { task_id: 1 }],
      ["TaskExecute", { task_ids: [1] }],
      ["mcp", { tool: "lookup", args: [] }],
      ["mcp", { connect: true }],
      ["codemode", { code: ["first"] }],
      ["web_search", { query: {}, queries: ["Pi"] }],
      ["fetch_content", { urls: [1] }],
      ["get_search_content", { responseId: "r1", urlIndex: "1" }],
      ["source_check", { claim: {} }],
    ] as const) {
      expect(companionCallSummary(name, args)).toBeUndefined();
    }
    for (const details of [undefined, null, [], "old", { calls: "old" }]) {
      expect(
        companionResultSummary(
          "codemode",
          { code: "first();" },
          details,
          "Script completed",
        ),
      ).toBeUndefined();
    }
    expect(
      companionResultSummary(
        "fetch_content",
        { url: "https://example.com" },
        { urls: ["https://example.com"], urlCount: 1, successful: "one" },
        "Content",
      ),
    ).toBeUndefined();
  });
});

test("installed MCP non-call successes remain compact rather than degrading", () => {
  expect(
    companionResultSummary(
      "mcp",
      { search: "docs" },
      {
        mode: "search",
        matches: [{ server: "docs", tool: "lookup", score: 1 }],
        count: 3,
        hasMore: false,
        nextOffset: null,
        query: "docs",
      },
      "Found tools",
    ),
  ).toBe("3 tools");
  expect(
    companionResultSummary(
      "mcp",
      { connect: "docs" },
      {
        mode: "list",
        server: "docs",
        tools: ["lookup"],
        count: 1,
        hasInstructions: true,
      },
      "Connected",
    ),
  ).toBe("1 tool · docs");
  expect(
    companionResultSummary(
      "mcp",
      { instructions: "docs" },
      { mode: "instructions", server: "docs", length: 42 },
      "Usage instructions",
    ),
  ).toBe("Usage instructions");
  expect(
    companionResultSummary(
      "mcp",
      { describe: "docs_lookup" },
      {
        mode: "describe",
        server: "docs",
        tool: {
          name: "lookup",
          description: "Lookup docs",
          inputSchema: { type: "object" },
        },
      },
      "Tool schema",
    ),
  ).toBe("Tool schema");
  expect(
    companionResultSummary(
      "mcp",
      { action: "auth-start", server: "docs" },
      { mode: "auth-start", server: "docs", authenticated: true },
      "Authenticated",
    ),
  ).toBe("Authenticated");
});
