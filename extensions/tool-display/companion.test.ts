import { describe, expect, test } from "bun:test";

import {
  companionCallSummary,
  companionGroup,
  companionResultSummary,
} from "./companion";

// Additional installed success shapes: Pi built-in MCP 1.4.0 tool details,
// pi-web-access 0.30.0 index.ts search/content response details.
describe("guarded companion shapes", () => {
  test("built-in MCP tools summarize by server and first result line", () => {
    expect(companionGroup("mcp__docs__lookup")).toBe("mcp");
    expect(
      companionResultSummary(
        "mcp__docs__lookup",
        {},
        { server: "docs", tool: "lookup" },
        "\nFound docs\nmore",
      ),
    ).toBe("Found docs");
  });

  test("built-in MCP call summaries come from the tool name, not the arguments", () => {
    expect(companionCallSummary("mcp__docs__lookup", { query: "Pi" })).toBe(
      "docs · lookup",
    );
    expect(
      companionCallSummary("mcp__docs__lookup", { tool: "other", args: [] }),
    ).toBe("docs · lookup");
    expect(companionCallSummary("mcp__my_server__get__file", {})).toBe(
      "my_server · get__file",
    );
    for (const name of ["mcp__", "mcp__docs", "mcp____lookup"]) {
      expect(companionCallSummary(name, {})).toBeUndefined();
    }
  });

  test("the retired adapter gateway name is not an MCP companion", () => {
    expect(companionGroup("mcp")).toBeUndefined();
    expect(companionCallSummary("mcp", { search: "docs" })).toBeUndefined();
    expect(
      companionResultSummary(
        "mcp",
        { search: "docs" },
        { mode: "search", matches: [], count: 3 },
        "Found tools",
      ),
    ).toBeUndefined();
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

test("retired task shapes are not companion adapters", () => {
  for (const name of [
    "TaskCreate",
    "TaskList",
    "TaskGet",
    "TaskUpdate",
    "TaskOutput",
    "TaskStop",
    "TaskExecute",
  ]) {
    expect(companionGroup(name)).toBeUndefined();
    expect(
      companionCallSummary(name, {
        subject: "old",
        description: "old",
        taskId: "1",
      }),
    ).toBeUndefined();
    expect(
      companionResultSummary(name, {}, undefined, "Historic output"),
    ).toBeUndefined();
    expect(
      companionResultSummary(name, {}, { error: "old" }, "Historic output"),
    ).toBeUndefined();
  }
});
