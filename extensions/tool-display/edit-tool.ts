/*
 * Copied from `agent-stuff` by original author Armin Ronacher (mitsuhiko).
 * Source: https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/multi-edit.ts
 * Original license: Apache License 2.0.
 */

/**
 * Multi-Edit Extension — replaces the built-in `edit` tool.
 *
 * Supports all original parameters (path, oldText, newText) plus:
 * - `multi`: array of {path, oldText, newText} edits applied in sequence
 * - `patch`: Codex-style apply_patch payload
 *
 * When both top-level params and `multi` are provided, the top-level edit
 * is treated as an implicit first item prepended to the multi list.
 *
 * A preflight pass is performed before mutating files:
 * - multi/top-level mode: preflight via virtualized built-in edit tool
 * - patch mode: preflight by applying patch operations on a virtual filesystem
 */

import { Type } from "typebox";
import * as Diff from "diff";
import { constants } from "fs";
import { access as fsAccess, lstat as fsLstat, mkdir as fsMkdir, readFile as fsReadFile, realpath as fsRealpath, stat as fsStat, writeFile as fsWriteFile } from "fs/promises";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname, isAbsolute, resolve as resolvePath } from "path";

const MAX_DIFF_BYTES = 200_000;
const MAX_DIFF_LINES = 4_000;
const MAX_SYNC_DIFF_INPUT_BYTES = 150_000;
const MAX_SYNC_DIFF_INPUT_LINES = 3_000;
const MAX_PATCH_BYTES = 1_000_000;
const MAX_PATCH_LINES = 20_000;
const MAX_PATCH_OPS = 1_000;
const MAX_SAME_FILE_PATCH_UPDATES = 100;
const MAX_SAME_FILE_PATCH_UPDATE_BYTES = 1_000_000;
const MAX_PATCH_HUNK_SEARCH_COMPARISONS = 200_000;
const MAX_CLASSIC_FUZZY_SEARCH_COMPARISONS = 200_000;
const MAX_CLASSIC_EDITS = 1_000;
const MAX_CLASSIC_PAYLOAD_BYTES = 1_000_000;
const MAX_SAME_FILE_CLASSIC_EDITS = 100;
const MAX_SAME_FILE_CLASSIC_BYTES = 1_000_000;
const MAX_TARGET_FILE_BYTES = 10_000_000;
const MAX_TARGET_FILE_LINES = 200_000;
const MAX_STAGED_CONTENT_BYTES = 15_000_000;
const MAX_FILE_MUTATION_QUEUE_DEPTH = 50;
const MAX_CANONICALIZE_PATH_LENGTH = 4_096;
const MAX_CANONICALIZE_PATH_SEGMENTS = 256;
const MAX_CANONICALIZE_REALPATH_ATTEMPTS = 512;

const editItemSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute). Inherits from top-level path if omitted." })),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

const multiEditSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute)" })),
	oldText: Type.Optional(Type.String({ description: "Exact text to find and replace (must match exactly)" })),
	newText: Type.Optional(Type.String({ description: "New text to replace the old text with" })),
	multi: Type.Optional(
		Type.Array(editItemSchema, {
			description: "Multiple edits to apply in sequence. Each item has path, oldText, and newText.",
		}),
	),
	edits: Type.Optional(
		Type.Union([
			Type.Array(editItemSchema),
			Type.String(),
		], {
			description: "Built-in edit compatibility alias for multi. Each item has path, oldText, and newText.",
		}),
	),
	patch: Type.Optional(
		Type.String({
			description:
				"Codex-style apply_patch payload (*** Begin Patch ... *** End Patch). Mutually exclusive with path/oldText/newText/multi.",
		}),
	),
});

interface EditItem {
	path: string;
	oldText: string;
	newText: string;
}

interface EditResult {
	path: string;
	success: boolean;
	message: string;
	diff?: string;
	firstChangedLine?: number;
}

interface UpdateChunk {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

interface TextFormat {
	hasBom: boolean;
	lineEnding: "\n" | "\r\n";
}

function getTextFormat(content: string): TextFormat {
	return {
		hasBom: content.startsWith("\uFEFF"),
		lineEnding: content.includes("\r\n") ? "\r\n" : "\n",
	};
}

function stripBom(content: string): string {
	return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

function restoreTextFormat(content: string, format: TextFormat): string {
	const withLineEndings = format.lineEnding === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
	return format.hasBom ? `\uFEFF${withLineEndings}` : withLineEndings;
}

type PatchOperation =
	| { kind: "add"; path: string; contents: string }
	| { kind: "update"; path: string; chunks: UpdateChunk[] };

interface PatchOpResult {
	path: string;
	message: string;
	diff?: string;
	firstChangedLine?: number;
}

interface OriginalPatchFileState {
	existedBefore: boolean;
	path: string;
	rawContent: string;
	resultIndex: number;
}

function findFirstChangedLine(oldContent: string, newContent: string): number | undefined {
	if (oldContent === newContent) return undefined;
	let line = 1;
	let oldOffset = 0;
	let newOffset = 0;

	while (oldOffset < oldContent.length && newOffset < newContent.length) {
		const oldNext = oldContent.indexOf("\n", oldOffset);
		const newNext = newContent.indexOf("\n", newOffset);
		const oldEnd = oldNext === -1 ? oldContent.length : oldNext;
		const newEnd = newNext === -1 ? newContent.length : newNext;
		if (oldContent.slice(oldOffset, oldEnd) !== newContent.slice(newOffset, newEnd)) return line;
		if (oldNext === -1 || newNext === -1) break;
		oldOffset = oldNext + 1;
		newOffset = newNext + 1;
		line++;
	}

	return line + 1;
}

function countLinesBounded(content: string, maxLines: number): { count: number; capped: boolean } {
	if (content.length === 0) return { count: 1, capped: false };
	let count = 1;
	let offset = 0;
	while (count <= maxLines) {
		const next = content.indexOf("\n", offset);
		if (next === -1) return { count, capped: false };
		count++;
		offset = next + 1;
	}
	return { count, capped: true };
}

async function pathExistsNoFollow(absolutePath: string): Promise<boolean> {
	try {
		await fsLstat(absolutePath);
		return true;
	} catch (err: any) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return false;
		throw err;
	}
}

function generateDiffString(
	filePath: string,
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const estimatedInputBytes = Buffer.byteLength(oldContent, "utf-8") + Buffer.byteLength(newContent, "utf-8");
	const oldLineCount = countLinesBounded(oldContent, MAX_DIFF_LINES + 1);
	const newLineCount = countLinesBounded(newContent, MAX_DIFF_LINES + 1);
	const estimatedInputLines = oldLineCount.count + newLineCount.count;
	if (estimatedInputBytes > MAX_DIFF_BYTES || oldLineCount.capped || newLineCount.capped || estimatedInputLines > MAX_DIFF_LINES) {
		return {
			diff: `[diff omitted: input ${estimatedInputBytes} bytes / ${estimatedInputLines} lines exceeds limit of ${MAX_DIFF_BYTES} bytes / ${MAX_DIFF_LINES} lines]`,
			firstChangedLine: undefined,
		};
	}
	if (estimatedInputBytes > MAX_SYNC_DIFF_INPUT_BYTES || estimatedInputLines > MAX_SYNC_DIFF_INPUT_LINES) {
		return {
			diff: `[diff omitted: input ${estimatedInputBytes} bytes / ${estimatedInputLines} lines too large for synchronous diff generation]`,
			firstChangedLine: findFirstChangedLine(oldContent, newContent),
		};
	}

	const oldPath = oldContent === "" && newContent !== "" ? "/dev/null" : filePath;
	const newPath = newContent === "" && oldContent !== "" ? "/dev/null" : filePath;

	return {
		diff: Diff.createTwoFilesPatch(oldPath, newPath, oldContent, newContent, undefined, undefined, {
			context: contextLines,
		}),
		firstChangedLine: findFirstChangedLine(oldContent, newContent),
	};
}

function capDiff(diff: string): { diff: string; capped: boolean } {
	if (diff.startsWith("[diff omitted:")) {
		return { diff, capped: true };
	}

	const byteLength = Buffer.byteLength(diff, "utf-8");
	const lineCount = diff.split("\n").length;
	if (byteLength <= MAX_DIFF_BYTES && lineCount <= MAX_DIFF_LINES) {
		return { diff, capped: false };
	}

	return {
		diff: `[diff omitted: ${byteLength} bytes / ${lineCount} lines exceeds limit of ${MAX_DIFF_BYTES} bytes / ${MAX_DIFF_LINES} lines]`,
		capped: true,
	};
}

function buildCombinedDiff(results: Array<{ diff?: string }>): { diff: string; capped: boolean } {
	const parts: string[] = [];
	let bytes = 0;
	let lines = 0;
	for (const result of results) {
		if (!result.diff) continue;
		const separator = parts.length === 0 ? "" : "\n";
		const nextBytes = Buffer.byteLength(separator, "utf-8") + Buffer.byteLength(result.diff, "utf-8");
		const nextLines = (separator ? 1 : 0) + result.diff.split("\n").length;
		if (bytes + nextBytes > MAX_DIFF_BYTES || lines + nextLines > MAX_DIFF_LINES || result.diff.startsWith("[diff omitted:")) {
			return {
				diff: `[diff omitted: combined diff exceeds limit of ${MAX_DIFF_BYTES} bytes / ${MAX_DIFF_LINES} lines]`,
				capped: true,
			};
		}
		parts.push(result.diff);
		bytes += nextBytes;
		lines += nextLines;
	}
	return { diff: parts.join("\n"), capped: false };
}

interface DiffBudget {
	capped: boolean;
	bytes: number;
	lines: number;
}

function createDiffBudget(): DiffBudget {
	return { capped: false, bytes: 0, lines: 0 };
}

function recordDiffWithinBudget(diff: string, budget?: DiffBudget): string | undefined {
	if (!budget) return diff;
	if (budget.capped) return undefined;
	const nextBytes = Buffer.byteLength(diff, "utf-8");
	const nextLines = diff.split("\n").length;
	if (diff.startsWith("[diff omitted:")) {
		budget.capped = true;
		return diff;
	}
	if (budget.bytes + nextBytes > MAX_DIFF_BYTES || budget.lines + nextLines > MAX_DIFF_LINES) {
		budget.capped = true;
		return `[diff omitted: combined diff exceeds limit of ${MAX_DIFF_BYTES} bytes / ${MAX_DIFF_LINES} lines]`;
	}
	budget.bytes += nextBytes;
	budget.lines += nextLines;
	return diff;
}

interface FileMutationQueueEntry {
	depth: number;
	tail: Promise<void>;
}

const fileMutationQueues = new Map<string, FileMutationQueueEntry>();

interface CanonicalizeMutationPathContext {
	cache: Map<string, string>;
	realpathAttempts: number;
}

function createCanonicalizeMutationPathContext(): CanonicalizeMutationPathContext {
	return { cache: new Map(), realpathAttempts: 0 };
}

async function canonicalizeMutationPath(path: string, context = createCanonicalizeMutationPathContext()): Promise<string> {
	let current = resolvePath(path);
	if (current.length > MAX_CANONICALIZE_PATH_LENGTH || current.split(/[\\/]+/).length > MAX_CANONICALIZE_PATH_SEGMENTS) {
		throw new Error(`Path exceeds maximum canonicalization size of ${MAX_CANONICALIZE_PATH_LENGTH} characters / ${MAX_CANONICALIZE_PATH_SEGMENTS} segments`);
	}
	const cached = context.cache.get(current);
	if (cached) return cached;
	const original = current;
	const missingParts: string[] = [];

	while (true) {
		const currentCached = context.cache.get(current);
		if (currentCached) {
			const result = missingParts.length === 0 ? currentCached : resolvePath(currentCached, ...missingParts.reverse());
			context.cache.set(original, result);
			return result;
		}
		context.realpathAttempts++;
		if (context.realpathAttempts > MAX_CANONICALIZE_REALPATH_ATTEMPTS) {
			throw new Error(`Path canonicalization exceeds maximum realpath attempts of ${MAX_CANONICALIZE_REALPATH_ATTEMPTS}`);
		}
		try {
			const real = await fsRealpath(current);
			context.cache.set(current, real);
			const result = missingParts.length === 0 ? real : resolvePath(real, ...missingParts.reverse());
			context.cache.set(original, result);
			return result;
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				throw err;
			}
			const parent = dirname(current);
			if (parent === current) {
				const result = resolvePath(path);
				context.cache.set(original, result);
				return result;
			}
			missingParts.push(current.slice(parent.length + 1));
			current = parent;
		}
	}
}

export async function withFileMutationQueue<T>(
	paths: string[],
	fn: () => Promise<T>,
	signal?: AbortSignal,
	canonicalizeContext = createCanonicalizeMutationPathContext(),
): Promise<T> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const canonicalPaths: string[] = [];
	for (const path of paths) {
		if (signal?.aborted) throw new Error("Operation aborted");
		canonicalPaths.push(await canonicalizeMutationPath(path, canonicalizeContext));
	}
	const keys = [...new Set(canonicalPaths)].sort();
	for (const key of keys) {
		const entry = fileMutationQueues.get(key);
		if (entry && entry.depth >= MAX_FILE_MUTATION_QUEUE_DEPTH) {
			throw new Error(`File mutation queue for ${key} exceeds maximum depth of ${MAX_FILE_MUTATION_QUEUE_DEPTH}`);
		}
	}

	const previousEntries = keys.map((key) => fileMutationQueues.get(key));
	const previous = Promise.all(previousEntries.map((entry) => entry?.tail.catch(() => undefined)));

	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const current = previous.then(() => gate);

	for (const key of keys) {
		const entry = fileMutationQueues.get(key);
		fileMutationQueues.set(key, { depth: (entry?.depth ?? 0) + 1, tail: current });
	}

	let abortHandler: (() => void) | undefined;
	const abortPromise = signal ? new Promise<never>((_, reject) => {
		abortHandler = () => reject(new Error("Operation aborted"));
		signal.addEventListener("abort", abortHandler, { once: true });
	}) : undefined;

	try {
		if (signal?.aborted) throw new Error("Operation aborted");
		await (abortPromise ? Promise.race([previous, abortPromise]) : previous);
		if (signal?.aborted) throw new Error("Operation aborted");
		return await fn();
	} finally {
		if (abortHandler) {
			signal?.removeEventListener("abort", abortHandler);
		}
		release();
		for (const [index, key] of keys.entries()) {
			const entry = fileMutationQueues.get(key);
			if (!entry) continue;
			if (entry.tail === current) {
				const depth = entry.depth - 1;
				const previousEntry = previousEntries[index];
				if (depth > 0 && previousEntry) {
					fileMutationQueues.set(key, { depth, tail: previousEntry.tail });
				} else {
					fileMutationQueues.delete(key);
				}
			} else {
				entry.depth--;
			}
		}
	}
}

function pathsHaveAncestorDescendantConflict(a: string, b: string): boolean {
	let current = dirname(a);
	while (current !== a) {
		if (current === b) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
	return false;
}

interface PatchApplyOptions {
	collectDiff?: boolean;
	diffBudget?: DiffBudget;
	allowPatchAdd?: boolean;
	canonicalizeContext?: CanonicalizeMutationPathContext;
}

interface Workspace {
	readText: (absolutePath: string) => Promise<string>;
	writeText: (absolutePath: string, content: string, signal?: AbortSignal) => Promise<void>;
	writeTextExclusive: (absolutePath: string, content: string, signal?: AbortSignal) => Promise<void>;
	exists: (absolutePath: string) => Promise<boolean>;
	/** Check that the file is writable. Rejects if not. No-op on virtual workspaces. */
	checkWriteAccess: (absolutePath: string) => Promise<void>;
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizePathUnicodeSpaces(filePath: string): string {
	return filePath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}

export function resolveToCwd(cwd: string, filePath: string): string {
	let resolvedPath = normalizePathUnicodeSpaces(filePath);
	if (resolvedPath.startsWith("@")) {
		resolvedPath = resolvedPath.slice(1);
	}
	if (resolvedPath.startsWith("file://")) {
		return resolvePath(normalizePathUnicodeSpaces(fileURLToPath(resolvedPath)));
	}
	if (resolvedPath === "~" || resolvedPath.startsWith("~/")) {
		resolvedPath = resolvePath(homedir(), resolvedPath.slice(2));
	}
	return isAbsolute(resolvedPath) ? resolvePath(resolvedPath) : resolvePath(cwd, resolvedPath);
}

function resolvePatchPath(cwd: string, filePath: string): string {
	const trimmed = filePath.trim();
	if (!trimmed) {
		throw new Error("Patch path cannot be empty");
	}
	return resolveToCwd(cwd, trimmed);
}

function ensureTrailingNewline(content: string): string {
	return content.endsWith("\n") ? content : `${content}\n`;
}

function normaliseLineForFuzzyMatch(s: string): string {
	return s
		.trimEnd()
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

interface SearchBudget {
	remaining: number;
}

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean, budget: SearchBudget): number | undefined {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return undefined;

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const searchEnd = lines.length - pattern.length;

	const exactEqual = (a: string, b: string) => a === b;
	const rstripEqual = (a: string, b: string) => a.trimEnd() === b.trimEnd();
	const fuzzyEqual = (a: string, b: string) => normaliseLineForFuzzyMatch(a) === normaliseLineForFuzzyMatch(b);

	const passes = [exactEqual, rstripEqual, fuzzyEqual];

	for (const eq of passes) {
		let found: number | undefined;
		let matches = 0;
		for (let i = searchStart; i <= searchEnd; i++) {
			let ok = true;
			for (let p = 0; p < pattern.length; p++) {
				budget.remaining--;
				if (budget.remaining < 0) {
					throw new Error(`Patch hunk search exceeded maximum budget of ${MAX_PATCH_HUNK_SEARCH_COMPARISONS} line comparisons`);
				}
				if (!eq(lines[i + p], pattern[p])) {
					ok = false;
					break;
				}
			}
			if (ok) {
				found = i;
				matches++;
				if (matches > 1) {
					throw new Error("Patch hunk matched multiple locations. Add more context to make it unique.");
				}
			}
		}
		if (found !== undefined) return found;
	}

	return undefined;
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
	const next = [...lines];

	for (const [start, oldLen, newSegment] of [...replacements].sort((a, b) => b[0] - a[0] || b[1] - a[1])) {
		next.splice(start, oldLen, ...newSegment);
	}

	return next;
}

function deriveUpdatedContent(filePath: string, currentContent: string, chunks: UpdateChunk[], searchBudget: SearchBudget): string {
	const originalHadFinalNewline = currentContent.endsWith("\n");
	const targetLineCount = countLinesBounded(currentContent, MAX_TARGET_FILE_LINES + 1);
	if (targetLineCount.capped || targetLineCount.count > MAX_TARGET_FILE_LINES) {
		throw new Error(`Target file ${filePath} exceeds maximum size of ${MAX_TARGET_FILE_LINES} lines`);
	}
	const originalLines = currentContent.split("\n");
	if (originalLines[originalLines.length - 1] === "") {
		originalLines.pop();
	}

	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;
	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const ctxIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false, searchBudget);
			if (ctxIndex === undefined) {
				throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
			}
			lineIndex = ctxIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			replacements.push([lineIndex, 0, [...chunk.newLines]]);
			continue;
		}

		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;

		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, searchBudget);
		if (found === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice[newSlice.length - 1] === "") {
				newSlice = newSlice.slice(0, -1);
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, searchBudget);
		}

		if (found === undefined) {
			throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		}

		replacements.push([found, pattern.length, [...newSlice]]);
		lineIndex = found + pattern.length;
	}

	const ordered = [...replacements].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	for (let i = 1; i < ordered.length; i++) {
		const previous = ordered[i - 1];
		const current = ordered[i];
		const isSameStartInsertAfterReplacement = current[0] === previous[0] && current[1] === 0 && previous[1] > 0;
		if (current[0] < previous[0] + previous[1] && !isSameStartInsertAfterReplacement) {
			throw new Error(`Overlapping patch hunks for ${filePath} cannot be applied safely.`);
		}
	}

	const newLines = applyReplacements(originalLines, replacements);
	if (originalHadFinalNewline && newLines[newLines.length - 1] !== "") {
		newLines.push("");
	}
	return newLines.join("\n");
}

function parseUpdateChunk(
	lines: string[],
	startIndex: number,
	lastContentLine: number,
	allowMissingContext: boolean,
): { chunk: UpdateChunk; nextIndex: number } {
	let i = startIndex;
	let changeContext: string | undefined;
	const first = lines[i].trimEnd();

	if (first === "@@") {
		i++;
	} else if (first.startsWith("@@ ")) {
		changeContext = first.slice(3);
		i++;
	} else if (!allowMissingContext) {
		throw new Error(`Expected update hunk to start with @@ context marker, got: '${lines[i]}'`);
	}

	const oldLines: string[] = [];
	const newLines: string[] = [];
	let parsed = 0;
	let isEndOfFile = false;

	while (i <= lastContentLine) {
		const raw = lines[i];
		const trimmed = raw.trimEnd();

		if (trimmed === "*** End of File") {
			if (parsed === 0) {
				throw new Error("Update hunk does not contain any lines");
			}
			isEndOfFile = true;
			i++;
			break;
		}

		if (parsed > 0 && (trimmed.startsWith("@@") || trimmed.startsWith("*** "))) {
			break;
		}

		if (raw.length === 0) {
			oldLines.push("");
			newLines.push("");
			parsed++;
			i++;
			continue;
		}

		const marker = raw[0];
		const body = raw.slice(1);
		if (marker === " ") {
			oldLines.push(body);
			newLines.push(body);
		} else if (marker === "-") {
			oldLines.push(body);
		} else if (marker === "+") {
			newLines.push(body);
		} else if (parsed === 0) {
			throw new Error(
				`Unexpected line found in update hunk: '${raw}'. Every line should start with ' ', '+', or '-'.`,
			);
		} else {
			break;
		}

		parsed++;
		i++;
	}

	if (parsed === 0) {
		throw new Error("Update hunk does not contain any lines");
	}

	if (oldLines.length === 0 && changeContext === undefined) {
		throw new Error("Update hunk must include old/context lines or a context marker before adding new lines");
	}

	return {
		chunk: { changeContext, oldLines, newLines, isEndOfFile },
		nextIndex: i,
	};
}

function parsePatch(patchText: string): PatchOperation[] {
	const patchBytes = Buffer.byteLength(patchText, "utf-8");
	if (patchBytes > MAX_PATCH_BYTES) {
		throw new Error(`Patch exceeds maximum size of ${MAX_PATCH_BYTES} bytes`);
	}
	const normalizedPatchText = normalizeToLF(patchText);
	const lineCount = countLinesBounded(normalizedPatchText, MAX_PATCH_LINES + 1);
	if (lineCount.capped || lineCount.count > MAX_PATCH_LINES) {
		throw new Error(`Patch exceeds maximum size of ${MAX_PATCH_LINES} lines`);
	}
	const lines = normalizedPatchText.trim().split("\n");
	if (lines.length < 2) {
		throw new Error("Patch is empty or invalid");
	}
	if (lines[0].trim() !== "*** Begin Patch") {
		throw new Error("The first line of the patch must be '*** Begin Patch'");
	}
	if (lines[lines.length - 1].trim() !== "*** End Patch") {
		throw new Error("The last line of the patch must be '*** End Patch'");
	}

	const operations: PatchOperation[] = [];
	let i = 1;
	const lastContentLine = lines.length - 2;

	while (i <= lastContentLine) {
		if (lines[i].trim() === "") {
			i++;
			continue;
		}

		const line = lines[i].trim();
		if (line.startsWith("*** Add File: ")) {
			if (operations.length >= MAX_PATCH_OPS) {
				throw new Error(`Patch exceeds maximum operation count of ${MAX_PATCH_OPS}`);
			}
			const path = line.slice("*** Add File: ".length);
			i++;
			const contentLines: string[] = [];
			while (i <= lastContentLine) {
				const next = lines[i];
				if (next.trim().startsWith("*** ")) break;
				if (!next.startsWith("+")) {
					throw new Error(`Invalid add-file line '${next}'. Add file lines must start with '+'`);
				}
				contentLines.push(next.slice(1));
				i++;
			}
			operations.push({ kind: "add", path, contents: contentLines.length > 0 ? `${contentLines.join("\n")}\n` : "" });
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			throw new Error("Patch delete operations are not supported. Repo guardrail forbids hard deletes.");
		}

		if (line.startsWith("*** Update File: ")) {
			if (operations.length >= MAX_PATCH_OPS) {
				throw new Error(`Patch exceeds maximum operation count of ${MAX_PATCH_OPS}`);
			}
			const path = line.slice("*** Update File: ".length);
			i++;

			if (i <= lastContentLine && lines[i].trim().startsWith("*** Move to: ")) {
				throw new Error("Patch move operations (*** Move to:) are not supported.");
			}

			const chunks: UpdateChunk[] = [];
			while (i <= lastContentLine) {
				if (lines[i].trim() === "") {
					i++;
					continue;
				}
				if (lines[i].trim().startsWith("*** ")) {
					break;
				}

				const parsed = parseUpdateChunk(lines, i, lastContentLine, chunks.length === 0);
				chunks.push(parsed.chunk);
				i = parsed.nextIndex;
			}

			if (chunks.length === 0) {
				throw new Error(`Update file hunk for path '${path}' is empty`);
			}

			operations.push({ kind: "update", path, chunks });
			continue;
		}

		throw new Error(
			`'${line}' is not a valid hunk header. Valid headers: '*** Add File:', '*** Delete File:', '*** Update File:'`,
		);
	}

	if (operations.length === 0) {
		throw new Error("Patch contains no operations.");
	}

	return operations;
}

function createRealWorkspace(): Workspace {
	return {
		readText: async (absolutePath: string) => {
			const stats = await fsStat(absolutePath);
			if (!stats.isFile()) {
				throw new Error(`Target path ${absolutePath} is not a regular file`);
			}
			if (stats.size > MAX_TARGET_FILE_BYTES) {
				throw new Error(`Target file ${absolutePath} exceeds maximum size of ${MAX_TARGET_FILE_BYTES} bytes`);
			}
			return fsReadFile(absolutePath, "utf-8");
		},
		writeText: (absolutePath: string, content: string, signal?: AbortSignal) => fsWriteFile(absolutePath, content, { encoding: "utf-8", signal }),
		writeTextExclusive: async (absolutePath: string, content: string, signal?: AbortSignal) => {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (await pathExistsNoFollow(absolutePath)) {
				throw new Error(`Add file target already exists: ${absolutePath}`);
			}
			await fsMkdir(dirname(absolutePath), { recursive: true });
			if (signal?.aborted) throw new Error("Operation aborted");
			await fsWriteFile(absolutePath, content, { encoding: "utf-8", flag: "wx", signal });
		},
		exists: pathExistsNoFollow,
		checkWriteAccess: (absolutePath: string) => fsAccess(absolutePath, constants.R_OK | constants.W_OK),
	};
}

function createStagingWorkspace(base: Workspace): { workspace: Workspace; commit: (signal?: AbortSignal) => Promise<void> } {
	const writes = new Map<string, { content: string; exclusive: boolean }>();
	let stagedContentBytes = 0;
	function stageWrite(absolutePath: string, content: string, exclusive: boolean): void {
		const previous = writes.get(absolutePath);
		const previousBytes = previous ? Buffer.byteLength(previous.content, "utf-8") : 0;
		const nextBytes = Buffer.byteLength(content, "utf-8");
		const nextTotal = stagedContentBytes - previousBytes + nextBytes;
		if (nextTotal > MAX_STAGED_CONTENT_BYTES) {
			throw new Error(`Staged edit content exceeds maximum size of ${MAX_STAGED_CONTENT_BYTES} bytes`);
		}
		writes.set(absolutePath, { content, exclusive: previous?.exclusive || exclusive });
		stagedContentBytes = nextTotal;
	}
	return {
		workspace: {
			readText: async (absolutePath) => writes.get(absolutePath)?.content ?? await base.readText(absolutePath),
			writeText: async (absolutePath, content) => {
				stageWrite(absolutePath, content, false);
			},
			writeTextExclusive: async (absolutePath, content) => {
				if (writes.has(absolutePath) || await base.exists(absolutePath)) {
					throw new Error(`Add file target already exists: ${absolutePath}`);
				}
				stageWrite(absolutePath, content, true);
			},
			exists: async (absolutePath) => writes.has(absolutePath) || await base.exists(absolutePath),
			checkWriteAccess: (absolutePath) => base.checkWriteAccess(absolutePath),
		},
		commit: async (signal) => {
			if (signal?.aborted) throw new Error("Operation aborted");
			for (const [absolutePath, write] of writes) {
				if (write.exclusive && await base.exists(absolutePath)) {
					throw new Error(`Add file target already exists: ${absolutePath}`);
				}
			}
			if (signal?.aborted) throw new Error("Operation aborted");
			for (const [absolutePath, write] of writes) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (write.exclusive) {
					await base.writeTextExclusive(absolutePath, write.content);
				} else {
					await base.writeText(absolutePath, write.content);
				}
			}
		},
	};
}

function countOccurrences(content: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let offset = 0;
	while (true) {
		const index = content.indexOf(needle, offset);
		if (index === -1) return count;
		count++;
		offset = index + needle.length;
	}
}

function normaliseTextForFuzzyMatch(text: string): string {
	return text.split("\n").map(normaliseLineForFuzzyMatch).join("\n");
}

function findClassicMatch(
	content: string,
	oldText: string,
	budget: SearchBudget,
	normalizedContent?: string,
): { start: number; end: number; occurrences: number } {
	const exactOccurrences = countOccurrences(content, oldText);
	if (exactOccurrences !== 0) {
		const fuzzyOldText = normaliseTextForFuzzyMatch(oldText);
		const fuzzyOccurrences = countOccurrences(normalizedContent ?? normaliseTextForFuzzyMatch(content), fuzzyOldText);
		const start = content.indexOf(oldText);
		return { start, end: start + oldText.length, occurrences: Math.max(exactOccurrences, fuzzyOccurrences) };
	}

	const oldLines = oldText.split("\n");
	const contentLines = content.split("\n");
	const lineStarts: number[] = [];
	let offset = 0;
	for (const line of contentLines) {
		lineStarts.push(offset);
		offset += line.length + 1;
	}

	const matches: Array<{ start: number; end: number }> = [];
	const lineEquals = [
		(a: string, b: string) => a.trimEnd() === b.trimEnd(),
		(a: string, b: string) => normaliseLineForFuzzyMatch(a) === normaliseLineForFuzzyMatch(b),
	];

	for (const equals of lineEquals) {
		matches.length = 0;
		for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
			let ok = true;
			for (let j = 0; j < oldLines.length; j++) {
				budget.remaining--;
				if (budget.remaining < 0) {
					throw new Error(`Classic fuzzy search exceeded maximum budget of ${MAX_CLASSIC_FUZZY_SEARCH_COMPARISONS} line comparisons`);
				}
				if (!equals(contentLines[i + j], oldLines[j])) {
					ok = false;
					break;
				}
			}
			if (ok) {
				const lastLine = i + oldLines.length - 1;
				matches.push({ start: lineStarts[i], end: lineStarts[lastLine] + contentLines[lastLine].length });
			}
		}
		if (matches.length > 0) {
			return { start: matches[0].start, end: matches[0].end, occurrences: matches.length };
		}
	}

	return { start: -1, end: -1, occurrences: 0 };
}

async function checkAddWriteAccess(absolutePath: string, displayPath: string): Promise<void> {
	if (await pathExistsNoFollow(absolutePath)) {
		throw new Error(`Add file target already exists: ${displayPath}`);
	}

	let current = dirname(absolutePath);
	while (true) {
		try {
			const stats = await fsLstat(current);
			if (!stats.isDirectory()) {
				throw new Error(`Add file parent is not a directory: ${current}`);
			}
			await fsAccess(current, constants.W_OK | constants.X_OK);
			return;
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				throw err;
			}
			const parent = dirname(current);
			if (parent === current) throw new Error(`Add file parent is not writable: ${dirname(absolutePath)}`);
			current = parent;
		}
	}
}

async function applyPatchOperations(
	ops: PatchOperation[],
	workspace: Workspace,
	cwd: string,
	signal?: AbortSignal,
	options?: PatchApplyOptions,
): Promise<PatchOpResult[]> {
	const results: PatchOpResult[] = [];
	const collectDiff = options?.collectDiff ?? false;
	const diffBudget = options?.diffBudget;
	const canonicalizeContext = options?.canonicalizeContext ?? createCanonicalizeMutationPathContext();
	const searchBudget = { remaining: MAX_PATCH_HUNK_SEARCH_COMPARISONS };
	const stagedAdds = new Set<string>();
	const patchUpdateCounts = new Map<string, number>();
	const originalFileStates = new Map<string, OriginalPatchFileState>();

	for (const op of ops) {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		if (op.kind === "add") {
			if (options?.allowPatchAdd === false) {
				throw new Error("Patch Add File requires the write tool to be enabled.");
			}
			const abs = await canonicalizeMutationPath(resolvePatchPath(cwd, op.path), canonicalizeContext);
			for (const stagedAdd of stagedAdds) {
				if (pathsHaveAncestorDescendantConflict(abs, stagedAdd) || pathsHaveAncestorDescendantConflict(stagedAdd, abs)) {
					throw new Error(`Add file target conflicts with another staged add: ${op.path}`);
				}
			}
			await checkAddWriteAccess(abs, op.path);
			if (stagedAdds.has(abs) || (await workspace.exists(abs))) {
				throw new Error(`Add file target already exists: ${op.path}`);
			}
			stagedAdds.add(abs);
			const newText = op.contents === "" ? "" : ensureTrailingNewline(op.contents);
			originalFileStates.set(abs, { existedBefore: false, path: op.path, rawContent: "", resultIndex: results.length });
			await workspace.writeTextExclusive(abs, newText);
			results.push({ path: op.path, message: `Added file ${op.path}.` });
			continue;
		}

		const sourceAbs = await canonicalizeMutationPath(resolvePatchPath(cwd, op.path), canonicalizeContext);
		if (!stagedAdds.has(sourceAbs)) {
			await workspace.checkWriteAccess(sourceAbs);
		}
		const sourceRawText = await workspace.readText(sourceAbs);
		const previousUpdates = patchUpdateCounts.get(sourceAbs) ?? 0;
		if (previousUpdates >= MAX_SAME_FILE_PATCH_UPDATES) {
			throw new Error(`Too many same-file patch updates for ${op.path}: maximum is ${MAX_SAME_FILE_PATCH_UPDATES}`);
		}
		if (previousUpdates > 0 && Buffer.byteLength(sourceRawText, "utf-8") > MAX_SAME_FILE_PATCH_UPDATE_BYTES) {
			throw new Error(`Repeated same-file patch update target ${op.path} exceeds maximum size of ${MAX_SAME_FILE_PATCH_UPDATE_BYTES} bytes`);
		}
		patchUpdateCounts.set(sourceAbs, previousUpdates + 1);
		if (!originalFileStates.has(sourceAbs)) {
			originalFileStates.set(sourceAbs, { existedBefore: true, path: op.path, rawContent: sourceRawText, resultIndex: results.length });
		}
		const textFormat = getTextFormat(sourceRawText);
		const sourceText = normalizeToLF(stripBom(sourceRawText));
		const updated = restoreTextFormat(deriveUpdatedContent(op.path, sourceText, op.chunks, searchBudget), textFormat);
		if (updated === sourceRawText) {
			throw new Error(`Patch update produced no changes for ${op.path}.`);
		}

		await workspace.writeText(sourceAbs, updated);
		results.push({ path: op.path, message: `Updated ${op.path}.` });
	}

	for (const [absolutePath, original] of originalFileStates) {
		const finalRawContent = await workspace.readText(absolutePath);
		if (original.existedBefore && finalRawContent === original.rawContent) {
			throw new Error(`Patch updates produced no net changes for ${original.path}.`);
		}
		if (collectDiff && !diffBudget?.capped) {
			const diffResult = generateDiffString(
				original.path,
				normalizeToLF(stripBom(original.rawContent)),
				normalizeToLF(stripBom(finalRawContent)),
			);
			results[original.resultIndex].diff = recordDiffWithinBudget(diffResult.diff, diffBudget);
			results[original.resultIndex].firstChangedLine = diffResult.firstChangedLine;
		}
	}

	return results;
}

/**
 * Apply a list of classic edits (path/oldText/newText) sequentially via a Workspace.
 *
 * Same-file edits apply in the declared order against the current file content.
 */
async function applyClassicEdits(
	edits: EditItem[],
	workspace: Workspace,
	cwd: string,
	signal?: AbortSignal,
	options?: { collectDiff?: boolean; diffBudget?: DiffBudget; canonicalizeContext?: CanonicalizeMutationPathContext },
): Promise<EditResult[]> {
	const collectDiff = options?.collectDiff ?? false;
	const diffBudget = options?.diffBudget;
	const canonicalizeContext = options?.canonicalizeContext ?? createCanonicalizeMutationPathContext();
	const fuzzyBudget = { remaining: MAX_CLASSIC_FUZZY_SEARCH_COMPARISONS };

	// Group edits by resolved absolute path, preserving order.
	const fileGroups = new Map<string, { index: number; edit: EditItem }[]>();
	const editOrder: string[] = []; // track insertion order of keys

	for (let i = 0; i < edits.length; i++) {
		const resolved = resolveToCwd(cwd, edits[i].path);
		const abs = await canonicalizeMutationPath(resolved, canonicalizeContext);
		if (!fileGroups.has(abs)) {
			fileGroups.set(abs, []);
			editOrder.push(abs);
		}
		fileGroups.get(abs)!.push({ index: i, edit: edits[i] });
	}

	const results: EditResult[] = new Array(edits.length);

	// Verify write access to all target files before mutating anything.
	for (const absPath of editOrder) {
		await workspace.checkWriteAccess(absPath);
	}

	for (const absPath of editOrder) {
		const group = fileGroups.get(absPath)!;

		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const originalRawContent = await workspace.readText(absPath);
		const textFormat = getTextFormat(originalRawContent);
		const originalContent = normalizeToLF(stripBom(originalRawContent));
		const originalLineCount = countLinesBounded(originalContent, MAX_TARGET_FILE_LINES + 1);
		if (originalLineCount.capped || originalLineCount.count > MAX_TARGET_FILE_LINES) {
			throw new Error(`Target file ${group[0].edit.path} exceeds maximum size of ${MAX_TARGET_FILE_LINES} lines`);
		}

		if (group.length > MAX_SAME_FILE_CLASSIC_EDITS) {
			throw new Error(`Too many same-file edits for ${group[0].edit.path}: maximum is ${MAX_SAME_FILE_CLASSIC_EDITS}`);
		}
		if (group.length > 1 && Buffer.byteLength(originalContent, "utf-8") > MAX_SAME_FILE_CLASSIC_BYTES) {
			throw new Error(`Same-file batch edit target ${group[0].edit.path} exceeds maximum size of ${MAX_SAME_FILE_CLASSIC_BYTES} bytes`);
		}

		let content = originalContent;

		for (const { index, edit } of group) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const oldText = normalizeToLF(edit.oldText);
			const newText = normalizeToLF(edit.newText);

			const match = findClassicMatch(content, oldText, fuzzyBudget);
			if (match.occurrences > 1) {
				throw new Error(
					`Found ${match.occurrences} matches for oldText in ${edit.path}. The old text must be unique before editing.`,
				);
			}

			if (match.start === -1) {
				results[index] = {
					path: edit.path,
					success: false,
					message: `Could not find the exact text in ${edit.path}. The old text must match exactly including all whitespace and newlines.`,
				};
				// Fill remaining edits in this group as skipped.
				const filled = Array.from({ length: edits.length }, (_, i) => results[i]).filter(Boolean);
				throw new Error(formatResults(filled, edits.length));
			}

			content = content.slice(0, match.start) + newText + content.slice(match.end);

			results[index] = {
				path: edit.path,
				success: true,
				message: `Edited ${edit.path}.`,
			};
		}

		if (content === originalContent) {
			throw new Error(`Edit produced no changes for ${group[0].edit.path}.`);
		}

		await workspace.writeText(absPath, restoreTextFormat(content, textFormat));

		// Generate a single diff for all edits to this file; attach to first edit.
		if (collectDiff && !diffBudget?.capped) {
			const diffResult = generateDiffString(group[0].edit.path, originalContent, content);
			const firstIdx = group[0].index;
			results[firstIdx].diff = recordDiffWithinBudget(diffResult.diff, diffBudget);
			results[firstIdx].firstChangedLine = diffResult.firstChangedLine;
		}
	}

	return results;
}

function validateClassicEditBatch(edits: EditItem[]): void {
	if (edits.length > MAX_CLASSIC_EDITS) {
		throw new Error(`Too many classic edits: maximum is ${MAX_CLASSIC_EDITS}`);
	}

	let payloadBytes = 2;
	for (const edit of edits) {
		payloadBytes += Buffer.byteLength(edit.path, "utf-8") + Buffer.byteLength(edit.oldText, "utf-8") + Buffer.byteLength(edit.newText, "utf-8") + 32;
		if (payloadBytes > MAX_CLASSIC_PAYLOAD_BYTES) {
			throw new Error(`Classic edit payload exceeds maximum size of ${MAX_CLASSIC_PAYLOAD_BYTES} bytes`);
		}
	}
}

function validateClassicInputCount(count: number): void {
	if (count > MAX_CLASSIC_EDITS) {
		throw new Error(`Too many classic edits: maximum is ${MAX_CLASSIC_EDITS}`);
	}
}

function validateClassicPayloadString(input: string): void {
	if (Buffer.byteLength(input, "utf-8") > MAX_CLASSIC_PAYLOAD_BYTES) {
		throw new Error(`Classic edit payload exceeds maximum size of ${MAX_CLASSIC_PAYLOAD_BYTES} bytes`);
	}
}

async function applyBuiltInEdits(
	edits: EditItem[],
	workspace: Workspace,
	cwd: string,
	signal?: AbortSignal,
	options?: { collectDiff?: boolean; diffBudget?: DiffBudget; canonicalizeContext?: CanonicalizeMutationPathContext },
): Promise<EditResult[]> {
	const collectDiff = options?.collectDiff ?? false;
	const diffBudget = options?.diffBudget;
	const canonicalizeContext = options?.canonicalizeContext ?? createCanonicalizeMutationPathContext();
	const fuzzyBudget = { remaining: MAX_CLASSIC_FUZZY_SEARCH_COMPARISONS };
	const fileGroups = new Map<string, { index: number; edit: EditItem }[]>();
	const editOrder: string[] = [];

	for (let i = 0; i < edits.length; i++) {
		const resolved = resolveToCwd(cwd, edits[i].path);
		const abs = await canonicalizeMutationPath(resolved, canonicalizeContext);
		if (!fileGroups.has(abs)) {
			fileGroups.set(abs, []);
			editOrder.push(abs);
		}
		fileGroups.get(abs)!.push({ index: i, edit: edits[i] });
	}

	const results: EditResult[] = new Array(edits.length);

	for (const absPath of editOrder) {
		await workspace.checkWriteAccess(absPath);
	}

	for (const absPath of editOrder) {
		const group = fileGroups.get(absPath)!;
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const originalRawContent = await workspace.readText(absPath);
		const textFormat = getTextFormat(originalRawContent);
		const originalContent = normalizeToLF(stripBom(originalRawContent));
		const originalLineCount = countLinesBounded(originalContent, MAX_TARGET_FILE_LINES + 1);
		if (originalLineCount.capped || originalLineCount.count > MAX_TARGET_FILE_LINES) {
			throw new Error(`Target file ${group[0].edit.path} exceeds maximum size of ${MAX_TARGET_FILE_LINES} lines`);
		}

		if (group.length > MAX_SAME_FILE_CLASSIC_EDITS) {
			throw new Error(`Too many same-file edits for ${group[0].edit.path}: maximum is ${MAX_SAME_FILE_CLASSIC_EDITS}`);
		}
		if (group.length > 1 && Buffer.byteLength(originalContent, "utf-8") > MAX_SAME_FILE_CLASSIC_BYTES) {
			throw new Error(`Same-file batch edit target ${group[0].edit.path} exceeds maximum size of ${MAX_SAME_FILE_CLASSIC_BYTES} bytes`);
		}

		const normalizedOriginalContent = normaliseTextForFuzzyMatch(originalContent);
		const replacements: Array<{ index: number; path: string; start: number; end: number; newText: string }> = [];
		for (const { index, edit } of group) {
			const oldText = normalizeToLF(edit.oldText);
			const match = findClassicMatch(originalContent, oldText, fuzzyBudget, normalizedOriginalContent);
			if (match.occurrences > 1) {
				throw new Error(`Found ${match.occurrences} matches for oldText in ${edit.path}. The old text must be unique before editing.`);
			}
			if (match.start === -1) {
				results[index] = {
					path: edit.path,
					success: false,
					message: `Could not find the exact text in ${edit.path}. The old text must match exactly including all whitespace and newlines.`,
				};
				const filled = Array.from({ length: edits.length }, (_, i) => results[i]).filter(Boolean);
				throw new Error(formatResults(filled, edits.length));
			}
			replacements.push({ index, path: edit.path, start: match.start, end: match.end, newText: normalizeToLF(edit.newText) });
		}

		replacements.sort((a, b) => a.start - b.start);
		for (let i = 1; i < replacements.length; i++) {
			if (replacements[i].start < replacements[i - 1].end) {
				throw new Error(`Overlapping edits for ${replacements[i].path} cannot be applied against original content.`);
			}
		}

		let content = originalContent;
		for (let i = replacements.length - 1; i >= 0; i--) {
			const replacement = replacements[i];
			content = content.slice(0, replacement.start) + replacement.newText + content.slice(replacement.end);
			results[replacement.index] = { path: replacement.path, success: true, message: `Edited ${replacement.path}.` };
		}

		if (content === originalContent) {
			throw new Error(`Edit produced no changes for ${group[0].edit.path}.`);
		}

		await workspace.writeText(absPath, restoreTextFormat(content, textFormat));
		if (collectDiff && !diffBudget?.capped) {
			const diffResult = generateDiffString(group[0].edit.path, originalContent, content);
			results[group[0].index].diff = recordDiffWithinBudget(diffResult.diff, diffBudget);
			results[group[0].index].firstChangedLine = diffResult.firstChangedLine;
		}
	}

	return results;
}

export const editTool = {
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits. Supports a `multi` parameter for batch edits across one or more files, and a `patch` parameter for Codex-style patches.",
		promptSnippet:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		promptGuidelines: [
			"Use edit for precise changes (old text must match exactly)",
			"Use the `multi` parameter to apply multiple edits in a single tool call",
			"Use the `patch` parameter for Codex-style multi-file / hunk-based edits",
		],
		parameters: multiEditSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { path, oldText, newText, multi, patch } = params;
			let builtInEdits = params.edits;
			if (typeof builtInEdits === "string") {
				validateClassicPayloadString(builtInEdits);
				try {
					builtInEdits = JSON.parse(builtInEdits);
				} catch (err: any) {
					throw new Error(`The edits parameter must be an array or valid JSON array string: ${err.message ?? String(err)}`);
				}
			}
			if (builtInEdits !== undefined && !Array.isArray(builtInEdits)) {
				throw new Error("The edits parameter must be an array of edit items.");
			}
			const classicItemCount = (path !== undefined && oldText !== undefined && newText !== undefined ? 1 : 0)
				+ (multi?.length ?? 0)
				+ (builtInEdits?.length ?? 0);
			validateClassicInputCount(classicItemCount);

			const hasAnyClassicParam =
				path !== undefined || oldText !== undefined || newText !== undefined || multi !== undefined || builtInEdits !== undefined;
			if (patch !== undefined && hasAnyClassicParam) {
				throw new Error("The `patch` parameter is mutually exclusive with path/oldText/newText/multi/edits.");
			}
			if (multi !== undefined && builtInEdits !== undefined) {
				throw new Error("The `multi` and `edits` parameters cannot be mixed; use one batch format per call.");
			}

			if (patch !== undefined) {
				const ops = parsePatch(patch);
				const targetPaths = ops.map((op) => resolvePatchPath(ctx.cwd, op.path));
				const allowPatchAdd = (ctx as any).toolDisplayAllowPatchAdd === true;
				const canonicalizeContext = createCanonicalizeMutationPathContext();

				return withFileMutationQueue(targetPaths, async () => {
					const realStaging = createStagingWorkspace(createRealWorkspace());
					const applied = await applyPatchOperations(ops, realStaging.workspace, ctx.cwd, signal, { collectDiff: true, diffBudget: createDiffBudget(), allowPatchAdd, canonicalizeContext });
					await realStaging.commit(signal);
					const summary = applied.map((r, i) => `${i + 1}. ${r.message}`).join("\n");
					const combinedDiff = buildCombinedDiff(applied);
					const firstChangedLine = applied.find((r) => r.firstChangedLine !== undefined)?.firstChangedLine;
					return {
						content: [{ type: "text" as const, text: `Applied patch with ${applied.length} operation(s).\n${summary}` }],
						details: {
							diff: combinedDiff.diff,
							patch: combinedDiff.diff,
							diffOmitted: combinedDiff.capped,
							files: collectFilesInOrder(applied),
							firstChangedLine,
						},
					};
				}, signal, canonicalizeContext);
			}

			// Build classic edit list.
			const edits: EditItem[] = [];
			const sequentialEdits: EditItem[] = [];
			const originalContentEdits: EditItem[] = [];
			const hasTopLevel = path !== undefined && oldText !== undefined && newText !== undefined;

			if (hasTopLevel) {
				if (builtInEdits) {
					originalContentEdits.push({ path: path!, oldText: oldText!, newText: newText! });
				} else {
					sequentialEdits.push({ path: path!, oldText: oldText!, newText: newText! });
				}
			} else if (path !== undefined || oldText !== undefined || newText !== undefined) {
				// When multi is present, only a bare top-level `path` (for inheritance) is allowed.
				// Any other partial combination (e.g. path+oldText, oldText+newText) is an error.
				const hasOnlyPath = path !== undefined && oldText === undefined && newText === undefined;
				if (!hasOnlyPath || (multi === undefined && builtInEdits === undefined)) {
					const missing: string[] = [];
					if (path === undefined) missing.push("path");
					if (oldText === undefined) missing.push("oldText");
					if (newText === undefined) missing.push("newText");
					throw new Error(
						`Incomplete top-level edit: missing ${missing.join(", ")}. Provide all three (path, oldText, newText) or use only the multi/edits parameter.`,
					);
				}
				// path-only top-level with multi is fine — path is inherited below.
			}

			if (multi) {
				for (const item of multi) {
					sequentialEdits.push({
						path: item.path ?? path ?? "",
						oldText: item.oldText,
						newText: item.newText,
					});
				}
			}

			if (builtInEdits) {
				for (const item of builtInEdits) {
					originalContentEdits.push({
						path: item.path ?? path ?? "",
						oldText: item.oldText,
						newText: item.newText,
					});
				}
			}

			edits.push(...sequentialEdits, ...originalContentEdits);
			validateClassicEditBatch(edits);

			if (edits.length === 0) {
				throw new Error("No edits provided. Supply path/oldText/newText, a multi/edits array, or a patch.");
			}

			for (const edit of edits) {
				if (edit.oldText.length === 0) {
					throw new Error("oldText cannot be empty.");
				}
			}

			// Validate that every edit has a path.
			for (let i = 0; i < edits.length; i++) {
				if (!edits[i].path) {
					throw new Error(
						`Edit ${i + 1} is missing a path. Provide a path on each multi item or set a top-level path to inherit.`,
					);
				}
			}

			const targetPaths = edits.map((edit) => resolveToCwd(ctx.cwd, edit.path));
			const canonicalizeContext = createCanonicalizeMutationPathContext();

			return withFileMutationQueue(targetPaths, async () => {
				const realStaging = createStagingWorkspace(createRealWorkspace());
				const diffBudget = createDiffBudget();
				const results = [
					...(sequentialEdits.length > 0 ? await applyClassicEdits(sequentialEdits, realStaging.workspace, ctx.cwd, signal, { collectDiff: true, diffBudget, canonicalizeContext }) : []),
					...(originalContentEdits.length > 0 ? await applyBuiltInEdits(originalContentEdits, realStaging.workspace, ctx.cwd, signal, { collectDiff: true, diffBudget, canonicalizeContext }) : []),
				];
				await realStaging.commit(signal);

			if (results.length === 1) {
				const r = results[0];
				const cappedDiff = capDiff(r.diff ?? "");
				return {
					content: [{ type: "text" as const, text: r.message }],
					details: {
						diff: cappedDiff.diff,
						patch: cappedDiff.diff,
						diffOmitted: cappedDiff.capped,
						files: collectFilesInOrder(results),
						firstChangedLine: r.firstChangedLine,
					},
				};
			}

			const combinedDiff = buildCombinedDiff(results);

			const firstChanged = results.find((r) => r.firstChangedLine !== undefined)?.firstChangedLine;
			const summary = results.map((r, i) => `${i + 1}. ${r.message}`).join("\n");

			return {
				content: [{ type: "text" as const, text: `Applied ${results.length} edit(s) successfully.\n${summary}` }],
				details: {
					diff: combinedDiff.diff,
					patch: combinedDiff.diff,
					diffOmitted: combinedDiff.capped,
					files: collectFilesInOrder(results),
					firstChangedLine: firstChanged,
				},
			};
			}, signal, canonicalizeContext);
		},
	};

function collectFilesInOrder(results: Array<{ path: string }>): string[] {
	const files: string[] = [];
	const seen = new Set<string>();

	for (const result of results) {
		if (!seen.has(result.path)) {
			seen.add(result.path);
			files.push(result.path);
		}
	}

	return files;
}

function formatResults(results: EditResult[], totalEdits: number): string {
	const lines: string[] = [];

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const status = r.success ? "✓" : "✗";
		lines.push(`${status} Edit ${i + 1}/${totalEdits} (${r.path}): ${r.message}`);
	}

	const remaining = totalEdits - results.length;
	if (remaining > 0) {
		lines.push(`⊘ ${remaining} remaining edit(s) skipped due to error.`);
	}

	return lines.join("\n");
}
