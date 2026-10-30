// Drawing-only adapters for the installed companion shapes. Unknown shapes
// return undefined so the caller uses the existing Fallback renderer.
export type CompanionGroup = "mcp" | "codemode" | "web";

const WEB_NAMES = new Set([
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
]);

export function companionGroup(name: string): CompanionGroup | undefined {
  if (name.startsWith("mcp__")) {
    return "mcp";
  }
  if (name === "codemode") {
    return "codemode";
  }
  if (WEB_NAMES.has(name)) {
    return "web";
  }
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function scope(
  single: unknown,
  many: unknown,
  label: string,
): string | undefined {
  if (!optionalString(single) || (many !== undefined && !strings(many))) {
    return undefined;
  }
  if (typeof single === "string") {
    return single;
  }
  if (many !== undefined && many.length > 0) {
    return `${many.length} ${label} · ${many[0]}`;
  }
  return undefined;
}

export function companionCallSummary(
  name: string,
  args: unknown,
): string | undefined {
  if (!record(args)) {
    return undefined;
  }
  switch (name) {
    case "codemode":
      return typeof args.code === "string" ? args.code : undefined;
    case "web_search":
      return scope(args.query, args.queries, "queries");
    case "fetch_content":
      return scope(args.url, args.urls, "URLs");
    case "source_check":
      return typeof args.claim === "string" ? args.claim : undefined;
    case "get_search_content": {
      if (
        typeof args.responseId !== "string" ||
        !optionalString(args.query) ||
        !optionalString(args.url)
      ) {
        return undefined;
      }
      if (args.queryIndex !== undefined && !count(args.queryIndex)) {
        return undefined;
      }
      if (args.urlIndex !== undefined && !count(args.urlIndex)) {
        return undefined;
      }
      return [
        args.responseId,
        args.query,
        args.queryIndex === undefined ? undefined : `query #${args.queryIndex}`,
        args.url,
        args.urlIndex === undefined ? undefined : `URL #${args.urlIndex}`,
      ]
        .filter((part) => part !== undefined)
        .join(" · ");
    }
    default:
      return mcpCallSummary(name, args);
  }
}

function mcpCallSummary(
  name: string,
  _args: Record<string, unknown>,
): string | undefined {
  // Pi built-in MCP names tools `mcp__<server>__<tool>` and passes the MCP
  // tool's own arguments, so the label comes from the name (as Pi parses it).
  const match = /^mcp__(.+?)__(.+)$/u.exec(name);
  return match ? `${match[1]} · ${match[2]}` : undefined;
}

export function companionResultSummary(
  name: string,
  _args: unknown,
  details: unknown,
  text: string,
): string | undefined {
  // Call and result drift are independent: valid details still summarize a
  // resumed result even when its stored arguments use an unfamiliar shape.
  const firstLine =
    text.split(/\r?\n|\r/u).find((line) => line.trim()) ?? "done";
  const group = companionGroup(name);
  if (!group || !record(details)) {
    return undefined;
  }
  if (group === "codemode") {
    if (!Array.isArray(details.calls)) {
      return undefined;
    }
    return `${details.calls.length} tool call${details.calls.length === 1 ? "" : "s"} · ${Buffer.byteLength(text, "utf8")} bytes`;
  }
  if (typeof details.error === "string") {
    return firstLine === "done" ? details.error : firstLine;
  }
  if (group === "mcp") {
    if (typeof details.server !== "string") {
      return undefined;
    }
    return typeof details.tool === "string" ? firstLine : undefined;
  }
  if (
    name === "source_check" &&
    typeof details.responseId === "string" &&
    count(details.sourceCount) &&
    count(details.passageCount)
  ) {
    return `${details.sourceCount} sources · ${details.passageCount} passages`;
  }
  if (
    name === "fetch_content" &&
    strings(details.urls) &&
    count(details.urlCount) &&
    count(details.successful) &&
    (details.totalChars === undefined || count(details.totalChars))
  ) {
    return `${details.successful}/${details.urlCount} URLs${details.totalChars === undefined ? "" : ` · ${details.totalChars} chars`}`;
  }
  if (
    name === "web_search" &&
    strings(details.queries) &&
    count(details.queryCount) &&
    count(details.successfulQueries) &&
    count(details.totalResults)
  ) {
    return `${details.totalResults} results · ${details.successfulQueries}/${details.queryCount} queries`;
  }
  if (name === "get_search_content") {
    if (typeof details.query === "string" && count(details.resultCount)) {
      return `${details.resultCount} results · ${details.query}`;
    }
    if (
      typeof details.url === "string" &&
      count(details.contentLength) &&
      count(details.returnedChars)
    ) {
      return `${details.returnedChars}/${details.contentLength} chars · ${details.url}`;
    }
  }
  if (typeof details.phase === "string") {
    return firstLine;
  }
  // Search/content responses carry a response id; text is the stable summary.
  if (
    (name === "web_search" || name === "get_search_content") &&
    typeof details.responseId === "string"
  ) {
    return firstLine;
  }
  return undefined;
}

// Local structural view: execution and schemas remain owned by Pi core.
export interface CodemodeNestedCall {
  id: string;
  name: string;
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  cost?: number;
}

export function isCodemodeNestedCall(
  value: unknown,
): value is CodemodeNestedCall {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.args === "string" &&
    (value.status === "running" ||
      value.status === "ok" ||
      value.status === "error" ||
      value.status === "cancelled") &&
    (value.durationMs === undefined ||
      (typeof value.durationMs === "number" &&
        Number.isFinite(value.durationMs))) &&
    optionalString(value.error) &&
    (value.cost === undefined ||
      (typeof value.cost === "number" && Number.isFinite(value.cost)))
  );
}

export function codemodeCalls(details: unknown): unknown[] | undefined {
  return record(details) && Array.isArray(details.calls)
    ? details.calls
    : undefined;
}
