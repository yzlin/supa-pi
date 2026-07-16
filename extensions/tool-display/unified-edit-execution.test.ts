import { afterEach, describe, expect, test } from "bun:test";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { editTool } from "./edit-tool";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "unified-edit-execution-"));
  dirs.push(dir);
  return dir;
}

function execute(
  cwd: string,
  text: string,
  options: {
    allowDelete?: boolean;
    allowAdd?: boolean;
    mode?: "tui" | "rpc" | "json" | "print";
    confirm?: (title: string, message: string) => Promise<boolean>;
    signal?: AbortSignal;
  } = {}
) {
  const mode = options.mode ?? "tui";
  return editTool.execute("call", { text }, options.signal, undefined, {
    cwd,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: { confirm: options.confirm ?? (() => Promise.resolve(true)) },
    toolDisplayAllowPatchAdd: options.allowAdd ?? true,
    toolDisplayAllowPermanentDelete: options.allowDelete ?? false,
  } as never);
}

describe("unified edit plan execution", () => {
  test("preserves BOM/CRLF and returns final details for relative and file URL paths", async () => {
    const dir = tempDir();
    const target = join(dir, "a.txt");
    writeFileSync(target, "\uFEFFold\r\nkeep\r\n");
    const result = await execute(
      dir,
      `[${pathToFileURL(target).href}]\n@REPLACE\n-old\n+new`
    );
    expect(readFileSync(target, "utf8")).toBe("\uFEFFnew\r\nkeep\r\n");
    expect(result.details.files).toEqual([pathToFileURL(target).href]);
    expect(result.details.diff).toContain("new");
    expect(result.details.firstChangedLine).toBe(1);
  });

  test("applies oversized non-delete edits with the preview omitted", async () => {
    const dir = tempDir();
    const target = join(dir, "large.txt");
    const oldText = "a".repeat(110_000);
    const newText = "b".repeat(110_000);
    writeFileSync(target, `${oldText}\n`);

    const result = await execute(
      dir,
      `[large.txt]\n@REPLACE\n-${oldText}\n+${newText}`
    );

    expect(readFileSync(target, "utf8")).toBe(`${newText}\n`);
    expect(result.details.diff).toBe("");
    expect(result.details.patch).toBe("");
    expect(result.details.diffOmitted).toBe(true);
    expect(result.details.firstChangedLine).toBe(1);
  });

  test("rejects oversized delete confirmation diffs before prompting", async () => {
    const dir = tempDir();
    const target = join(dir, "large-delete.txt");
    writeFileSync(target, `${"x".repeat(210_000)}\n`);
    let confirmed = false;

    await expect(
      execute(
        dir,
        "*** Begin Patch\n*** Delete File: large-delete.txt\n*** End Patch",
        {
          allowDelete: true,
          confirm: () => {
            confirmed = true;
            return Promise.resolve(true);
          },
        }
      )
    ).rejects.toThrow("global diff ceiling");
    expect(confirmed).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  test("rejects add on existing path and add when write is disabled", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "exists.txt"), "old\n");
    await expect(
      execute(
        dir,
        "*** Begin Patch\n*** Add File: exists.txt\n+x\n*** End Patch"
      )
    ).rejects.toThrow("already exists");
    await expect(
      execute(
        dir,
        "*** Begin Patch\n*** Add File: new.txt\n+x\n*** End Patch",
        { allowAdd: false }
      )
    ).rejects.toThrow("write tool");
    expect(existsSync(join(dir, "new.txt"))).toBe(false);
  });

  test("preflights invalid or unwritable add parents before earlier updates", async () => {
    const dir = tempDir();
    const target = join(dir, "target.txt");
    writeFileSync(target, "old\n");
    writeFileSync(join(dir, "not-a-directory"), "file\n");
    const patch = (addPath: string) => `*** Begin Patch
*** Update File: target.txt
@@
-old
+new
*** Add File: ${addPath}
+added
*** End Patch`;

    await expect(
      execute(dir, patch("not-a-directory/added.txt"))
    ).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("old\n");

    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    let permissionsEnforced = false;
    try {
      // biome-ignore lint/suspicious/noBitwiseOperators: fs.access modes are bit flags.
      accessSync(locked, constants.W_OK | constants.X_OK);
    } catch {
      permissionsEnforced = true;
    }
    if (permissionsEnforced) {
      await expect(execute(dir, patch("locked/added.txt"))).rejects.toThrow();
      expect(readFileSync(target, "utf8")).toBe("old\n");
      expect(existsSync(join(locked, "added.txt"))).toBe(false);
    }
    chmodSync(locked, 0o755);
  });

  test("requires configured interactive approval with exact delete diff", async () => {
    const dir = tempDir();
    const target = join(dir, "gone.txt");
    writeFileSync(target, "gone\n");
    const patch = "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch";
    await expect(execute(dir, patch)).rejects.toThrow("disabled");
    await expect(
      execute(dir, patch, { allowDelete: true, mode: "json" })
    ).rejects.toThrow("JSON/print");
    await expect(
      execute(dir, patch, {
        allowDelete: true,
        confirm: () => Promise.resolve(false),
      })
    ).rejects.toThrow("not approved");
    expect(existsSync(target)).toBe(true);
    let prompt = "";
    await execute(dir, patch, {
      allowDelete: true,
      mode: "rpc",
      confirm: (_title, message) => {
        prompt = message;
        return Promise.resolve(true);
      },
    });
    expect(prompt).toContain("- gone.txt");
    expect(prompt).toContain("Complete planned diff:");
    expect(prompt).toContain("-gone");
    expect(existsSync(target)).toBe(false);
  });

  test("rejects symbolic-link delete targets without following them", async () => {
    const dir = tempDir();
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "survives\n");
    symlinkSync(target, link);
    let confirmed = false;

    await expect(
      execute(
        dir,
        "*** Begin Patch\n*** Delete File: link.txt\n*** End Patch",
        {
          allowDelete: true,
          confirm: () => {
            confirmed = true;
            return Promise.resolve(true);
          },
        }
      )
    ).rejects.toThrow("Refusing to delete symbolic link");

    expect(confirmed).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("survives\n");
    expect(existsSync(link)).toBe(true);
  });

  test("does not follow a delete target replaced by a symlink after approval", async () => {
    const dir = tempDir();
    const planned = join(dir, "planned.txt");
    const referent = join(dir, "referent.txt");
    writeFileSync(planned, "planned\n");
    writeFileSync(referent, "referent survives\n");

    await expect(
      execute(
        dir,
        "*** Begin Patch\n*** Delete File: planned.txt\n*** End Patch",
        {
          allowDelete: true,
          confirm: () => {
            rmSync(planned);
            symlinkSync(referent, planned);
            return Promise.resolve(true);
          },
        }
      )
    ).rejects.toThrow("Refusing to delete symbolic link");

    expect(readFileSync(referent, "utf8")).toBe("referent survives\n");
    expect(existsSync(planned)).toBe(true);
  });

  test("deletes a read-only file after confirmation", async () => {
    const dir = tempDir();
    const target = join(dir, "read-only.txt");
    writeFileSync(target, "gone\n");
    chmodSync(target, 0o444);

    await execute(
      dir,
      "*** Begin Patch\n*** Delete File: read-only.txt\n*** End Patch",
      { allowDelete: true }
    );

    expect(existsSync(target)).toBe(false);
  });

  test("revalidates approval snapshot and canonical aliases before any write", async () => {
    const dir = tempDir();
    const target = join(dir, "target.txt");
    writeFileSync(target, "old\n");
    const patch =
      "*** Begin Patch\n*** Update File: target.txt\n@@\n-old\n+new\n*** Delete File: target.txt\n*** End Patch";
    await expect(
      execute(dir, patch, {
        allowDelete: true,
        confirm: () => {
          writeFileSync(target, "changed elsewhere\n");
          return Promise.resolve(true);
        },
      })
    ).rejects.toThrow("Source changed after planning");
    expect(readFileSync(target, "utf8")).toBe("changed elsewhere\n");

    writeFileSync(target, "old\n");
    symlinkSync(target, join(dir, "alias.txt"));
    await expect(
      execute(
        dir,
        "[target.txt]\n@REPLACE\n-old\n+one\n[alias.txt]\n@REPLACE\n-old\n+two"
      )
    ).rejects.toThrow("same target");
    expect(readFileSync(target, "utf8")).toBe("old\n");
  });

  test("honors abort before planning or mutation", async () => {
    const dir = tempDir();
    const target = join(dir, "a.txt");
    writeFileSync(target, "old\n");
    const controller = new AbortController();
    controller.abort();
    await expect(
      execute(dir, "[a.txt]\n@REPLACE\n-old\n+new", {
        signal: controller.signal,
      })
    ).rejects.toThrow("Operation aborted");
    expect(readFileSync(target, "utf8")).toBe("old\n");
  });
});
