import { describe, expect, it } from "bun:test";

import { filterEntries } from "./file-picker-filter";
import type { FileEntry } from "./file-picker-types";

const entries: FileEntry[] = [
  { name: "index.ts", relativePath: "src/index.ts", isDirectory: false },
  { name: "components", relativePath: "src/components/", isDirectory: true },
  { name: "types.ts", relativePath: "src/types.ts", isDirectory: false },
  {
    name: "input.ts",
    relativePath: "src/components/input.ts",
    isDirectory: false,
  },
  { name: "index.ts", relativePath: "lib/index.ts", isDirectory: false },
  { name: "README.md", relativePath: "README.md", isDirectory: false },
];

describe("file picker filtering", () => {
  it("matches glob queries against relative paths and sorts files and folders together", () => {
    expect(
      filterEntries(entries, "/src/**").map((entry) => entry.relativePath)
    ).toEqual([
      "src/components/",
      "src/components/input.ts",
      "src/index.ts",
      "src/types.ts",
    ]);
  });

  it("uses scoped fuzzy matching to prioritize matches under the typed base path", () => {
    expect(
      filterEntries(entries, "src/in").map((entry) => entry.relativePath)
    ).toEqual(["src/index.ts", "src/components/input.ts"]);
  });

  it("moves the preferred completion path to the front of fuzzy results", () => {
    expect(
      filterEntries(entries, "index", "/lib/index.ts").map(
        (entry) => entry.relativePath
      )
    ).toEqual(["lib/index.ts", "src/index.ts"]);
  });
});
