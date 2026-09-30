import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
) as { pi?: { extensions?: string[] } };

test("skill router is the first extension so it observes raw input before prompt writers", () => {
  expect(manifest.pi?.extensions?.[0]).toBe("./extensions/skill-router");
});
