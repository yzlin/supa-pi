import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileBrowserComponent } from "./file-picker";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-file-picker-keys-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("file picker keybindings", () => {
  it("treats ctrl+n like down in the browser list", () => {
    const root = createTempDir();
    writeFileSync(join(root, "alpha.txt"), "alpha", "utf8");
    writeFileSync(join(root, "beta.txt"), "beta", "utf8");
    process.chdir(root);

    const downBrowser = new FileBrowserComponent(() => {});
    downBrowser.handleInput("\u001b[B");

    const ctrlNBrowser = new FileBrowserComponent(() => {});
    ctrlNBrowser.handleInput("\x0e");

    expect((downBrowser as any).selected).toBe(1);
    expect((ctrlNBrowser as any).selected).toBe((downBrowser as any).selected);
  });

  it("treats ctrl+p like up in the browser list", () => {
    const root = createTempDir();
    writeFileSync(join(root, "alpha.txt"), "alpha", "utf8");
    writeFileSync(join(root, "beta.txt"), "beta", "utf8");
    process.chdir(root);

    const upBrowser = new FileBrowserComponent(() => {});
    upBrowser.handleInput("\u001b[A");

    const ctrlPBrowser = new FileBrowserComponent(() => {});
    ctrlPBrowser.handleInput("\x10");

    expect((upBrowser as any).selected).toBeGreaterThan(0);
    expect((ctrlPBrowser as any).selected).toBe((upBrowser as any).selected);
  });

  it("treats ctrl+n and ctrl+p like down and up in the options panel", () => {
    const root = createTempDir();
    writeFileSync(join(root, "alpha.txt"), "alpha", "utf8");
    process.chdir(root);

    const downBrowser = new FileBrowserComponent(() => {});
    downBrowser.handleInput("\u001b[Z");
    downBrowser.handleInput("\u001b[B");

    const ctrlNBrowser = new FileBrowserComponent(() => {});
    ctrlNBrowser.handleInput("\u001b[Z");
    ctrlNBrowser.handleInput("\x0e");

    expect((downBrowser as any).focusOnOptions).toBe(true);
    expect((ctrlNBrowser as any).focusOnOptions).toBe(true);
    expect((ctrlNBrowser as any).selectedOption).toBe(
      (downBrowser as any).selectedOption
    );

    const upBrowser = new FileBrowserComponent(() => {});
    upBrowser.handleInput("\u001b[Z");
    upBrowser.handleInput("\u001b[A");

    const ctrlPBrowser = new FileBrowserComponent(() => {});
    ctrlPBrowser.handleInput("\u001b[Z");
    ctrlPBrowser.handleInput("\x10");

    expect((ctrlPBrowser as any).selectedOption).toBe(
      (upBrowser as any).selectedOption
    );
  });
});
