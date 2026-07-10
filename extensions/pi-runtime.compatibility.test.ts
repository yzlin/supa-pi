import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface PackageManifest {
  pi?: {
    extensions?: string[];
  };
}

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")
) as PackageManifest;

describe("Pi runtime compatibility", () => {
  test("loads every configured extension", async () => {
    for (const extension of packageJson.pi?.extensions ?? []) {
      const module = await import(resolve(import.meta.dir, "..", extension));

      expect(module.default).toBeFunction();
    }
  });
});
