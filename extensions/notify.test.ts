import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("notify extension", () => {
  it("is registered in package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { pi: { extensions: string[] } };

    expect(packageJson.pi.extensions).toContain("./extensions/notify.ts");
  });
});
