// Representative installed shapes recorded in the execution brief:
// `mcp__*` call shapes with Pi built-in MCP 1.4.0 result details
// (`{ server, tool }`), Pi codemode 1.0.2,
// pi-web-access 0.30.0. No external package imports are needed for drawing.
export const companionFixtures = [
  {
    name: "mcp__docs__lookup",
    group: "mcp",
    args: { query: "Pi" },
    details: { server: "docs", tool: "lookup" },
    text: "Found docs",
    call: "docs · lookup",
    summary: "Found docs",
  },
  {
    name: "mcp__docs__prompt",
    group: "mcp",
    args: { tool: "other", args: [] },
    details: { server: "docs", tool: "prompt" },
    text: "MCP tool docs/prompt returned an error",
    call: "docs · prompt",
    summary: "MCP tool docs/prompt returned an error",
  },
  {
    name: "codemode",
    group: "codemode",
    args: {
      code: '\nconst x = await tools.read({path: "a"});\n\nconsole.log(x);',
    },
    details: {
      calls: [
        {
          id: "nested-1",
          name: "read",
          args: '{"path":"a"}',
          status: "ok",
          durationMs: 10,
        },
      ],
      fullOutputPath: "/tmp/output",
    },
    text: "Script completed\noutput",
    call: "codemode → running",
    summary: "1 tool call · 23 bytes",
  },
  {
    name: "web_search",
    group: "web",
    args: { queries: ["Pi tools", "Pi themes"] },
    details: {
      queries: ["Pi tools", "Pi themes"],
      queryCount: 2,
      successfulQueries: 2,
      totalResults: 5,
      searchId: "r1",
      includeContent: false,
    },
    text: "Search results",
    call: "2 queries · Pi tools",
    summary: "5 results · 2/2 queries",
  },
  {
    name: "source_check",
    group: "web",
    args: { claim: "Pi supports renderers" },
    details: { responseId: "r1", sourceCount: 3, passageCount: 5 },
    text: "Sources checked",
    call: "Pi supports renderers",
    summary: "3 sources · 5 passages",
  },
  {
    name: "fetch_content",
    group: "web",
    args: { urls: ["https://example.com", "https://example.org"] },
    details: {
      urls: ["https://example.com", "https://example.org"],
      urlCount: 2,
      successful: 1,
      totalChars: 100,
    },
    text: "Page content",
    call: "2 URLs · https://example.com",
    summary: "1/2 URLs · 100 chars",
  },
  {
    name: "get_search_content",
    group: "web",
    args: { responseId: "r1", queryIndex: 0, urlIndex: 1 },
    details: { error: "Not found" },
    text: "Not found",
    call: "r1 · query #0 · URL #1",
    summary: "Not found",
  },
] as const;
