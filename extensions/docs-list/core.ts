import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export interface DocsListItem {
  path: string;
  summary: string | null;
  readWhen: string[];
  warnings: string[];
}

export interface DocsListWarning {
  path?: string;
  message: string;
}

export interface DocsListResult {
  ok: boolean;
  target: string;
  root: string;
  rootPath: string;
  exists: boolean;
  entries: DocsListItem[];
  docs: DocsListItem[];
  warnings: DocsListWarning[];
  warningCount: number;
}

const DEFAULT_DOCS_PATH = "docs";
const READ_WHEN_KEY = "read_when:";
const SUMMARY_KEY = "summary:";
const AT_PREFIX_REGEX = /^@+/;
const SINGLE_QUOTE_REGEX = /'/g;
const QUOTE_EDGE_REGEX = /^['"]|['"]$/g;
const WHITESPACE_REGEX = /\s+/g;
const EXCLUDED_DIRS = new Set(["archive", "research"]);

function compactStrings(values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const normalized = String(value).trim();
    if (normalized.length > 0) {
      result.push(normalized);
    }
  }
  return result;
}

function stripAtPrefix(value: string): string {
  return value.replace(AT_PREFIX_REGEX, "");
}

function getDocsTarget(path?: string): string {
  return stripAtPrefix(path?.trim() || DEFAULT_DOCS_PATH);
}

function hasParentSegment(path: string): boolean {
  return path.split(sep).includes("..");
}

export function resolveDocsRoot(cwd: string, path?: string): string {
  const target = getDocsTarget(path);

  if (isAbsolute(target)) {
    throw new Error("path must be relative");
  }

  const normalized = normalize(target);
  if (hasParentSegment(normalized)) {
    throw new Error("path must not escape cwd");
  }

  return join(cwd, normalized);
}

function isWithinOrEqual(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

function assertRootWithinCwd(cwd: string, root: string): void {
  const realCwd = realpathSync(cwd);
  const realRoot = realpathSync(root);
  if (!isWithinOrEqual(realCwd, realRoot)) {
    throw new Error("path must stay within cwd");
  }
}

function walkMarkdownFiles(dir: string, base: string = dir): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      files.push(...walkMarkdownFiles(fullPath, base));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relative(base, fullPath));
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function normalizeSummary(value: string): string {
  return value
    .replace(QUOTE_EDGE_REGEX, "")
    .replace(WHITESPACE_REGEX, " ")
    .trim();
}

function parseReadWhenInlineArray(
  inline: string,
  warnings: string[]
): string[] {
  if (!(inline.startsWith("[") && inline.endsWith("]"))) {
    return [];
  }

  try {
    const parsed = JSON.parse(
      inline.replace(SINGLE_QUOTE_REGEX, '"')
    ) as unknown;
    return Array.isArray(parsed) ? compactStrings(parsed) : [];
  } catch {
    warnings.push("malformed read_when inline array");
    return [];
  }
}

function extractMetadata(fullPath: string): Omit<DocsListItem, "path"> {
  const content = readFileSync(fullPath, "utf8");

  if (!content.startsWith("---")) {
    return {
      summary: null,
      readWhen: [],
      warnings: ["missing front matter"],
    };
  }

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return {
      summary: null,
      readWhen: [],
      warnings: ["unterminated front matter"],
    };
  }

  const frontMatter = content.slice(3, endIndex).trim();
  const lines = frontMatter.split("\n");

  let summaryLine: string | null = null;
  const readWhen: string[] = [];
  const warnings: string[] = [];
  let isCollectingReadWhen = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith(SUMMARY_KEY)) {
      summaryLine = line;
      isCollectingReadWhen = false;
      continue;
    }

    if (line.startsWith(READ_WHEN_KEY)) {
      isCollectingReadWhen = true;
      const inline = line.slice(READ_WHEN_KEY.length).trim();
      readWhen.push(...parseReadWhenInlineArray(inline, warnings));
      continue;
    }

    if (isCollectingReadWhen) {
      if (line.startsWith("- ")) {
        const hint = line.slice(2).trim();
        if (hint) {
          readWhen.push(hint);
        }
      } else if (line !== "") {
        isCollectingReadWhen = false;
      }
    }
  }

  if (!summaryLine) {
    warnings.push("summary key missing");
    return { summary: null, readWhen, warnings };
  }

  const summaryValue = summaryLine.slice(SUMMARY_KEY.length).trim();
  const normalized = normalizeSummary(summaryValue);

  if (!normalized) {
    warnings.push("summary is empty");
    return { summary: null, readWhen, warnings };
  }

  return { summary: normalized, readWhen, warnings };
}

export function listDocs(
  options: { cwd?: string; path?: string } = {}
): DocsListResult {
  const cwd = options.cwd ?? process.cwd();
  const target = getDocsTarget(options.path);
  const root = resolveDocsRoot(cwd, options.path);

  if (!existsSync(root)) {
    const warnings = [{ message: `No docs folder found at ${root}.` }];
    return {
      ok: true,
      target,
      root,
      rootPath: root,
      exists: false,
      entries: [],
      docs: [],
      warnings,
      warningCount: warnings.length,
    };
  }

  assertRootWithinCwd(cwd, root);

  const docs = walkMarkdownFiles(root).map((markdownPath) => ({
    path: markdownPath,
    ...extractMetadata(join(root, markdownPath)),
  }));
  const warnings = docs.flatMap((doc) =>
    doc.warnings.map((message) => ({ path: doc.path, message }))
  );

  return {
    ok: true,
    target,
    root,
    rootPath: root,
    exists: true,
    entries: docs,
    docs,
    warnings,
    warningCount: warnings.length,
  };
}

export function formatDocsList(result: DocsListResult): string {
  const lines = ["Listing all markdown files in docs folder:"];

  if (!result.exists) {
    lines.push(`No docs folder found at ${result.root}.`);
    return lines.join("\n");
  }

  for (const doc of result.docs) {
    if (doc.summary) {
      lines.push(`${doc.path} - ${doc.summary}`);
      if (doc.readWhen.length > 0) {
        lines.push(`  Read when: ${doc.readWhen.join("; ")}`);
      }
    } else {
      const reason =
        doc.warnings.length > 0 ? ` - [${doc.warnings.join("; ")}]` : "";
      lines.push(`${doc.path}${reason}`);
    }
  }

  lines.push(
    "",
    'Reminder: keep docs up to date as behavior changes. When your task matches any "Read when" hint above (React hooks, cache directives, database work, tests, etc.), read that doc before coding, and suggest new coverage when it is missing.'
  );

  return lines.join("\n");
}
