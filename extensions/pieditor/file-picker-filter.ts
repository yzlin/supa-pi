import * as path from "node:path";

import type { FileEntry } from "./file-picker-types.js";

export function isGlobPattern(query: string): boolean {
  return /[*?[\]]/.test(query);
}

export function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regex += "[^/]";
      i++;
    } else if (char === "[") {
      const end = pattern.indexOf("]", i);
      if (end !== -1) {
        regex += pattern.slice(i, end + 1);
        i = end + 1;
      } else {
        regex += "\\[";
        i++;
      }
    } else if (".+^${}()|\\".includes(char)) {
      regex += "\\" + char;
      i++;
    } else {
      regex += char;
      i++;
    }
  }

  return new RegExp(`^${regex}$`, "i");
}

function fuzzyScore(query: string, text: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();

  if (lowerText.includes(lowerQuery)) {
    return 100 + (lowerQuery.length / lowerText.length) * 50;
  }

  let score = 0;
  let queryIndex = 0;
  let consecutiveBonus = 0;

  for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIndex]) {
      score += 10 + consecutiveBonus;
      consecutiveBonus += 5;
      queryIndex++;
    } else {
      consecutiveBonus = 0;
    }
  }

  return queryIndex === lowerQuery.length ? score : 0;
}

function toDisplayPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}

export function withQuerySlash(relativePath: string, query: string): string {
  const displayPath = toDisplayPath(relativePath);
  return query.startsWith("/") ? `/${displayPath}` : displayPath;
}

export function resolveScopedFuzzyQuery(
  query: string
): { basePath: string; query: string } | null {
  const normalizedQuery = stripLeadingSlash(toDisplayPath(query));
  const slashIndex = normalizedQuery.lastIndexOf("/");
  if (slashIndex === -1) {
    return null;
  }

  return {
    basePath: normalizedQuery.slice(0, slashIndex + 1),
    query: normalizedQuery.slice(slashIndex + 1),
  };
}

export function scoreScopedEntry(
  filePath: string,
  query: string,
  isDirectory: boolean
): number {
  const normalizedPath = stripLeadingSlash(toDisplayPath(filePath)).replace(
    /\/$/,
    ""
  );
  const fileName = path.basename(normalizedPath);
  const lowerFileName = fileName.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();
  const lowerQuery = query.toLowerCase();

  let score = 0;
  if (lowerFileName === lowerQuery) score = 100;
  else if (lowerFileName.startsWith(lowerQuery)) score = 80;
  else if (lowerFileName.includes(lowerQuery)) score = 50;
  else if (lowerPath.includes(lowerQuery)) score = 30;

  if (isDirectory && score > 0) score += 10;
  return score;
}

function normalizeCompletionPath(value: string): string {
  return stripLeadingSlash(toDisplayPath(value)).replace(/\/$/, "");
}

function isPreferredEntry(entry: FileEntry, preferredPath: string): boolean {
  return (
    normalizeCompletionPath(
      withQuerySlash(entry.relativePath, preferredPath)
    ) === normalizeCompletionPath(preferredPath)
  );
}

function comparePreferredEntry(
  a: FileEntry,
  b: FileEntry,
  preferredPath?: string
): number {
  if (!preferredPath) return 0;
  const aPreferred = isPreferredEntry(a, preferredPath);
  const bPreferred = isPreferredEntry(b, preferredPath);
  if (aPreferred === bPreferred) return 0;
  return aPreferred ? -1 : 1;
}

export function filterEntries(
  entries: FileEntry[],
  query: string,
  preferredPath?: string
): FileEntry[] {
  if (!query.trim()) return entries;

  if (isGlobPattern(query)) {
    const regex = globToRegex(query);
    const filtered = entries.filter((entry) => {
      const displayPath = withQuerySlash(entry.relativePath, query);
      return (
        regex.test(entry.name) ||
        regex.test(entry.relativePath) ||
        regex.test(displayPath)
      );
    });
    return filtered.sort((a, b) => {
      const preferredComparison = comparePreferredEntry(a, b, preferredPath);
      if (preferredComparison !== 0) return preferredComparison;
      return a.relativePath.localeCompare(b.relativePath);
    });
  }

  const scopedQuery = resolveScopedFuzzyQuery(query);
  const scored = entries
    .map((entry) => {
      const displayPath = withQuerySlash(entry.relativePath, query);
      const baseScore = Math.max(
        fuzzyScore(query, entry.name),
        fuzzyScore(query, displayPath) * 0.9
      );
      const scopedScore =
        scopedQuery &&
        stripLeadingSlash(displayPath).startsWith(scopedQuery.basePath)
          ? scoreScopedEntry(displayPath, scopedQuery.query, entry.isDirectory)
          : 0;
      return {
        entry,
        score: Math.max(baseScore, scopedScore),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      const preferredComparison = comparePreferredEntry(
        a.entry,
        b.entry,
        preferredPath
      );
      if (preferredComparison !== 0) return preferredComparison;
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.relativePath.localeCompare(b.entry.relativePath);
    });

  return scored.map((item) => item.entry);
}
