import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { loadWorkspaceFile } from "./files.ts";

const FILE_CHANGED = /outside the current workspace|changed during validation/;
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sift-node-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("loads an ordinary workspace file with Node descriptor semantics", async () => {
  const workspace = await temporaryDirectory();
  await writeFile(join(workspace, "ordinary.txt"), "ordinary");

  assert.equal(
    (await loadWorkspaceFile(workspace, "ordinary.txt")).content,
    "ordinary",
  );
});

test("rejects an outside file reached by a concurrently replaced parent", async () => {
  const workspace = await temporaryDirectory();
  const outside = await temporaryDirectory();
  const parent = join(workspace, "parent");
  await mkdir(parent);
  await writeFile(join(parent, "race.txt"), "inside");
  await writeFile(join(outside, "race.txt"), "outside");

  await assert.rejects(
    loadWorkspaceFile(workspace, "parent/race.txt", undefined, {
      afterRealpath: async () => {
        await rename(parent, join(workspace, "original-parent"));
        await symlink(outside, parent);
      },
    }),
    FILE_CHANGED,
  );
});
