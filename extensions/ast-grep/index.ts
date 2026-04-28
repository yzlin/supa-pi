import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { globSync } from "glob";
import { Type } from "typebox";

const baseDir = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(join(baseDir, "prompt.md"), "utf8").trim();
const MAX_PATTERNS = 20;
const MAX_PATTERN_LENGTH = 10_000;
const AST_GREP_TIMEOUT_MS = 120_000;
const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9_+-]*$/;

const AstGrepParams = Type.Object({
  pat: Type.Array(
    Type.String({
      maxLength: MAX_PATTERN_LENGTH,
    }),
    {
      description:
        "One or more AST patterns to match. Each pattern must parse as a single AST node for the target language.",
      minItems: 1,
      maxItems: MAX_PATTERNS,
    }
  ),
  lang: Type.Optional(
    Type.String({
      description:
        "Optional language name for ast-grep (for example: typescript, tsx, javascript, python, rust). Strongly recommended in mixed-language repos.",
      maxLength: 64,
    })
  ),
  path: Type.Optional(
    Type.String({
      description:
        "Optional path scope. Accepts a file, directory, glob pattern, or a comma/space-separated path list. Defaults to current directory.",
      maxLength: 4_000,
    })
  ),
  glob: Type.Optional(
    Type.String({
      description:
        "Optional glob filter(s) relative to the scoped path. Passed to ast-grep as repeated --globs flags. Accepts one or more comma/space-separated globs.",
      maxLength: 4_000,
    })
  ),
  sel: Type.Optional(
    Type.String({
      description:
        "Optional ast-grep selector kind for contextual pattern mode. Use this to return an inner AST node from a larger parseable wrapper pattern.",
      maxLength: 128,
    })
  ),
  offset: Type.Optional(
    Type.Integer({
      description: "Number of merged matches to skip before returning results.",
      minimum: 0,
    })
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "Maximum number of merged matches to return.",
      minimum: 1,
    })
  ),
});

interface AstGrepRangePoint {
  line: number;
  column: number;
}

interface AstGrepRange {
  byteOffset: { start: number; end: number };
  start: AstGrepRangePoint;
  end: AstGrepRangePoint;
}

interface AstGrepCapture {
  text: string;
  range?: AstGrepRange;
}

interface AstGrepRawMatch {
  text: string;
  range: AstGrepRange;
  file: string;
  lines: string;
  language?: string;
  metaVariables?: {
    single?: Record<string, AstGrepCapture>;
    multi?: Record<string, AstGrepCapture[]>;
    transformed?: Record<string, AstGrepCapture>;
  };
}

interface AstGrepMatch {
  file: string;
  absoluteFile: string;
  text: string;
  lines: string;
  language?: string;
  range: AstGrepRange;
  captures: {
    single: Record<string, string>;
    multi: Record<string, string[]>;
    transformed: Record<string, string>;
  };
  matchedPatterns: string[];
  matchedPatternIndexes: number[];
}

interface AstGrepDetails {
  pat: string[];
  lang?: string;
  path?: string;
  glob?: string;
  sel?: string;
  offset: number;
  limit?: number;
  totalMatches: number;
  returnedMatches: number;
  filesWithMatches: number;
  filesSearched: number | null;
  parseIssues: string[];
  matches: AstGrepMatch[];
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

interface RunResult {
  matches: AstGrepRawMatch[];
  filesSearched: number | null;
  diagnostics: string[];
}

function hasGlobMagic(value: string): boolean {
  return /[*?[\]{}!]/.test(value);
}

function parseSpecList(spec?: string): string[] {
  if (!spec) return [];
  const trimmed = spec.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveSearchPaths(spec: string | undefined, cwd: string): string[] {
  if (!spec?.trim()) return ["."];

  const trimmed = spec.trim();
  if (existsSync(resolve(cwd, trimmed))) {
    return [trimmed];
  }

  const resolved = new Set<string>();
  for (const token of parseSpecList(trimmed)) {
    if (existsSync(resolve(cwd, token))) {
      resolved.add(token);
      continue;
    }

    if (hasGlobMagic(token)) {
      const matches = globSync(token, {
        cwd,
        dot: true,
        onlyFiles: false,
      });
      for (const match of matches) {
        resolved.add(match);
      }
      continue;
    }

    resolved.add(token);
  }

  return Array.from(resolved);
}

function normalizeRelativePath(file: string, cwd: string): string {
  const rel = relative(cwd, file);
  if (!rel || rel.startsWith("..")) {
    return file;
  }
  return rel;
}

function normalizeCaptureMap(
  captures: AstGrepRawMatch["metaVariables"]
): AstGrepMatch["captures"] {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  const transformed: Record<string, string> = {};

  for (const [name, capture] of Object.entries(captures?.single ?? {})) {
    single[name] = capture.text;
  }

  for (const [name, values] of Object.entries(captures?.multi ?? {})) {
    multi[name] = values.map((value) => value.text);
  }

  for (const [name, capture] of Object.entries(captures?.transformed ?? {})) {
    transformed[name] = capture.text;
  }

  return { single, multi, transformed };
}

function dedupeMatches(
  matchesByPattern: Array<{
    pattern: string;
    patternIndex: number;
    matches: AstGrepRawMatch[];
  }>,
  cwd: string
): AstGrepMatch[] {
  const deduped = new Map<string, AstGrepMatch>();

  for (const entry of matchesByPattern) {
    for (const match of entry.matches) {
      const key = [
        match.file,
        match.range.byteOffset.start,
        match.range.byteOffset.end,
        match.text,
      ].join(":");

      const existing = deduped.get(key);
      if (existing) {
        existing.matchedPatterns.push(entry.pattern);
        existing.matchedPatternIndexes.push(entry.patternIndex);
        continue;
      }

      deduped.set(key, {
        file: normalizeRelativePath(match.file, cwd),
        absoluteFile: match.file,
        text: match.text,
        lines: match.lines,
        language: match.language,
        range: match.range,
        captures: normalizeCaptureMap(match.metaVariables),
        matchedPatterns: [entry.pattern],
        matchedPatternIndexes: [entry.patternIndex],
      });
    }
  }

  return Array.from(deduped.values()).sort((left, right) => {
    const fileCompare = left.file.localeCompare(right.file);
    if (fileCompare !== 0) return fileCompare;

    const startCompare =
      left.range.byteOffset.start - right.range.byteOffset.start;
    if (startCompare !== 0) return startCompare;

    const endCompare = left.range.byteOffset.end - right.range.byteOffset.end;
    if (endCompare !== 0) return endCompare;

    return left.text.localeCompare(right.text);
  });
}

function formatCaptureSummary(captures: AstGrepMatch["captures"]): string[] {
  const lines: string[] = [];

  const singleEntries = Object.entries(captures.single);
  if (singleEntries.length > 0) {
    lines.push(
      `single: ${singleEntries
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
        .join(", ")}`
    );
  }

  const multiEntries = Object.entries(captures.multi);
  if (multiEntries.length > 0) {
    lines.push(
      `multi: ${multiEntries
        .map(([name, values]) => `${name}=${JSON.stringify(values)}`)
        .join(", ")}`
    );
  }

  const transformedEntries = Object.entries(captures.transformed);
  if (transformedEntries.length > 0) {
    lines.push(
      `transformed: ${transformedEntries
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
        .join(", ")}`
    );
  }

  return lines;
}

function formatMatches(
  matches: AstGrepMatch[],
  details: AstGrepDetails
): string {
  const lines: string[] = [];
  const shownSuffix =
    details.returnedMatches !== details.totalMatches
      ? ` (showing ${details.returnedMatches} after offset/limit)`
      : "";
  const filesSearched =
    details.filesSearched == null ? "unknown" : String(details.filesSearched);

  lines.push(
    `Found ${details.totalMatches} match(es) in ${details.filesWithMatches} file(s); searched ${filesSearched} file(s)${shownSuffix}.`
  );
  lines.push(`Patterns: ${details.pat.length}`);

  if (details.path) lines.push(`Path: ${details.path}`);
  if (details.glob) lines.push(`Glob: ${details.glob}`);
  if (details.lang) lines.push(`Lang: ${details.lang}`);
  if (details.sel) lines.push(`Selector: ${details.sel}`);
  if (details.parseIssues.length > 0) {
    lines.push("");
    lines.push("Parse issues:");
    for (const issue of details.parseIssues) {
      lines.push(`- ${issue}`);
    }
  }

  if (matches.length === 0) {
    return lines.join("\n");
  }

  const grouped = new Map<string, AstGrepMatch[]>();
  for (const match of matches) {
    const existing = grouped.get(match.file) ?? [];
    existing.push(match);
    grouped.set(match.file, existing);
  }

  for (const [file, fileMatches] of grouped) {
    lines.push("");
    lines.push(file);

    for (const match of fileMatches) {
      const startLine = match.range.start.line + 1;
      const startColumn = match.range.start.column + 1;
      const endLine = match.range.end.line + 1;
      const endColumn = match.range.end.column + 1;

      lines.push(
        `  - ${startLine}:${startColumn}-${endLine}:${endColumn} bytes ${match.range.byteOffset.start}-${match.range.byteOffset.end}`
      );
      lines.push(`    line: ${match.lines}`);
      lines.push(`    match: ${match.text}`);
      lines.push(
        `    patterns: ${match.matchedPatternIndexes.map((index) => index + 1).join(", ")}`
      );

      for (const captureLine of formatCaptureSummary(match.captures)) {
        lines.push(`    captures ${captureLine}`);
      }
    }
  }

  return lines.join("\n");
}

function writeTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ast-grep-"));
  const file = join(dir, "output.txt");
  writeFileSync(file, content, "utf8");
  return file;
}

function isSafeAstGrepName(value: string): boolean {
  return SAFE_NAME_RE.test(value);
}

function parseInspectSummary(stderr: string): {
  filesSearched: number | null;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  let filesSearched: number | null = null;

  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/scannedFileCount=(\d+)/);
    if (match) {
      filesSearched = Number(match[1]);
      continue;
    }

    if (line.startsWith("sg: summary|")) {
      continue;
    }

    diagnostics.push(line);
  }

  return { filesSearched, diagnostics };
}

async function runPattern(
  pattern: string,
  params: {
    lang?: string;
    selector?: string;
    searchPaths: string[];
    globs: string[];
    cwd: string;
  },
  signal?: AbortSignal
): Promise<RunResult> {
  const args = [
    "run",
    "--pattern",
    pattern,
    "--color",
    "never",
    "--json=compact",
    "--inspect",
    "summary",
  ];

  if (params.lang) {
    args.push("--lang", params.lang);
  }

  if (params.selector) {
    args.push("--selector", params.selector);
  }

  for (const glob of params.globs) {
    args.push("--globs", glob);
  }

  args.push(...params.searchPaths);

  return new Promise((resolve, reject) => {
    const child = spawn("ast-grep", args, {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;

    const forceKillTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, AST_GREP_TIMEOUT_MS + 1_000);
    forceKillTimer.unref();

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, AST_GREP_TIMEOUT_MS);
    timeoutTimer.unref();

    const abortHandler = () => {
      aborted = true;
      child.kill("SIGTERM");
    };

    signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abortHandler);
      const cause = error as NodeJS.ErrnoException;
      if (cause.code === "ENOENT") {
        reject(
          new Error(
            "ast-grep not found in PATH. Install ast-grep first, then retry."
          )
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abortHandler);

      if (aborted) {
        reject(new Error("ast-grep search aborted."));
        return;
      }

      if (timedOut) {
        reject(
          new Error(
            `ast-grep timed out after ${Math.floor(AST_GREP_TIMEOUT_MS / 1000)}s.`
          )
        );
        return;
      }

      const { filesSearched, diagnostics } = parseInspectSummary(stderr);

      if (code !== 0 && code !== 1) {
        const message =
          diagnostics.join("\n") || `ast-grep exited with code ${code}`;
        reject(new Error(message));
        return;
      }

      if (!stdout.trim()) {
        resolve({ matches: [], filesSearched, diagnostics });
        return;
      }

      try {
        const matches = JSON.parse(stdout) as AstGrepRawMatch[];
        resolve({ matches, filesSearched, diagnostics });
      } catch (error) {
        reject(
          new Error(
            `Failed to parse ast-grep JSON output: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
  });
}

export default function astGrepExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
    };
  });

  pi.registerTool({
    name: "ast_grep",
    label: "AstGrep",
    description: `Search code structurally using ast-grep AST patterns. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(
      DEFAULT_MAX_BYTES
    )} (whichever is hit first). If truncated, full output is saved to a temp file.`,
    promptSnippet:
      "AST-based structural code search via ast-grep. Use when syntax shape matters more than raw text; pat is required.",
    parameters: AstGrepParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const patterns = params.pat.map((value) => value.trim()).filter(Boolean);
      const offset = params.offset ?? 0;

      if (params.lang && !isSafeAstGrepName(params.lang)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: invalid lang=${JSON.stringify(params.lang)}. Use a simple ast-grep language name such as typescript, tsx, javascript, python, or rust.`,
            },
          ],
          details: {
            pat: patterns,
            lang: params.lang,
            path: params.path,
            glob: params.glob,
            sel: params.sel,
            offset,
            limit: params.limit,
            totalMatches: 0,
            returnedMatches: 0,
            filesWithMatches: 0,
            filesSearched: null,
            parseIssues: [
              `Invalid lang value: ${JSON.stringify(params.lang)}.`,
            ],
            matches: [],
          } satisfies AstGrepDetails,
        };
      }

      if (params.sel && !isSafeAstGrepName(params.sel)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: invalid sel=${JSON.stringify(params.sel)}. Selector kinds should look like identifier, function_declaration, or method_definition.`,
            },
          ],
          details: {
            pat: patterns,
            lang: params.lang,
            path: params.path,
            glob: params.glob,
            sel: params.sel,
            offset,
            limit: params.limit,
            totalMatches: 0,
            returnedMatches: 0,
            filesWithMatches: 0,
            filesSearched: null,
            parseIssues: [`Invalid sel value: ${JSON.stringify(params.sel)}.`],
            matches: [],
          } satisfies AstGrepDetails,
        };
      }

      if (patterns.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: pat must include at least one non-empty pattern.",
            },
          ],
          details: {
            pat: [],
            lang: params.lang,
            path: params.path,
            glob: params.glob,
            sel: params.sel,
            offset: params.offset ?? 0,
            limit: params.limit,
            totalMatches: 0,
            returnedMatches: 0,
            filesWithMatches: 0,
            filesSearched: null,
            parseIssues: ["pat must include at least one non-empty pattern."],
            matches: [],
          } satisfies AstGrepDetails,
        };
      }

      const searchPaths = resolveSearchPaths(params.path, ctx.cwd);
      if (searchPaths.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Error: No paths matched path=${JSON.stringify(params.path)}.`,
            },
          ],
          details: {
            pat: patterns,
            lang: params.lang,
            path: params.path,
            glob: params.glob,
            sel: params.sel,
            offset: params.offset ?? 0,
            limit: params.limit,
            totalMatches: 0,
            returnedMatches: 0,
            filesWithMatches: 0,
            filesSearched: 0,
            parseIssues: [
              `No paths matched path=${JSON.stringify(params.path)}.`,
            ],
            matches: [],
          } satisfies AstGrepDetails,
        };
      }

      const globs = parseSpecList(params.glob);

      try {
        const runs = await Promise.all(
          patterns.map(async (pattern, patternIndex) => ({
            pattern,
            patternIndex,
            ...(await runPattern(
              pattern,
              {
                lang: params.lang,
                selector: params.sel,
                searchPaths,
                globs,
                cwd: ctx.cwd,
              },
              signal
            )),
          }))
        );

        const mergedMatches = dedupeMatches(
          runs.map((run) => ({
            pattern: run.pattern,
            patternIndex: run.patternIndex,
            matches: run.matches,
          })),
          ctx.cwd
        );
        const totalMatches = mergedMatches.length;
        const slicedMatches =
          params.limit == null
            ? mergedMatches.slice(offset)
            : mergedMatches.slice(offset, offset + params.limit);
        const filesWithMatches = new Set(
          mergedMatches.map((match) => match.file)
        ).size;
        const filesSearched = runs.reduce<number | null>((current, run) => {
          if (run.filesSearched == null) return current;
          if (current == null) return run.filesSearched;
          return Math.max(current, run.filesSearched);
        }, null);
        const parseIssues = Array.from(
          new Set(runs.flatMap((run) => run.diagnostics).filter(Boolean))
        );

        const details: AstGrepDetails = {
          pat: patterns,
          lang: params.lang,
          path: params.path,
          glob: params.glob,
          sel: params.sel,
          offset,
          limit: params.limit,
          totalMatches,
          returnedMatches: slicedMatches.length,
          filesWithMatches,
          filesSearched,
          parseIssues,
          matches: slicedMatches,
        };

        const output = formatMatches(slicedMatches, details);
        const truncation = truncateHead(output, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let text = truncation.content;
        if (truncation.truncated) {
          details.truncation = truncation;
          details.fullOutputPath = writeTempFile(output);
          text += `\n\n[truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines, ${truncation.outputBytes}/${truncation.totalBytes} bytes. Full output: ${details.fullOutputPath}]`;
        }

        return {
          content: [{ type: "text", text }],
          details,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `ast_grep failed: ${message}`,
            },
          ],
          details: {
            pat: patterns,
            lang: params.lang,
            path: params.path,
            glob: params.glob,
            sel: params.sel,
            offset,
            limit: params.limit,
            totalMatches: 0,
            returnedMatches: 0,
            filesWithMatches: 0,
            filesSearched: null,
            parseIssues: [message],
            matches: [],
          } satisfies AstGrepDetails,
        };
      }
    },
  });
}
