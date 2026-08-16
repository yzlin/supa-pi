import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOAD_EXTENSION_SCRIPT = `
const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const loaderUrl = new URL("./core/extensions/loader.js", codingAgentEntry);
const { loadExtensions } = await import(loaderUrl.href);
const result = await loadExtensions([${JSON.stringify(EXTENSION_PATH)}], ${JSON.stringify(PROJECT_ROOT)});
process.stdout.write(JSON.stringify({ loaded: result.extensions.length, errors: result.errors }));
process.exit(result.errors.length === 0 ? 0 : 1);
`;

it("loads through Pi's Node extension loader", () => {
  const result = spawnSync(
    "node",
    ["--input-type=module", "--eval", LOAD_EXTENSION_SCRIPT],
    { cwd: PROJECT_ROOT, encoding: "utf8" }
  );

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ loaded: 1, errors: [] });
});
