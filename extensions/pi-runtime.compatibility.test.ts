import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface PackageManifest {
  pi?: {
    extensions?: string[];
  };
}

const projectRoot = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8")
) as PackageManifest;
const loadMultipleExtensionsScript = `
const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const loaderUrl = new URL("./core/extensions/loader.js", codingAgentEntry);
const { loadExtensions } = await import(loaderUrl.href);
const result = await loadExtensions([
  ${JSON.stringify(resolve(projectRoot, "extensions/notify.ts"))},
  ${JSON.stringify(resolve(projectRoot, "extensions/execute"))},
], ${JSON.stringify(projectRoot)});
process.stdout.write(JSON.stringify({ loaded: result.extensions.length, errors: result.errors }));
process.exit(result.errors.length === 0 ? 0 : 1);
`;

describe("Pi runtime compatibility", () => {
  test("loads every configured extension", async () => {
    for (const extension of packageJson.pi?.extensions ?? []) {
      const module = await import(resolve(projectRoot, extension));

      expect(module.default).toBeFunction();
    }
  });

  test("loads execute with another extension through Pi's Node loader", () => {
    const result = spawnSync(
      "node",
      ["--input-type=module", "--eval", loadMultipleExtensionsScript],
      { cwd: projectRoot, encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ loaded: 2, errors: [] });
  });
});
