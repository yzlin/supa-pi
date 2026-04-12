import * as fs from "node:fs";
import * as path from "node:path";

import { isWithinCwd } from "./file-picker-data.js";
import type { FileEntry } from "./file-picker-types.js";

const DEFAULT_MAX_PREVIEW_BYTES = 16 * 1024;

type PreviewKind = "empty" | "file" | "directory" | "binary" | "navigation";

export interface PickerPreviewData {
  kind: PreviewKind;
  title: string;
  details: string;
  lines: string[];
}

interface LoadPreviewDataOptions {
  cwdRoot: string;
  currentDir: string;
  entry?: FileEntry | null;
  maxLines?: number;
  maxBytes?: number;
}

function toDisplayPath(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function normalizePreviewLine(line: string): string {
  return line.replace(/\t/g, "  ");
}

function isBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return true;

  let suspiciousBytes = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) suspiciousBytes += 1;
  }

  return suspiciousBytes / buffer.length > 0.2;
}

function readFilePrefix(
  filePath: string,
  maxBytes: number
): { buffer: Buffer; truncated: boolean } {
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(handle, buffer, 0, maxBytes, 0);
    const stats = fs.fstatSync(handle);
    return {
      buffer: buffer.subarray(0, bytesRead),
      truncated: stats.size > bytesRead,
    };
  } finally {
    fs.closeSync(handle);
  }
}

function resolvePreviewTitle(
  relativePath: string,
  isDirectory: boolean
): string {
  const displayPath = toDisplayPath(relativePath);
  if (displayPath === ".") return "./";
  return isDirectory && !displayPath.endsWith("/")
    ? `${displayPath}/`
    : displayPath;
}

function buildDirectoryPreview(
  absolutePath: string,
  relativePath: string,
  maxLines: number
): PickerPreviewData {
  try {
    const items = fs
      .readdirSync(absolutePath, { withFileTypes: true })
      .map((item) => ({
        label: item.name + (item.isDirectory() ? "/" : ""),
        isDirectory: item.isDirectory(),
      }))
      .sort((left, right) => {
        if (left.isDirectory && !right.isDirectory) return -1;
        if (!left.isDirectory && right.isDirectory) return 1;
        return left.label.localeCompare(right.label);
      });

    const lineLimit = Math.max(1, maxLines);
    const lines = items.slice(0, lineLimit).map((item) => item.label);
    if (items.length > lineLimit) {
      lines.push(`… ${items.length - lineLimit} more`);
    }

    return {
      kind: "directory",
      title: resolvePreviewTitle(relativePath, true),
      details: `directory • ${formatCount(items.length, "item")}`,
      lines: lines.length > 0 ? lines : ["(empty directory)"],
    };
  } catch {
    return {
      kind: "directory",
      title: resolvePreviewTitle(relativePath, true),
      details: "directory",
      lines: ["Directory preview unavailable."],
    };
  }
}

function buildFilePreview(
  absolutePath: string,
  relativePath: string,
  maxLines: number,
  maxBytes: number
): PickerPreviewData {
  try {
    const stats = fs.statSync(absolutePath);
    const { buffer, truncated } = readFilePrefix(absolutePath, maxBytes);
    if (isBinaryBuffer(buffer)) {
      return {
        kind: "binary",
        title: resolvePreviewTitle(relativePath, false),
        details: `binary • ${formatByteSize(stats.size)}`,
        lines: [
          "Binary file preview unavailable.",
          "Attach to inspect with tools.",
        ],
      };
    }

    const previewText = buffer.toString("utf8").replace(/\r\n?/g, "\n");
    const previewLines = previewText.split("\n");
    const lineNumberWidth = Math.max(
      2,
      String(Math.max(previewLines.length, 1)).length
    );
    const lines = previewLines.slice(0, maxLines).map((line, index) => {
      const lineNumber = String(index + 1).padStart(lineNumberWidth, " ");
      return `${lineNumber} │ ${normalizePreviewLine(line)}`;
    });

    if (
      lines.length === 0 ||
      (lines.length === 1 && lines[0]?.endsWith("│ "))
    ) {
      lines.length = 0;
      lines.push("(empty file)");
    }

    if (previewLines.length > maxLines || truncated) {
      if (lines.length >= maxLines) {
        lines[maxLines - 1] = "… preview truncated";
      } else {
        lines.push("… preview truncated");
      }
    }

    return {
      kind: "file",
      title: resolvePreviewTitle(relativePath, false),
      details: `text • ${formatByteSize(stats.size)}${truncated ? " • truncated" : ""}`,
      lines,
    };
  } catch {
    return {
      kind: "file",
      title: resolvePreviewTitle(relativePath, false),
      details: "file",
      lines: ["File preview unavailable."],
    };
  }
}

export function loadPreviewData({
  cwdRoot,
  currentDir,
  entry,
  maxLines = 12,
  maxBytes = DEFAULT_MAX_PREVIEW_BYTES,
}: LoadPreviewDataOptions): PickerPreviewData {
  if (!entry) {
    return {
      kind: "empty",
      title: "Preview",
      details: "No matching file",
      lines: ["Search to preview a file or directory."],
    };
  }

  if (entry.name === ".." && entry.relativePath === "..") {
    const targetPath =
      currentDir === cwdRoot ? cwdRoot : path.dirname(currentDir);
    return {
      kind: "navigation",
      title: "..",
      details: `navigate • ${toDisplayPath(path.relative(cwdRoot, targetPath) || ".")}`,
      lines: [
        "Move up one level.",
        `Current: ${toDisplayPath(path.relative(cwdRoot, currentDir) || ".")}`,
      ],
    };
  }

  const absolutePath =
    entry.relativePath === "."
      ? cwdRoot
      : path.resolve(cwdRoot, entry.relativePath);
  const boundedMaxLines = Math.max(1, maxLines);

  if (!isWithinCwd(absolutePath, cwdRoot)) {
    return entry.isDirectory
      ? {
          kind: "directory",
          title: resolvePreviewTitle(entry.relativePath, true),
          details: "directory",
          lines: ["Directory preview unavailable."],
        }
      : {
          kind: "file",
          title: resolvePreviewTitle(entry.relativePath, false),
          details: "file",
          lines: ["File preview unavailable."],
        };
  }

  if (entry.isDirectory) {
    return buildDirectoryPreview(
      absolutePath,
      entry.relativePath,
      boundedMaxLines
    );
  }

  return buildFilePreview(
    absolutePath,
    entry.relativePath,
    boundedMaxLines,
    Math.max(1024, maxBytes)
  );
}
