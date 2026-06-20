import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { editTool, resolveToCwd, withFileMutationQueue } from "./edit-tool";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = join(import.meta.dir, `.tmp-edit-tool-${Date.now()}-${Math.random()}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

async function runEdit(params: Record<string, unknown>, cwd: string) {
	return editTool.execute("tool-call-id", params, undefined, undefined, { cwd, toolDisplayAllowPatchAdd: true } as never);
}

async function runEditWithWriteDisabled(params: Record<string, unknown>, cwd: string) {
	return editTool.execute("tool-call-id", params, undefined, undefined, { cwd, toolDisplayAllowPatchAdd: false } as never);
}

function expectUnifiedDiff(diff: string): void {
	expect(diff).toContain("--- ");
	expect(diff).toContain("+++ ");
	expect(diff).toContain("@@");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("editTool path resolution", () => {
	test("normalizes Unicode spaces before resolving paths", () => {
		const dir = tempDir();

		expect(resolveToCwd(dir, "foo\u00A0bar.txt")).toBe(join(dir, "foo bar.txt"));
		expect(resolveToCwd(dir, "foo\u2000bar.txt")).toBe(join(dir, "foo bar.txt"));
		expect(resolveToCwd(dir, "foo\u2001bar.txt")).toBe(join(dir, "foo bar.txt"));
	});

	test("resolves @file URLs to the file URL target", () => {
		const dir = tempDir();
		const target = join(dir, "target.txt");

		expect(resolveToCwd(dir, `@${pathToFileURL(target).href}`)).toBe(target);
	});
});

describe("editTool mutation queue", () => {
	test("rejects aborted queued work before running callback", async () => {
		const dir = tempDir();
		const path = join(dir, "queued.txt");
		let releaseFirst!: () => void;
		let first!: Promise<void>;
		const firstStarted = new Promise<void>((resolveStarted) => {
			first = withFileMutationQueue([path], () => new Promise<void>((resolve) => {
				releaseFirst = resolve;
				resolveStarted();
			}));
		});
		await firstStarted;
		const controller = new AbortController();
		let ran = false;
		const second = withFileMutationQueue([path], async () => {
			ran = true;
		}, controller.signal);

		controller.abort();
		releaseFirst();
		await first;
		await expect(second).rejects.toThrow("Operation aborted");
		expect(ran).toBe(false);
	});

	test("rejects aborted queued work without waiting for earlier work", async () => {
		const dir = tempDir();
		const path = join(dir, "queued-immediate.txt");
		let releaseFirst!: () => void;
		let first!: Promise<void>;
		const firstStarted = new Promise<void>((resolveStarted) => {
			first = withFileMutationQueue([path], () => new Promise<void>((resolve) => {
				releaseFirst = resolve;
				resolveStarted();
			}));
		});
		await firstStarted;
		const controller = new AbortController();
		const second = withFileMutationQueue([path], async () => undefined, controller.signal);

		controller.abort();
		await expect(second).rejects.toThrow("Operation aborted");
		releaseFirst();
		await first;
	});

	test("preserves active lock after queued work aborts", async () => {
		const dir = tempDir();
		const path = join(dir, "queued-preserve-lock.txt");
		let releaseFirst!: () => void;
		let first!: Promise<void>;
		const firstStarted = new Promise<void>((resolveStarted) => {
			first = withFileMutationQueue([path], () => new Promise<void>((resolve) => {
				releaseFirst = resolve;
				resolveStarted();
			}));
		});
		await firstStarted;
		const controller = new AbortController();
		const second = withFileMutationQueue([path], async () => undefined, controller.signal);

		controller.abort();
		await expect(second).rejects.toThrow("Operation aborted");
		let thirdStarted = false;
		const third = withFileMutationQueue([path], async () => {
			thirdStarted = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(thirdStarted).toBe(false);

		releaseFirst();
		await first;
		await third;
		expect(thirdStarted).toBe(true);
	});

	test("rejects excessively deep missing queue paths", async () => {
		const dir = tempDir();
		const deepPath = join(dir, ...Array.from({ length: 300 }, (_, index) => `missing-${index}`));

		await expect(withFileMutationQueue([deepPath], async () => undefined)).rejects.toThrow("Path exceeds maximum canonicalization size");
	});

	test("rejects excessive same-path queue depth", async () => {
		const dir = tempDir();
		const path = join(dir, "backpressure.txt");
		let releaseFirst!: () => void;
		let first!: Promise<void>;
		const firstStarted = new Promise<void>((resolveStarted) => {
			first = withFileMutationQueue([path], () => new Promise<void>((resolve) => {
				releaseFirst = resolve;
				resolveStarted();
			}));
		});
		await firstStarted;
		const queued = [first];
		for (let i = 0; i < 49; i++) {
			queued.push(withFileMutationQueue([path], async () => undefined));
		}
		await new Promise((resolve) => setTimeout(resolve, 0));

		try {
			await withFileMutationQueue([path], async () => undefined);
			throw new Error("expected queue depth rejection");
		} catch (error: any) {
			expect(error.message).toContain("exceeds maximum depth");
		} finally {
			releaseFirst();
		}
		await Promise.all(queued);
	});
});

describe("editTool diff output", () => {
	test("classic edit rejects non-unique oldText before writing", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "duplicate.txt"), "same\nkeep\nsame\n");

		await expect(
			runEdit(
				{ path: "duplicate.txt", oldText: "same", newText: "changed" },
				dir,
			),
		).rejects.toThrow("The old text must be unique");

		expect(await readFile(join(dir, "duplicate.txt"), "utf-8")).toBe("same\nkeep\nsame\n");
	});

	test("classic edit rejects exact oldText with fuzzy-equivalent duplicates before writing", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "fuzzy-duplicate.txt"), "foo\nfoo  \n");

		await expect(
			runEdit(
				{ path: "fuzzy-duplicate.txt", oldText: "foo\n", newText: "changed\n" },
				dir,
			),
		).rejects.toThrow("The old text must be unique");

		expect(await readFile(join(dir, "fuzzy-duplicate.txt"), "utf-8")).toBe("foo\nfoo  \n");
	});

	test("classic single edit emits unified diff details", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "single.txt"), "one\ntwo\nthree\n");

		const result = await runEdit(
			{ path: "single.txt", oldText: "two", newText: "TWO" },
			dir,
		);

		expectUnifiedDiff(result.details.diff);
		expect(result.details.patch).toBe(result.details.diff);
		expect(result.details.diff).toContain("--- single.txt");
		expect(result.details.diff).toContain("+++ single.txt");
		expect(result.details.files).toEqual(["single.txt"]);
		expect(result.details.firstChangedLine).toBe(2);
	});

	test("classic large rewrites omit diff before synchronous diff generation", async () => {
		const dir = tempDir();
		const oldText = `${"a".repeat(90_000)}\n`;
		const newText = `${"b".repeat(90_000)}\n`;
		writeFileSync(join(dir, "large-rewrite.txt"), oldText);

		const result = await runEdit(
			{ path: "large-rewrite.txt", oldText, newText },
			dir,
		);

		expect(result.details.diff.startsWith("[diff omitted:")).toBe(true);
		expect(result.details.diff).toContain("too large for synchronous diff generation");
		expect(result.details.firstChangedLine).toBe(1);
		expect(await readFile(join(dir, "large-rewrite.txt"), "utf-8")).toBe(newText);
	});

	test("classic edit supports fuzzy quote dash and whitespace matching", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "fuzzy.txt"), "keep\nHello — “world”\u00A0 \nend\n");

		await runEdit(
			{ path: "fuzzy.txt", oldText: "Hello - \"world\"", newText: "matched" },
			dir,
		);

		expect(await readFile(join(dir, "fuzzy.txt"), "utf-8")).toBe("keep\nmatched\nend\n");
	});

	test("classic fuzzy edit does not ignore leading indentation", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "indented.txt"), "function test() {\n  Hello — “world”\n}\n");

		await expect(
			runEdit(
				{ path: "indented.txt", oldText: "Hello - \"world\"\n}", newText: "matched\n}" },
				dir,
			),
		).rejects.toThrow("Could not find the exact text");

		expect(await readFile(join(dir, "indented.txt"), "utf-8")).toBe("function test() {\n  Hello — “world”\n}\n");
	});

	test("classic no-op edit is rejected", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "noop.txt"), "same\n");

		await expect(
			runEdit(
				{ path: "noop.txt", oldText: "same", newText: "same" },
				dir,
			),
		).rejects.toThrow("Edit produced no changes");

		expect(await readFile(join(dir, "noop.txt"), "utf-8")).toBe("same\n");
	});

	test("built-in edits support fuzzy matching and reject no-op output", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "builtin-fuzzy.txt"), "Hello — “world”\u00A0 \n");
		writeFileSync(join(dir, "builtin-noop.txt"), "same\n");

		await runEdit(
			{ edits: [{ path: "builtin-fuzzy.txt", oldText: "Hello - \"world\"", newText: "matched" }] },
			dir,
		);
		await expect(
			runEdit(
				{ edits: [{ path: "builtin-noop.txt", oldText: "same", newText: "same" }] },
				dir,
			),
		).rejects.toThrow("Edit produced no changes");

		expect(await readFile(join(dir, "builtin-fuzzy.txt"), "utf-8")).toBe("matched\n");
		expect(await readFile(join(dir, "builtin-noop.txt"), "utf-8")).toBe("same\n");
	});

	test("multi edit emits concatenated unified file diffs with unique files in first operation order", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
		writeFileSync(join(dir, "b.txt"), "one\ntwo\n");

		const result = await runEdit(
			{
				multi: [
					{ path: "a.txt", oldText: "alpha", newText: "ALPHA" },
					{ path: "b.txt", oldText: "two", newText: "TWO" },
					{ path: "a.txt", oldText: "gamma", newText: "GAMMA" },
				],
			},
			dir,
		);

		expectUnifiedDiff(result.details.diff);
		expect(result.details.diff).toContain("--- a.txt");
		expect(result.details.diff).toContain("+++ a.txt");
		expect(result.details.diff).toContain("--- b.txt");
		expect(result.details.diff).toContain("+++ b.txt");
		expect(result.details.diff).not.toContain("File:");
		expect(result.details.files).toEqual(["a.txt", "b.txt"]);
		expect(result.details.firstChangedLine).toBe(1);
	});

	test("patch add and update emit unified diffs", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "existing.txt"), "old\nline\n");

		const result = await runEdit(
			{
				patch: `*** Begin Patch
*** Add File: added.txt
+hello
+world
*** Update File: existing.txt
@@
-old
+new
 line
*** End Patch`,
			},
			dir,
		);

		expectUnifiedDiff(result.details.diff);
		expect(result.details.patch).toBe(result.details.diff);
		expect(result.details.diff).toContain("--- /dev/null");
		expect(result.details.diff).toContain("+++ added.txt");
		expect(result.details.diff).toContain("--- existing.txt");
		expect(result.details.diff).toContain("+++ existing.txt");
		expect(result.details.diff).not.toContain("File:");
		expect(result.details.files).toEqual(["added.txt", "existing.txt"]);
		expect(await readFile(join(dir, "added.txt"), "utf-8")).toBe("hello\nworld\n");
	});

	test("patch delete operations are rejected", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "delete-me.txt"), "keep\n");

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Delete File: delete-me.txt
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Patch delete operations are not supported");
	});

	test("patch add file rejects existing targets without exposing old content", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "already.txt"), "secret old content\n");

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Add File: already.txt
+new content
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Add file target already exists: already.txt");

		expect(await readFile(join(dir, "already.txt"), "utf-8")).toBe("secret old content\n");
	});

	test("patch add is rejected when write tool is disabled", async () => {
		const dir = tempDir();

		await expect(
			runEditWithWriteDisabled(
				{
					patch: `*** Begin Patch
*** Add File: disabled-add.txt
+blocked
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Patch Add File requires the write tool to be enabled");

		expect(existsSync(join(dir, "disabled-add.txt"))).toBe(false);
	});

	test("patch add is rejected when write permission is unknown", async () => {
		const dir = tempDir();

		await expect(
			editTool.execute(
				"tool-call-id",
				{
					patch: `*** Begin Patch
*** Add File: unknown-add.txt
+blocked
*** End Patch`,
				},
				undefined,
				undefined,
				{ cwd: dir } as never,
			),
		).rejects.toThrow("Patch Add File requires the write tool to be enabled");

		expect(existsSync(join(dir, "unknown-add.txt"))).toBe(false);
	});

	test("patch preflights all real targets before writing", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "first.txt"), "old\n");

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Update File: first.txt
@@
-old
+new
*** Add File: first.txt
+added
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Add file target already exists: first.txt");

		expect(await readFile(join(dir, "first.txt"), "utf-8")).toBe("old\n");
	});

	test("patch update preserves missing final newline", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "no-newline.txt"), "old");

		await runEdit(
			{
				patch: `*** Begin Patch
*** Update File: no-newline.txt
@@
-old
+new
*** End Patch`,
			},
			dir,
		);

		expect(await readFile(join(dir, "no-newline.txt"), "utf-8")).toBe("new");
	});

	test("patch add preflight rejects staged parent child adds before writing", async () => {
		const dir = tempDir();

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Add File: a
+parent
*** Add File: a/b
+child
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Add file target conflicts with another staged add");

		expect(existsSync(join(dir, "a"))).toBe(false);
		expect(existsSync(join(dir, "a", "b"))).toBe(false);
	});

	test("patch add preflight rejects staged child parent adds before writing", async () => {
		const dir = tempDir();

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Add File: a/b
+child
*** Add File: a
+parent
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Add file target conflicts with another staged add");

		expect(existsSync(join(dir, "a"))).toBe(false);
	});

	test("patch add preflight rejects non-directory parents before writing earlier updates", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "first.txt"), "old\n");
		writeFileSync(join(dir, "not-a-dir"), "file\n");

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Update File: first.txt
@@
-old
+new
*** Add File: not-a-dir/added.txt
+added
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("ENOTDIR");

		expect(await readFile(join(dir, "first.txt"), "utf-8")).toBe("old\n");
	});

	test("empty patches are rejected", async () => {
		const dir = tempDir();

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Patch contains no operations");
	});

	test("multiple patch updates to the same file preserve earlier staged hunks", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "same-file.txt"), "one\ntwo\nthree\n");

		await runEdit(
			{
				patch: `*** Begin Patch
*** Update File: same-file.txt
@@
-one
+ONE
 two
*** Update File: same-file.txt
@@
 two
-three
+THREE
*** End Patch`,
			},
			dir,
		);

		expect(await readFile(join(dir, "same-file.txt"), "utf-8")).toBe("ONE\ntwo\nTHREE\n");
	});

	test("multiple patch updates reject net no-op output before writing", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "patch-net-noop.txt"), "one\n");

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Update File: patch-net-noop.txt
@@
-one
+two
*** Update File: patch-net-noop.txt
@@
-two
+one
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Patch updates produced no net changes");

		expect(await readFile(join(dir, "patch-net-noop.txt"), "utf-8")).toBe("one\n");
	});

	test("classic same-file edits apply in declared order against current content", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "ordered.txt"), "one\n");

		await runEdit(
			{
				multi: [
					{ path: "ordered.txt", oldText: "one", newText: "two" },
					{ path: "ordered.txt", oldText: "two", newText: "three" },
				],
			},
			dir,
		);

		expect(await readFile(join(dir, "ordered.txt"), "utf-8")).toBe("three\n");
	});

	test("classic edits canonicalize symlink aliases to the same staged file", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "target.txt"), "one\n");
		symlinkSync(join(dir, "target.txt"), join(dir, "alias.txt"));

		await runEdit(
			{
				multi: [
					{ path: "alias.txt", oldText: "one", newText: "two" },
					{ path: "target.txt", oldText: "two", newText: "three" },
				],
			},
			dir,
		);

		expect(await readFile(join(dir, "target.txt"), "utf-8")).toBe("three\n");
	});

	test("patch add preserves empty file contents", async () => {
		const dir = tempDir();

		await runEdit(
			{
				patch: `*** Begin Patch
*** Add File: empty.txt
*** End Patch`,
			},
			dir,
		);

		expect(await readFile(join(dir, "empty.txt"), "utf-8")).toBe("");
	});

	test("built-in edits array is accepted with inherited path", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "built-in.txt"), "one\ntwo\nthree\n");

		const result = await runEdit(
			{
				path: "built-in.txt",
				edits: [
					{ oldText: "one", newText: "ONE" },
					{ oldText: "three", newText: "THREE" },
				],
			},
			dir,
		);

		expect(result.details.files).toEqual(["built-in.txt"]);
		expect(await readFile(join(dir, "built-in.txt"), "utf-8")).toBe("ONE\ntwo\nTHREE\n");
	});

	test("built-in edits JSON string is accepted with inherited path", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "built-in-json.txt"), "one\ntwo\n");

		await runEdit(
			{
				path: "built-in-json.txt",
				edits: JSON.stringify([{ oldText: "two", newText: "TWO" }]),
			},
			dir,
		);

		expect(await readFile(join(dir, "built-in-json.txt"), "utf-8")).toBe("one\nTWO\n");
	});

	test("classic edits use built-in path normalization", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "normalized.txt"), "one\n");

		await runEdit(
			{ path: "@src/normalized.txt", oldText: "one", newText: "two" },
			dir,
		);

		expect(await readFile(join(dir, "src", "normalized.txt"), "utf-8")).toBe("two\n");
	});

	test("classic edits accept file URL paths", async () => {
		const dir = tempDir();
		const target = join(dir, "file-url-classic.txt");
		writeFileSync(target, "one\n");

		await runEdit(
			{ path: pathToFileURL(target).href, oldText: "one", newText: "two" },
			dir,
		);

		expect(await readFile(target, "utf-8")).toBe("two\n");
		expect(existsSync(join(dir, "file:"))).toBe(false);
	});

	test("patch paths use built-in path normalization", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "src"), { recursive: true });

		await runEdit(
			{
				patch: `*** Begin Patch
*** Add File: @src/patched.txt
+patched
*** End Patch`,
			},
			dir,
		);

		expect(await readFile(join(dir, "src", "patched.txt"), "utf-8")).toBe("patched\n");
	});

	test("patch add accepts file URL paths for queued writes and diffs", async () => {
		const dir = tempDir();
		const target = join(dir, "file-url-patch-add.txt");
		const targetUrl = pathToFileURL(target).href;

		const result = await runEdit(
			{
				patch: `*** Begin Patch
*** Add File: ${targetUrl}
+patched
*** End Patch`,
			},
			dir,
		);

		expect(await readFile(target, "utf-8")).toBe("patched\n");
		expect(existsSync(join(dir, "file:"))).toBe(false);
		expect(result.details.files).toEqual([targetUrl]);
		expect(result.details.diff).toContain(`+++ ${targetUrl}`);
	});

	test("patch update accepts file URL paths", async () => {
		const dir = tempDir();
		const target = join(dir, "file-url-patch-update.txt");
		const targetUrl = pathToFileURL(target).href;
		writeFileSync(target, "one\n");

		await runEdit(
			{
				patch: `*** Begin Patch
*** Update File: ${targetUrl}
@@
-one
+two
*** End Patch`,
			},
			dir,
		);

		expect(await readFile(target, "utf-8")).toBe("two\n");
	});

	test("oversized built-in edits JSON string is rejected before parsing", async () => {
		const dir = tempDir();
		const hugeEdits = `[${" ".repeat(1_000_001)}`;

		await expect(runEdit({ edits: hugeEdits }, dir)).rejects.toThrow("Classic edit payload exceeds maximum size");
	});

	test("built-in edits array matches each edit against original content", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "built-in-original.txt"), "a\nb\n");

		await runEdit(
			{
				path: "built-in-original.txt",
				edits: [
					{ oldText: "a", newText: "b" },
					{ oldText: "b", newText: "c" },
				],
			},
			dir,
		);

		expect(await readFile(join(dir, "built-in-original.txt"), "utf-8")).toBe("b\nc\n");
	});

	test("top-level edit mixed with built-in edits matches all edits against original content", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "mixed-original.txt"), "a\nb\n");

		await runEdit(
			{
				path: "mixed-original.txt",
				oldText: "a",
				newText: "b",
				edits: [{ oldText: "b", newText: "c" }],
			},
			dir,
		);

		expect(await readFile(join(dir, "mixed-original.txt"), "utf-8")).toBe("b\nc\n");
	});

	test("mixed multi and built-in edits is rejected before mutating files", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "first.txt"), "old\n");
		writeFileSync(join(dir, "second.txt"), "keep\n");

		await expect(
			runEdit(
				{
					multi: [{ path: "first.txt", oldText: "old", newText: "new" }],
					edits: [{ path: "second.txt", oldText: "missing", newText: "changed" }],
				},
				dir,
			),
		).rejects.toThrow("The `multi` and `edits` parameters cannot be mixed");

		expect(await readFile(join(dir, "first.txt"), "utf-8")).toBe("old\n");
		expect(await readFile(join(dir, "second.txt"), "utf-8")).toBe("keep\n");
	});

	test("classic edit matches LF oldText and preserves CRLF with BOM", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "crlf.txt"), "\uFEFFone\r\ntwo\r\nthree\r\n");

		await runEdit(
			{ path: "crlf.txt", oldText: "two\nthree", newText: "TWO\nTHREE" },
			dir,
		);

		expect(await readFile(join(dir, "crlf.txt"), "utf-8")).toBe("\uFEFFone\r\nTWO\r\nTHREE\r\n");
	});

	test("classic edits reject empty oldText", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "empty-old.txt"), "one\n");

		await expect(
			runEdit({ path: "empty-old.txt", oldText: "", newText: "X" }, dir),
		).rejects.toThrow("oldText cannot be empty");

		expect(await readFile(join(dir, "empty-old.txt"), "utf-8")).toBe("one\n");
	});

	test("patch update rejects contextless insert-only hunks", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "append.txt"), "one\n");

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Update File: append.txt
@@
+two
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Update hunk must include old/context lines");

		expect(await readFile(join(dir, "append.txt"), "utf-8")).toBe("one\n");
	});

	test("patch update insert-only hunks insert after matched context marker", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "anchored.txt"), "one\ntwo\nthree\n");

		await runEdit(
			{
				patch: `*** Begin Patch
*** Update File: anchored.txt
@@ one
+one-and-a-half
*** End Patch`,
			},
			dir,
		);

		expect(await readFile(join(dir, "anchored.txt"), "utf-8")).toBe("one\none-and-a-half\ntwo\nthree\n");
	});

	test("patch update applies same-start replacements before inserts", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "same-start.txt"), "one\ntwo\nthree\n");

		await runEdit(
			{
				patch: `*** Begin Patch
*** Update File: same-start.txt
@@ one
+one-and-a-half
@@
-two
+TWO
*** End Patch`,
			},
			dir,
		);

		expect(await readFile(join(dir, "same-start.txt"), "utf-8")).toBe("one\none-and-a-half\nTWO\nthree\n");
	});

	test("oversized target files are rejected before edit preflight reads content", async () => {
		const dir = tempDir();
		const target = join(dir, "huge.txt");
		writeFileSync(target, "start\n");
		truncateSync(target, 10_000_001);

		await expect(
			runEdit(
				{ path: "huge.txt", oldText: "start", newText: "changed" },
				dir,
			),
		).rejects.toThrow("exceeds maximum size");
	});

	test("non-regular target paths are rejected before reading", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "not-a-file"));

		await expect(
			runEdit(
				{ path: "not-a-file", oldText: "start", newText: "changed" },
				dir,
			),
		).rejects.toThrow("is not a regular file");
	});

	test("patch hunk matching is bounded", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "many-lines.txt"), Array.from({ length: 70_000 }, (_, i) => `line-${i}`).join("\n"));

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Update File: many-lines.txt
@@
-missing-line
+changed-line
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Patch hunk search exceeded maximum budget");
	});

	test("patch update rejects duplicate hunk matches before writing", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "duplicate-hunk.txt"), "target\nkeep\ntarget\n");

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Update File: duplicate-hunk.txt
@@
-target
+changed
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Patch hunk matched multiple locations");

		expect(await readFile(join(dir, "duplicate-hunk.txt"), "utf-8")).toBe("target\nkeep\ntarget\n");
	});

	test("patch update rejects no-op output before writing", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "patch-noop.txt"), "same\n");

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Update File: patch-noop.txt
@@
-same
+same
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Patch update produced no changes");

		expect(await readFile(join(dir, "patch-noop.txt"), "utf-8")).toBe("same\n");
	});

	test("classic fuzzy matching is bounded", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "classic-many-lines.txt"), Array.from({ length: 120_000 }, (_, i) => `line-${i}`).join("\n"));

		await expect(
			runEdit(
				{ path: "classic-many-lines.txt", oldText: "missing-line", newText: "changed-line" },
				dir,
			),
		).rejects.toThrow("Classic fuzzy search exceeded maximum budget");
	});

	test("classic edit rejects too many target lines before fuzzy matching", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "classic-too-many-lines.txt"), `${"\n".repeat(200_001)}target`);

		await expect(
			runEdit(
				{ path: "classic-too-many-lines.txt", oldText: "missing-line", newText: "changed-line" },
				dir,
			),
		).rejects.toThrow("exceeds maximum size of 200000 lines");
	});

	test("patch hunk matching budget is shared across update operations", async () => {
		const dir = tempDir();
		for (let i = 0; i < 4; i++) {
			writeFileSync(join(dir, `many-lines-${i}.txt`), Array.from({ length: 30_000 }, (_, line) => `line-${line}  `).join("\n"));
		}
		const updates = Array.from(
			{ length: 4 },
			(_, i) => `*** Update File: many-lines-${i}.txt
@@
-line-29999
+changed-${i}`,
		).join("\n");

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
${updates}
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Patch hunk search exceeded maximum budget");
	});

	test("oversized patches are rejected before parsing", async () => {
		const dir = tempDir();
		const hugePatch = `*** Begin Patch\n*** Add File: huge.txt\n${"+x\n".repeat(20_001)}*** End Patch`;

		await expect(runEdit({ patch: hugePatch }, dir)).rejects.toThrow("Patch exceeds maximum size");
		expect(existsSync(join(dir, "huge.txt"))).toBe(false);
	});

	test("CR-only oversized patches are rejected before parsing", async () => {
		const dir = tempDir();
		const hugePatch = `*** Begin Patch\r*** Add File: huge-cr.txt\r${"+x\r".repeat(20_001)}*** End Patch`;

		await expect(runEdit({ patch: hugePatch }, dir)).rejects.toThrow("Patch exceeds maximum size");
		expect(existsSync(join(dir, "huge-cr.txt"))).toBe(false);
	});

	test("patch updates reject targets with too many lines before hunk search", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "too-many-lines.txt"), `${"x\n".repeat(200_001)}`);

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Update File: too-many-lines.txt
@@
-missing
+changed
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("exceeds maximum size of 200000 lines");
	});

	test("same-file classic batches are bounded", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "too-many.txt"), "one\n");

		await expect(
			runEdit(
				{
					path: "too-many.txt",
					edits: Array.from({ length: 101 }, () => ({ oldText: "one", newText: "one" })),
				},
				dir,
			),
		).rejects.toThrow("Too many same-file edits");
	});

	test("total classic edit batches are bounded", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "too-many-total.txt"), "one\n");

		await expect(
			runEdit(
				{
					multi: Array.from({ length: 1_001 }, () => ({ path: "too-many-total.txt", oldText: "one", newText: "one" })),
				},
				dir,
			),
		).rejects.toThrow("Too many classic edits");
	});

	test("classic multi-file staged content is bounded", async () => {
		const dir = tempDir();
		const largeContent = `one${"x".repeat(7_600_000)}`;
		writeFileSync(join(dir, "large-a.txt"), largeContent);
		writeFileSync(join(dir, "large-b.txt"), largeContent);

		await expect(
			runEdit(
				{
					multi: [
						{ path: "large-a.txt", oldText: "one", newText: "two" },
						{ path: "large-b.txt", oldText: "one", newText: "two" },
					],
				},
				dir,
			),
		).rejects.toThrow("Staged edit content exceeds maximum size");
		expect(await readFile(join(dir, "large-a.txt"), "utf-8")).toBe(largeContent);
		expect(await readFile(join(dir, "large-b.txt"), "utf-8")).toBe(largeContent);
	});

	test("patch update staged content is bounded", async () => {
		const dir = tempDir();
		const largeContent = `one\n${"x".repeat(7_600_000)}`;
		writeFileSync(join(dir, "patch-large-a.txt"), largeContent);
		writeFileSync(join(dir, "patch-large-b.txt"), largeContent);

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Update File: patch-large-a.txt
@@
-one
+two
*** Update File: patch-large-b.txt
@@
-one
+two
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Staged edit content exceeds maximum size");
		expect(await readFile(join(dir, "patch-large-a.txt"), "utf-8")).toBe(largeContent);
		expect(await readFile(join(dir, "patch-large-b.txt"), "utf-8")).toBe(largeContent);
	});

	test("built-in edit staged content is bounded", async () => {
		const dir = tempDir();
		const largeContent = `one${"x".repeat(7_600_000)}`;
		writeFileSync(join(dir, "builtin-large-a.txt"), largeContent);
		writeFileSync(join(dir, "builtin-large-b.txt"), largeContent);

		await expect(
			runEdit(
				{
					edits: [
						{ path: "builtin-large-a.txt", oldText: "one", newText: "two" },
						{ path: "builtin-large-b.txt", oldText: "one", newText: "two" },
					],
				},
				dir,
			),
		).rejects.toThrow("Staged edit content exceeds maximum size");
		expect(await readFile(join(dir, "builtin-large-a.txt"), "utf-8")).toBe(largeContent);
		expect(await readFile(join(dir, "builtin-large-b.txt"), "utf-8")).toBe(largeContent);
	});

	test("patch add rejects dangling symlink targets before writing earlier staged updates", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "before.txt"), "old\n");
		symlinkSync(join(dir, "missing-target.txt"), join(dir, "dangling.txt"));

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch
*** Update File: before.txt
@@
-old
+new
*** Add File: dangling.txt
+created
*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Add file target already exists");
		expect(await readFile(join(dir, "before.txt"), "utf-8")).toBe("old\n");
	});

	test("repeated same-file patch updates are bounded", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "too-many-patch-updates.txt"), "value-0\n");
		const updates = Array.from(
			{ length: 101 },
			(_, i) => `*** Update File: too-many-patch-updates.txt\n@@\n-value-${i}\n+value-${i + 1}`,
		).join("\n");

		await expect(
			runEdit(
				{
					patch: `*** Begin Patch\n${updates}\n*** End Patch`,
				},
				dir,
			),
		).rejects.toThrow("Too many same-file patch updates");
	});

	test("patch add followed by update preserves staged file contents", async () => {
		const dir = tempDir();

		await runEdit(
			{
				patch: `*** Begin Patch
*** Add File: added-then-updated.txt
+one
*** Update File: added-then-updated.txt
@@
-one
+two
*** End Patch`,
			},
			dir,
		);

		expect(await readFile(join(dir, "added-then-updated.txt"), "utf-8")).toBe("two\n");
	});

	test("large patch diffs are capped while retaining file list", async () => {
		const dir = tempDir();
		const largeContent = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");

		const result = await runEdit(
			{
				patch: `*** Begin Patch
*** Add File: large.txt
${largeContent
	.split("\n")
	.map((line) => `+${line}`)
	.join("\n")}
*** End Patch`,
			},
			dir,
		);

		expect(result.details.files).toEqual(["large.txt"]);
		expect(result.details.diffOmitted).toBe(true);
		expect(result.details.diff).toContain("diff omitted");
		expect(result.details.diff).not.toContain("+++ large.txt");
		expect(existsSync(join(dir, "large.txt"))).toBe(true);
	});
});
