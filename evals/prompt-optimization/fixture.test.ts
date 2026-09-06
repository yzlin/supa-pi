import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/sample-project/", import.meta.url)
);
const onePassPattern = /\b1 pass\b/;
const oneFailPattern = /\b1 fail\b/;
const twoExecutedTestsPattern = /Ran 2 tests across 1 file/;

describe("sample project fixture", () => {
  it("runs both math cases through its default test script", () => {
    const result = spawnSync(process.execPath, ["run", "test"], {
      cwd: fixtureDirectory,
      encoding: "utf8",
      timeout: 10_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const executionSignals = {
      arithmeticExpected12: output.includes("Expected: 12"),
      arithmeticReceived2: output.includes("Received: 2"),
      additionFailed: output.includes("(fail) math > adds numbers"),
      multiplicationPassed: output.includes("(pass) math > multiplies numbers"),
      onePass: onePassPattern.test(output),
      oneFail: oneFailPattern.test(output),
      twoExecutedTests: twoExecutedTestsPattern.test(output),
    };

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(executionSignals).toEqual({
      arithmeticExpected12: true,
      arithmeticReceived2: true,
      additionFailed: true,
      multiplicationPassed: true,
      onePass: true,
      oneFail: true,
      twoExecutedTests: true,
    });
  });
});
