import { describe, expect, it } from "bun:test";

import {
  assessTddEvidence,
  coverageVerificationTargets,
  isSupportedTestCommand,
  mutationResultProvesDelta,
  normalizeTddToolMetadata,
  type TddToolCall,
  testCommandHasWriteOption,
  validateTddEvidence,
} from "./tdd-evidence";

const EXPLICIT_RED_IDENTITY_PATTERN =
  /\b(?:formatName|subtract|unrelated|config|plugin)\b/i;

const result = (
  red = "1 failed, 4 passed",
  green = "5 passed, 0 failed, 2 skipped"
) => ({
  status: "done",
  validation: [
    `RED: bun test tests/formatName.test.ts failed with ${red}`,
    `GREEN: bun test tests/formatName.test.ts passed with ${green}`,
    "COVERAGE: `formatName()` behavior and `empty-input` failure path covered",
  ],
  blockers: [],
});

function terminalOnly(): TddToolCall[] {
  return [
    {
      name: "structured_output",
      args: {},
      assistantTurn: 0,
      startOrder: 1,
      endOrder: 2,
      isError: false,
    },
  ];
}

function trajectory(
  redText = "unit > formatName rejects empty input\n1 failed, 4 passed",
  greenText = "unit > formatName rejects empty input\n5 passed, 0 failed, 2 skipped"
): TddToolCall[] {
  const correlatedRed = EXPLICIT_RED_IDENTITY_PATTERN.test(redText)
    ? redText
    : `unit > formatName regression\n${redText}`;
  const correlatedGreen = `unit > formatName regression\n${greenText}`;
  return [
    {
      name: "bash",
      args: { command: "bun test tests/formatName.test.ts" },
      assistantTurn: 0,
      startOrder: 1,
      endOrder: 2,
      isError: true,
      resultText: correlatedRed,
    },
    {
      name: "edit",
      args: {
        path: "src/unit.ts",
        oldText: "return old",
        newText: "return fixed",
      },
      assistantTurn: 1,
      startOrder: 4,
      endOrder: 5,
      isError: false,
    },
    {
      name: "bash",
      args: { command: "bun test tests/formatName.test.ts" },
      assistantTurn: 2,
      startOrder: 7,
      endOrder: 8,
      isError: false,
      resultText: correlatedGreen,
    },
    {
      name: "structured_output",
      args: {},
      assistantTurn: 3,
      startOrder: 10,
      endOrder: 11,
      isError: false,
    },
  ];
}

describe("TDD evidence validation", () => {
  it("enforces an optionally declared exact RED/GREEN command", () => {
    expect(
      validateTddEvidence(
        result(),
        trajectory(),
        [],
        "Fix formatName empty input",
        "bun test tests/formatName.test.ts"
      )
    ).toBeUndefined();
    expect(
      validateTddEvidence(
        result(),
        trajectory(),
        [],
        "Fix formatName empty input",
        "bun test tests/other.test.ts"
      )
    ).toContain("RED command must exactly match declared redGreenCommand");

    const differentGreen = trajectory();
    differentGreen[2]!.args = { command: "bun test tests/other.test.ts" };
    const differentGreenResult = result();
    differentGreenResult.validation[1] =
      "GREEN: bun test tests/other.test.ts passed with 5 passed";
    expect(
      validateTddEvidence(
        differentGreenResult,
        differentGreen,
        [],
        "Fix formatName empty input",
        "bun test tests/formatName.test.ts"
      )
    ).toContain("GREEN command must exactly match declared redGreenCommand");
  });

  it("accepts retained authoritative truncated evidence and rejects lost outcomes", () => {
    const retained = trajectory();
    retained[0]!.resultTruncated = true;
    retained[0]!.resultText =
      "unit > formatName rejects empty input\n1 failed\n[... output middle omitted ...]\nverbose tail";
    retained[2]!.resultTruncated = true;
    retained[2]!.resultText =
      "verbose head\n[... output middle omitted ...]\nunit > formatName rejects empty input\n5 passed";
    expect(validateTddEvidence(result(), retained)).toBeUndefined();

    const unrelated = trajectory();
    unrelated.splice(3, 0, {
      name: "bash",
      args: { command: "pwd" },
      assistantTurn: 2,
      startOrder: 9,
      endOrder: 10,
      isError: false,
      resultText: "large read-only output",
      resultTruncated: true,
    });
    unrelated[4]!.startOrder = 11;
    unrelated[4]!.endOrder = 12;
    expect(validateTddEvidence(result(), unrelated)).toBeUndefined();

    const lostRed = trajectory();
    lostRed[0]!.resultTruncated = true;
    lostRed[0]!.resultText =
      "unit > formatName regression\n[... output middle omitted ...]\nverbose output";
    expect(validateTddEvidence(result(), lostRed)).toBe(
      "Truncated test output did not retain authoritative RED evidence."
    );

    const lostGreen = trajectory();
    lostGreen[2]!.resultTruncated = true;
    lostGreen[2]!.resultText =
      "unit > formatName regression\n[... output middle omitted ...]\nverbose output";
    expect(validateTddEvidence(result(), lostGreen)).toBe(
      "Truncated test output did not retain authoritative GREEN evidence."
    );
  });

  it("recognizes direct common runners but rejects scripts and shell probes", () => {
    for (const command of [
      "bun test x.test.ts",
      "vitest x.test.ts",
      "npx jest x",
      "python -m pytest x",
      "cargo test",
      "go test ./...",
      "dotnet test",
      "mvn test",
      "./gradlew test",
      "./gradlew :app:test",
      "swift test",
    ]) {
      expect(isSupportedTestCommand(command)).toBe(true);
    }
    for (const command of [
      "bun run test:unit",
      "npm test",
      "npm run test:unit",
      "pnpm test",
      "pnpm run test:unit",
      "yarn test",
      "yarn run test:unit",
      "test -f package.json",
      "echo test",
      "echo tests/formatName.test.ts",
      "cat /tmp/test",
      "bun run build && echo test",
      "gradle test",
      "./gradlew build",
      "/tmp/gradlew test",
      "/tmp/bun test x.test.ts",
      "./bun test x.test.ts",
      "PATH=/tmp bun test x.test.ts",
    ]) {
      expect(isSupportedTestCommand(command)).toBe(false);
    }
  });

  it("accepts end-to-end Swift, Gradle, .NET, and Maven RED/GREEN evidence", () => {
    for (const [command, red, green] of [
      [
        "swift test",
        "FormatNameTests empty input\nTest Suite 'All tests' failed\nExecuted 1 test, with 1 failure",
        "FormatNameTests empty input\nTest Suite 'All tests' passed\nExecuted 1 test, with 0 failures",
      ],
      [
        "./gradlew test",
        "FormatNameTests empty input\n1 test completed, 1 failed\nBUILD FAILED",
        "FormatNameTests empty input\n1 test completed, 0 failed\nBUILD SUCCESSFUL",
      ],
      [
        "dotnet test",
        "FormatNameTests empty input\nFailed! - Failed: 1, Passed: 0, Total: 1",
        "FormatNameTests empty input\nPassed! - Failed: 0, Passed: 1, Total: 1",
      ],
      [
        "mvn test",
        "FormatNameTests empty input\nTests run: 1, Failures: 1, Errors: 0, Skipped: 0",
        "FormatNameTests empty input\nTests run: 1, Failures: 0, Errors: 0, Skipped: 0",
      ],
    ]) {
      const calls = trajectory(red, green);
      calls[0]!.args = { command };
      calls[2]!.args = { command };
      const evidence = result();
      evidence.validation[0] = `RED: ${command} failed with the formatName empty-input regression`;
      evidence.validation[1] = `GREEN: ${command} passed the formatName empty-input regression`;
      expect(
        validateTddEvidence(
          evidence,
          calls,
          [],
          "Fix formatName empty input behavior"
        )
      ).toBeUndefined();
    }
  });

  it("accepts default Gradle success output only for an executed test task", () => {
    const red =
      "FormatNameTests empty input\n1 test completed, 1 failed\nBUILD FAILED";
    const acceptedCalls = trajectory(red, "> Task :test\nBUILD SUCCESSFUL");
    acceptedCalls[0]!.args = { command: "./gradlew test" };
    acceptedCalls[2]!.args = { command: "./gradlew test" };
    const evidence = result(red, "> Task :test\nBUILD SUCCESSFUL");
    evidence.validation[0] =
      "RED: ./gradlew test failed with the formatName empty-input regression";
    evidence.validation[1] =
      "GREEN: ./gradlew test passed the formatName empty-input regression";
    expect(
      validateTddEvidence(
        evidence,
        acceptedCalls,
        [],
        "Fix formatName empty input behavior"
      )
    ).toBeUndefined();

    for (const output of [
      "> Task :test SKIPPED\nBUILD SUCCESSFUL",
      "> Task :test NO-SOURCE\nBUILD SUCCESSFUL",
      "> Task :test UP-TO-DATE\nBUILD SUCCESSFUL",
      "> Task :test FAILED\nBUILD FAILED",
      "> Task :test\nBUILD SUCCESSFUL\nBUILD FAILED",
    ]) {
      const calls = trajectory(red, output);
      calls[0]!.args = { command: "./gradlew test" };
      calls[2]!.args = { command: "./gradlew test" };
      expect(
        validateTddEvidence(
          evidence,
          calls,
          [],
          "Fix formatName empty input behavior"
        )
      ).toBeDefined();
    }
  });

  it("accepts authoritative mixed Bun, Jest, and Pytest-like summaries", () => {
    for (const [red, green] of [
      ["1 failed, 4 passed", "5 passed, 0 failed, 2 skipped"],
      [
        "Tests: 1 failed, 4 passed, 5 total",
        "Tests: 5 passed, 0 failed, 5 total",
      ],
      ["1 failed, 4 passed in 0.20s", "5 passed, 2 skipped in 0.18s"],
    ]) {
      expect(
        validateTddEvidence(result(red, green), trajectory(red, green))
      ).toBeUndefined();
    }
  });

  it("accepts only missing-reference REDs correlated with retained regression intent", () => {
    const withIntent = (red: string, symbol = "formatName") => {
      const calls = trajectory(red, `${symbol} regression\n5 passed`);
      calls.unshift({
        name: "write",
        ...normalizeTddToolMetadata("write", {
          path: "tests/formatName.test.ts",
          content: `import { ${symbol} } from "../src/format"; test("regression", () => ${symbol}());`,
        }),
        assistantTurn: 0,
        startOrder: -2,
        endOrder: -1,
        isError: false,
        mutationProven: true,
      });
      return calls;
    };
    for (const red of [
      'error: No matching export in "src/format.ts" for import "formatName"\n(fail) regression\n 1 fail',
      `SyntaxError: Export named 'formatName' not found in module './src/format.ts'\nregression\n1 failed, 0 passed`,
      `Module '"./src/format"' has no exported member 'formatName'.\nregression\n1 failed, 0 passed`,
      `Cannot find module './formatName'\n(fail) regression\n1 fail`,
    ]) {
      expect(
        validateTddEvidence(
          result(red, "5 passed"),
          withIntent(red),
          [],
          "Implement formatName regression"
        )
      ).toBeUndefined();
    }

    for (const [red, symbol] of [
      ["No tests found", "formatName"],
      ["Cannot find module 'unrelatedHelper'\n1 failed", "formatName"],
      [
        "SyntaxError: Unexpected token '}' in vitest.config.ts\n1 failed",
        "formatName",
      ],
      [
        "Failed to load config from vitest.config.ts\nNo matching export in plugin.ts for import 'config'\n1 failed",
        "config",
      ],
      [
        "ReferenceError: unrelatedHelper is not defined\n1 failed",
        "formatName",
      ],
    ]) {
      expect(validateTddEvidence(result(), withIntent(red, symbol))).toContain(
        "actual failing/passing test output"
      );
    }
    const subtractRed =
      'error: No matching export in "src/math.ts" for import "subtract"\nregression\n1 failed';
    const subtractResult = result(subtractRed, "5 passed");
    subtractResult.validation[2] =
      "COVERAGE: `subtract()` failure path covered";
    expect(
      validateTddEvidence(
        subtractResult,
        withIntent(subtractRed, "subtract"),
        [],
        "Add subtract format behavior"
      )
    ).toBeUndefined();
    for (const count of [10, 20, 100]) {
      const red = `1 failed, ${count - 1} passed`;
      const green = `${count} tests passed, 0 failed`;
      expect(
        validateTddEvidence(result(red, green), trajectory(red, green))
      ).toBeUndefined();
    }
  });

  it("accepts strongly correlated ENOENT behavior REDs but rejects missing targets", () => {
    const red =
      "formatName falls back when config file is absent\nError: ENOENT: no such file or directory, open 'optional.json'\n1 failed";
    const calls = trajectory(
      red,
      "formatName falls back when config file is absent\n1 passed"
    );
    calls.unshift({
      name: "write",
      ...normalizeTddToolMetadata("write", {
        path: "tests/formatName.test.ts",
        content:
          'test("formatName falls back when config file is absent", () => formatName());',
      }),
      assistantTurn: 0,
      startOrder: -2,
      endOrder: -1,
      isError: false,
      mutationProven: true,
    });
    const evidence = result(red, "1 passed");
    expect(
      validateTddEvidence(
        evidence,
        calls,
        [],
        "Make formatName fall back when config file is absent"
      )
    ).toBeUndefined();

    for (const setupFailure of [
      "error: ENOENT: no such file or directory, open 'tests/formatName.test.ts'\n1 failed",
      "error during collection: ENOENT: no such file or directory, open 'optional.json'\n1 failed",
      "bun: command not found\n1 failed",
    ]) {
      const rejected = calls.map((call) => ({ ...call }));
      rejected[1] = { ...rejected[1]!, resultText: setupFailure };
      expect(
        validateTddEvidence(
          evidence,
          rejected,
          [],
          "Make formatName fall back when config file is absent"
        )
      ).toContain("actual failing/passing test output");
    }
  });

  it("derives RED titles only from successful proven test deltas", () => {
    const metadata = normalizeTddToolMetadata("edit", {
      path: "tests/formatName.test.ts",
      oldText: 'test("existing behavior", () => old());',
      newText:
        'test("existing behavior", () => changed()); test("new regression", () => added());',
    });
    expect(metadata.regressionTitles).toEqual(["new regression"]);

    for (const attempted of [
      { isError: true, mutationProven: true },
      { isError: false, mutationProven: false },
    ]) {
      const calls = trajectory();
      calls.unshift({
        name: "write",
        ...normalizeTddToolMetadata("write", {
          path: "tests/formatName.test.ts",
          content:
            'test("formatName rejects empty input", () => formatName(""));',
        }),
        assistantTurn: 0,
        startOrder: -2,
        endOrder: -1,
        ...attempted,
      });
      expect(
        validateTddEvidence(result(), calls, [], "Fix formatName empty input")
      ).toContain("actual failing/passing test output");
    }
  });

  it("allows test-first setup but requires production mutation between RED and GREEN", () => {
    const testFirst = trajectory();
    testFirst.unshift({
      name: "write",
      args: { path: "tests/formatName.test.ts" },
      assistantTurn: 0,
      startOrder: 0,
      endOrder: 0.5,
      isError: false,
      mutationProven: true,
    });
    expect(
      validateTddEvidence(result(), testFirst, [], "Fix formatName")
    ).toBeUndefined();

    const testsOnly = trajectory();
    testsOnly[1] = {
      ...testsOnly[1],
      args: { path: "tests/formatName.test.ts" },
    };
    expect(validateTddEvidence(result(), testsOnly)).toContain(
      "regression-test mutations after RED"
    );

    const goTestsOnly = trajectory();
    goTestsOnly[1] = { ...goTestsOnly[1], args: { path: "pkg/unit_test.go" } };
    expect(validateTddEvidence(result(), goTestsOnly)).toContain(
      "regression-test mutations after RED"
    );

    for (const path of [
      "e2e/login.ts",
      "end-to-end/login.ts",
      "e2e\\login.ts",
    ]) {
      const e2eOnly = trajectory();
      e2eOnly[1] = { ...e2eOnly[1], args: { path } };
      expect(validateTddEvidence(result(), e2eOnly)).toContain(
        "regression-test mutations after RED"
      );
    }

    const afterGreen = trajectory();
    afterGreen[1] = {
      ...afterGreen[1],
      startOrder: 9,
      endOrder: 10,
      assistantTurn: 3,
    };
    expect(validateTddEvidence(result(), afterGreen)).toContain("final GREEN");
  });

  it("treats supported test-runner write options as mutations", () => {
    const denoWriteCommands = [
      "deno test --allow-net unit_test.ts",
      "deno test --allow-net=example.com unit_test.ts",
      "deno test --allow-write unit_test.ts",
      "deno test --allow-write=./tmp unit_test.ts",
      "deno test --allow-run unit_test.ts",
      "deno test --allow-run=git unit_test.ts",
      "deno test --allow-ffi unit_test.ts",
      "deno test --allow-ffi=./native.so unit_test.ts",
      "deno test -A unit_test.ts",
      "deno test --allow-all unit_test.ts",
      "deno test --config=deno.json unit_test.ts",
      "deno test --permission-set=test unit_test.ts",
      "deno test --unstable unit_test.ts",
    ];
    for (const command of denoWriteCommands) {
      expect(testCommandHasWriteOption(command)).toBe(true);
    }

    for (const command of [
      "jest unit.test.ts -u",
      "npx vitest unit.test.ts --updateSnapshot",
      "bun test unit.test.ts --preload ./test-hook.ts",
      "mocha unit.test.js --require ./test-hook.js",
      "vitest unit.test.ts --setupFiles ./test-hook.ts",
      "jest unit.test.ts --globalSetup ./test-hook.ts",
      "vitest unit.test.ts --outputFile=report.json",
      "pytest unit_test.py --junitxml report.xml",
      "pytest unit_test.py --cov",
      "pytest unit_test.py --cov package",
      "pytest unit_test.py --cov=package",
      "pytest unit_test.py --cov-report html",
      "pytest unit_test.py --cov-report=html:coverage-html",
      "pytest unit_test.py --cov-report xml:coverage.xml",
      "pytest unit_test.py --cov-report=json:coverage.json",
      "pytest unit_test.py --cov-report lcov:coverage.lcov",
      "pytest unit_test.py --cov-report=lcov",
      "mocha unit.test.js --reporter-option output=report.json",
      "go test ./... -coverprofile=coverage.out",
      "deno test unit_test.ts --junit-path=report.xml",
      ...denoWriteCommands,
      "cargo test --timings",
      "ava unit.test.js --update-snapshots",
      "swift test --enable-code-coverage",
      "swift test --xunit-output results.xml",
      "./gradlew test --profile",
      "./gradlew test --write-locks",
      "dotnet test --results-directory artifacts",
      "dotnet test --collect 'XPlat Code Coverage'",
      "mvn test -Dreport.file=results.xml",
    ]) {
      const afterGreen = trajectory();
      afterGreen.splice(3, 0, {
        name: "bash",
        args: { command },
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
      });
      afterGreen[4] = {
        ...afterGreen[4],
        startOrder: 12,
        endOrder: 13,
        assistantTurn: 4,
      };
      expect(validateTddEvidence(result(), afterGreen)).toContain(
        "TDD ordering"
      );

      const asEvidence = trajectory();
      asEvidence[0] = { ...asEvidence[0]!, args: { command } };
      asEvidence[2] = { ...asEvidence[2]!, args: { command } };
      const claimed = result();
      claimed.validation[0] = `RED: ${command} failed with 1 failed`;
      claimed.validation[1] = `GREEN: ${command} passed with 5 passed`;
      expect(validateTddEvidence(claimed, asEvidence)).toContain(
        "actual failing/passing test output"
      );
    }

    for (const command of [
      "bun test",
      "jest unit.test.ts --testNamePattern filter",
      "vitest unit.test.ts --reporter verbose",
      "pytest unit_test.py",
      "pytest unit_test.py -k filter",
      "cargo test unit_filter",
      "swift test --filter FormatNameTests",
      "./gradlew test --tests FormatNameTests",
      "dotnet test --filter FormatNameTests",
      "mvn test",
    ]) {
      const afterGreen = trajectory();
      afterGreen.splice(3, 0, {
        name: "bash",
        args: { command },
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
      });
      afterGreen[4] = {
        ...afterGreen[4],
        startOrder: 12,
        endOrder: 13,
        assistantTurn: 4,
      };
      expect(validateTddEvidence(result(), afterGreen)).toBeUndefined();
    }
  });

  it("permits proven text-only Pytest coverage before or after focused GREEN", () => {
    const command = "python -m pytest --cov=src --cov-report=term";
    expect(coverageVerificationTargets(command)).toEqual([".coverage"]);
    const coverageCall = (startOrder: number): TddToolCall => ({
      name: "bash",
      args: { command },
      mutationTargets: [".coverage"],
      mutationDelta: [{ path: ".coverage", status: "created" }],
      coverageArtifactProof: true,
      runnerWorkspaceProof: true,
      assistantTurn: 3,
      startOrder,
      endOrder: startOrder + 1,
      isError: false,
      resultText:
        "test_format_name.py::test_empty_input PASSED\n5 passed\nLines: 92%",
    });
    const evidence = result();
    evidence.validation[2] = "COVERAGE: Lines: 92%";

    const afterGreen = trajectory();
    afterGreen.splice(3, 0, coverageCall(9));
    afterGreen[4] = {
      ...afterGreen[4]!,
      assistantTurn: 4,
      startOrder: 12,
      endOrder: 13,
    };
    expect(validateTddEvidence(evidence, afterGreen)).toBeUndefined();

    const beforeFinalRerun = trajectory();
    beforeFinalRerun.splice(2, 0, coverageCall(6));
    beforeFinalRerun[3] = {
      ...beforeFinalRerun[3]!,
      assistantTurn: 4,
      startOrder: 10,
      endOrder: 11,
    };
    beforeFinalRerun[4] = {
      ...beforeFinalRerun[4]!,
      assistantTurn: 5,
      startOrder: 13,
      endOrder: 14,
    };
    expect(validateTddEvidence(evidence, beforeFinalRerun)).toBeUndefined();
  });

  it("rejects incomplete or source/test-mutating coverage runner proofs", () => {
    const command = "python -m pytest --cov=src --cov-report=term";
    for (const unsafeProof of [
      {},
      { runnerWorkspaceProof: false },
      {
        runnerWorkspaceProof: true,
        runnerWorkspaceDelta: [{ path: "src/unit.py", status: "changed" }],
      },
      {
        runnerWorkspaceProof: true,
        runnerWorkspaceDelta: [
          { path: "tests/test_unit.py", status: "changed" },
        ],
      },
    ] satisfies Partial<TddToolCall>[]) {
      const calls = trajectory();
      calls.splice(3, 0, {
        name: "bash",
        args: { command },
        mutationTargets: [".coverage"],
        mutationDelta: [{ path: ".coverage", status: "created" }],
        coverageArtifactProof: true,
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
        resultText: "5 passed\nLines: 92%",
        ...unsafeProof,
      });
      calls[4] = {
        ...calls[4]!,
        assistantTurn: 4,
        startOrder: 12,
        endOrder: 13,
      };
      expect(validateTddEvidence(result(), calls)).toContain(
        "changed relevant workspace files"
      );
    }
  });

  it("rejects unproven, unsafe, or source-mutating coverage invocations", () => {
    const command = "python -m pytest --cov=src --cov-report=term";
    const rejectedCalls: TddToolCall[] = [
      {
        name: "bash",
        args: { command },
        mutationTargets: [".coverage"],
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
        resultText: "5 passed\nLines: 92%",
      },
      {
        name: "bash",
        args: { command },
        mutationTargets: [".coverage"],
        mutationDelta: [{ path: "src/unit.py", status: "changed" }],
        coverageArtifactProof: true,
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
        resultText: "5 passed\nLines: 92%",
      },
      {
        name: "bash",
        args: {
          command: "python -m pytest --cov=src --cov-report=html:/tmp/report",
        },
        coverageArtifactProof: true,
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
        resultText: "5 passed\nLines: 92%",
      },
    ];
    expect(
      coverageVerificationTargets(
        "python -m pytest --cov=src --cov-report=html:/tmp/report"
      )
    ).toBeUndefined();
    expect(
      coverageVerificationTargets(
        "python -m pytest --cov=src --cov-report=term --junitxml=report.xml"
      )
    ).toBeUndefined();
    for (const coverageCall of rejectedCalls) {
      const calls = trajectory();
      calls.splice(3, 0, coverageCall);
      calls[4] = {
        ...calls[4]!,
        assistantTurn: 4,
        startOrder: 12,
        endOrder: 13,
      };
      expect(validateTddEvidence(result(), calls)).toContain("TDD ordering");
    }
  });

  it("rejects mutation-capable shell actions after GREEN", () => {
    for (const command of [
      "sed -i '' 's/x/y/' src/unit.ts",
      "cp /tmp/x src/unit.ts",
      "echo x > src/unit.ts",
      "cat /tmp/x > src/unit.ts",
      "find src -name '*.tmp' -delete",
      "find src -name '*.ts' -fprint /tmp/files",
      "find src -name '*.ts' -fprint0 /tmp/files",
      "find src -name '*.ts' -fprintf /tmp/files '%p\\n'",
      "find src -name '*.ts' -fls /tmp/files",
      "git diff --output /tmp/diff",
      "git diff --output=/tmp/diff",
      "cat $(generate-file)",
      "cat `generate-file`",
      "bun test tests/$(generate-name).test.ts",
      "bun test tests/\u0024{TEST_NAME}.test.ts",
      'python -c \'open("src/unit.ts", "w").write("x")\'',
      'ruby -e \'File.write("src/unit.ts", "x")\'',
      "node mutate.js",
      "custom-command src/unit.ts",
      "/tmp/cat src/unit.ts",
      "/tmp/bun test tests/formatName.test.ts",
      "./git status --short",
      "PATH=/tmp cat src/unit.ts",
    ]) {
      const mutating = trajectory();
      mutating.splice(3, 0, {
        name: "bash",
        args: { command },
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
      });
      mutating[4] = {
        ...mutating[4],
        startOrder: 12,
        endOrder: 13,
        assistantTurn: 4,
      };
      expect(validateTddEvidence(result(), mutating)).toContain("TDD ordering");
    }

    for (const command of [
      "cat src/unit.ts",
      "grep -E 'alpha|beta' src/unit.ts",
      "rg '\\$literal|price' src/unit.ts",
      'grep -E "alpha|beta" src/unit.ts',
    ]) {
      const reading = trajectory();
      reading.splice(3, 0, {
        name: "bash",
        args: { command },
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
      });
      reading[4] = {
        ...reading[4],
        startOrder: 12,
        endOrder: 13,
        assistantTurn: 4,
      };
      expect(validateTddEvidence(result(), reading)).toBeUndefined();
    }

    const legitimateTest = trajectory();
    expect(validateTddEvidence(result(), legitimateTest)).toBeUndefined();
  });

  it("classifies every shell Git command as mutation-capable", () => {
    for (const command of [
      "GIT_EXTERNAL_DIFF=/tmp/helper git diff",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.x.command GIT_CONFIG_VALUE_0=/tmp/helper git show HEAD",
      "git diff --ext-diff",
      "git show --textconv HEAD:file",
      "git -c diff.external=/tmp/helper log -p",
      "git --config-env=diff.external=HELPER diff",
      "git config user.note diff",
      "git alias-that-runs-a-shell-command status",
      "git -c alias.safe=!helper safe status",
      "git --config-env=core.fsmonitor=FSMONITOR status",
      "GIT_OPTIONAL_LOCKS=0 git status --short",
      "git --unknown-global-option status",
      "git status --no-optional-locks",
      "git diff --output=/tmp/diff status",
    ]) {
      const calls = trajectory();
      calls.splice(3, 0, {
        name: "bash",
        args: { command },
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
      });
      calls[4] = {
        ...calls[4]!,
        assistantTurn: 4,
        startOrder: 12,
        endOrder: 13,
      };
      expect(validateTddEvidence(result(), calls)).toContain("TDD ordering");
    }

    for (const command of [
      "git status --short",
      "git diff --no-ext-diff --no-textconv",
      "git log -n1",
    ]) {
      const calls = trajectory();
      calls.splice(3, 0, {
        name: "bash",
        args: { command },
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
      });
      calls[4] = {
        ...calls[4]!,
        assistantTurn: 4,
        startOrder: 12,
        endOrder: 13,
      };
      expect(validateTddEvidence(result(), calls)).toContain("TDD ordering");
    }
  });

  it("classifies mutation capability independently of failed tool status", () => {
    const failedMutation = trajectory();
    failedMutation.splice(3, 0, {
      name: "bash",
      args: { command: "echo x > src/math.ts; false" },
      assistantTurn: 3,
      startOrder: 9,
      endOrder: 10,
      isError: true,
    });
    failedMutation[4] = {
      ...failedMutation[4],
      assistantTurn: 4,
      startOrder: 12,
      endOrder: 13,
    };
    expect(validateTddEvidence(result(), failedMutation)).toContain(
      "TDD ordering"
    );

    const failedPureTest = trajectory();
    failedPureTest.splice(3, 0, {
      name: "bash",
      args: { command: "bun test tests/other.test.ts" },
      assistantTurn: 3,
      startOrder: 9,
      endOrder: 10,
      isError: true,
      resultText: "1 failed, 0 passed",
    });
    failedPureTest[4] = {
      ...failedPureTest[4],
      assistantTurn: 4,
      startOrder: 12,
      endOrder: 13,
    };
    expect(validateTddEvidence(result(), failedPureTest)).toContain(
      "every supported test failure"
    );

    const resolvedPureTest = failedPureTest.toSpliced(4, 0, {
      name: "bash",
      args: { command: "bun test tests/other.test.ts" },
      assistantTurn: 4,
      startOrder: 11,
      endOrder: 12,
      isError: false,
      resultText: "1 passed, 0 failed",
    });
    resolvedPureTest[5] = {
      ...resolvedPureTest[5]!,
      assistantTurn: 5,
      startOrder: 14,
      endOrder: 15,
    };
    expect(validateTddEvidence(result(), resolvedPureTest)).toBeUndefined();
  });

  it("canonicalizes discrete mutation targets and fails closed on mixed targets", () => {
    const disguisedProduction = trajectory();
    disguisedProduction[1] = {
      ...disguisedProduction[1],
      args: {
        path: "tests/../src/math.ts",
        oldText: "return old",
        newText: "return fixed",
      },
    };
    expect(validateTddEvidence(result(), disguisedProduction)).toBeUndefined();

    const mixedPatch = trajectory();
    mixedPatch[1] = {
      ...mixedPatch[1],
      name: "apply_patch",
      args: {
        patch:
          "*** Begin Patch\n*** Update File: tests/formatName.test.ts\n@@\n-old test\n+new test\n*** Update File: src/math.ts\n@@\n-old code\n+new code\n*** End Patch",
      },
    };
    expect(validateTddEvidence(result(), mixedPatch)).toContain(
      "regression-test mutations after RED"
    );

    const testOnlyPatch = trajectory();
    testOnlyPatch[1] = {
      ...testOnlyPatch[1],
      name: "apply_patch",
      args: {
        patch:
          "*** Begin Patch\n*** Update File: tests/formatName.test.ts\n@@\n-old test\n+new test\n*** End Patch",
      },
    };
    expect(validateTddEvidence(result(), testOnlyPatch)).toContain(
      "regression-test mutations after RED"
    );

    for (const path of [
      "../tests/formatName.test.ts",
      "/tmp/unit.test.ts",
      "C:\\tests\\unit.test.ts",
      "\\tests\\unit.test.ts",
    ]) {
      const unsafeTarget = trajectory();
      unsafeTarget.unshift({
        name: "write",
        args: { path },
        assistantTurn: 0,
        startOrder: -2,
        endOrder: -1,
        isError: true,
      });
      expect(validateTddEvidence(result(), unsafeTarget)).toContain(
        "actual failing/passing test output"
      );
    }
  });

  it("rejects mutating shell implementation calls but keeps reads allowed", () => {
    const mutating = trajectory();
    mutating.splice(2, 0, {
      name: "bash",
      args: { command: "sed -i '' 's/old/new/' tests/formatName.test.ts" },
      assistantTurn: 2,
      startOrder: 6,
      endOrder: 6.5,
      isError: false,
    });
    expect(validateTddEvidence(result(), mutating)).toContain(
      "mutation-capable shell calls"
    );

    const reading = trajectory();
    reading.splice(2, 0, {
      name: "bash",
      args: { command: "cat src/unit.ts" },
      assistantTurn: 2,
      startOrder: 6,
      endOrder: 6.5,
      isError: false,
    });
    expect(validateTddEvidence(result(), reading)).toBeUndefined();
  });

  it("does not accept mutation-capable no-op shell calls as implementation proof", () => {
    for (const command of ["true", "echo no-op"]) {
      const calls = trajectory();
      calls[1] = {
        name: "bash",
        args: { command },
        assistantTurn: 1,
        startOrder: 4,
        endOrder: 5,
        isError: false,
      };
      expect(validateTddEvidence(result(), calls)).toContain(
        "mutation-capable shell calls"
      );
    }
  });

  it("does not accept a failed discrete edit as the implementation mutation", () => {
    const calls = trajectory();
    calls[1] = { ...calls[1], isError: true };
    expect(validateTddEvidence(result(), calls)).toContain(
      "production implementation mutation"
    );

    calls.splice(2, 0, {
      name: "bash",
      args: { command: "custom-mutator src/unit.ts" },
      assistantTurn: 2,
      startOrder: 5.5,
      endOrder: 6,
      isError: true,
    });
    expect(validateTddEvidence(result(), calls)).toContain(
      "mutation-capable shell calls"
    );
  });

  it("rejects production mutation before RED even with a later valid edit", () => {
    const calls = trajectory();
    calls.unshift({
      name: "edit",
      args: { path: "src/pre-red.ts" },
      assistantTurn: 0,
      startOrder: -2,
      endOrder: -1,
      isError: false,
    });
    expect(validateTddEvidence(result(), calls)).toContain(
      "production mutations before RED"
    );
  });

  it("retains bounded Rust write classification without retaining content", () => {
    const production = normalizeTddToolMetadata("write", {
      path: "src/new.rs",
      content: "pub fn answer() -> i32 { 42 }",
    });
    expect(production).toMatchObject({
      args: {},
      mutationTargets: ["src/new.rs"],
      hasProductionTargets: true,
      hasTestTargets: false,
      mutationAmbiguous: false,
      rustWriteContent: "production",
    });
    expect(JSON.stringify(production)).not.toContain("answer");

    const inlineTest = normalizeTddToolMetadata("write", {
      path: "src/new.rs",
      content: "#[cfg(test)]\nmod tests { #[test] fn works() {} }",
    });
    expect(inlineTest).toMatchObject({
      hasProductionTargets: true,
      hasTestTargets: true,
      mutationAmbiguous: true,
      rustWriteContent: "test",
    });

    const calls = trajectory();
    calls[1] = {
      ...calls[1]!,
      name: "write",
      ...production,
      mutationProven: true,
    };
    expect(validateTddEvidence(result(), calls)).toBeUndefined();
    calls[1] = { ...calls[1]!, name: "write", ...inlineTest };
    expect(validateTddEvidence(result(), calls)).toContain(
      "regression-test mutations after RED"
    );
  });

  it("conservatively classifies clear Vitest and Python doctest source edits", () => {
    for (const [path, oldText, newText] of [
      [
        "src/format.ts",
        'it("rejects empty input", () => { expect(formatName("")).toThrow(); });',
        'it("rejects empty input", () => { expect(formatName("")).toThrow("empty"); });',
      ],
      [
        "src/format.py",
        ">>> format_name('')\nTraceback (most recent call last): ValueError",
        ">>> format_name('')\nTraceback (most recent call last): ValueError: empty",
      ],
    ]) {
      const metadata = normalizeTddToolMetadata("edit", {
        path,
        oldText,
        newText,
      });
      expect(metadata).toMatchObject({
        mutationTargets: [path],
        hasTestTargets: true,
        hasProductionTargets: false,
        mutationAmbiguous: false,
        editOldSnippet: oldText,
        editNewSnippet: newText,
      });

      const testFirst = trajectory();
      testFirst.unshift({
        name: "edit",
        ...metadata,
        assistantTurn: 0,
        startOrder: -2,
        endOrder: -1,
        isError: false,
      });
      expect(
        validateTddEvidence(
          result(),
          testFirst,
          [],
          "Fix formatName format_name empty input"
        )
      ).toBeUndefined();

      const weakenedAfterRed = trajectory();
      weakenedAfterRed[1] = {
        ...weakenedAfterRed[1]!,
        name: "edit",
        ...metadata,
      };
      expect(validateTddEvidence(result(), weakenedAfterRed)).toContain(
        "regression-test mutations after RED"
      );
    }

    const mixed = normalizeTddToolMetadata("edit", {
      path: "src/format.ts",
      oldText: 'it("works", () => expect(formatName("x")).toBe("x"));',
      newText:
        'export function formatName(value: string) { return value; }\nit("works", () => expect(formatName("x")).toBe("x"));',
    });
    expect(mixed).toMatchObject({
      hasTestTargets: true,
      hasProductionTargets: true,
      mutationAmbiguous: true,
    });

    for (const trailingProduction of [
      ">>> format_name('x')\n'x'\ndef format_name(value): return value",
      ">>> format_name('x')\n'x'\nproduction_value = format_name('x')",
    ]) {
      const mixedDoctest = normalizeTddToolMetadata("edit", {
        path: "src/format.py",
        oldText: ">>> format_name('x')\n'x'",
        newText: trailingProduction,
      });
      expect(mixedDoctest).toMatchObject({
        hasTestTargets: true,
        hasProductionTargets: true,
        mutationAmbiguous: true,
      });
    }

    const commentOnlyTail = normalizeTddToolMetadata("edit", {
      path: "src/format.ts",
      oldText: 'test("works", () => expect(formatName("x")).toBe("x"));',
      newText:
        'test("works", () => expect(formatName("x")).toBe("x")); // regression\n/* retained note */',
    });
    expect(commentOnlyTail).toMatchObject({
      hasTestTargets: true,
      hasProductionTargets: false,
      mutationAmbiguous: false,
    });

    const trailingProduction = normalizeTddToolMetadata("edit", {
      path: "src/format.ts",
      oldText: 'test("works", () => expect(formatName("x")).toBe("x"));',
      newText:
        'test("works", () => expect(formatName("x")).toBe("x")); export const production = true;',
    });
    expect(trailingProduction).toMatchObject({
      hasTestTargets: true,
      hasProductionTargets: true,
      mutationAmbiguous: true,
    });
    const beforeRed = trajectory();
    beforeRed[0] = {
      ...beforeRed[0]!,
      resultText: "works\n1 failed, 4 passed",
    };
    beforeRed.unshift({
      name: "edit",
      ...trailingProduction,
      assistantTurn: 0,
      startOrder: -2,
      endOrder: -1,
      isError: false,
    });
    expect(validateTddEvidence(result(), beforeRed, [], "Fix works")).toContain(
      "production mutations before RED"
    );

    const bounded = normalizeTddToolMetadata("edit", {
      path: "src/large.ts",
      oldText: `test("large", () => { ${"x".repeat(3000)} });`,
      newText: `test("large", () => { ${"y".repeat(4000)} });`,
    });
    expect(Buffer.byteLength(bounded.editOldSnippet ?? "")).toBeLessThanOrEqual(
      2000
    );
    expect(Buffer.byteLength(bounded.editNewSnippet ?? "")).toBeLessThanOrEqual(
      2000
    );
    expect(bounded).toMatchObject({
      editDeltaTruncated: true,
      hasTestTargets: true,
      hasProductionTargets: true,
      mutationAmbiguous: true,
    });
    const truncatedTestFile = normalizeTddToolMetadata("edit", {
      path: "tests/large.test.ts",
      oldText: "x".repeat(3000),
      newText: "y".repeat(3000),
    });
    expect(truncatedTestFile).toMatchObject({
      editDeltaTruncated: true,
      hasTestTargets: true,
      hasProductionTargets: true,
      mutationAmbiguous: true,
    });
  });

  it("conservatively rejects Cargo inline-test edits after RED", () => {
    const calls = trajectory();
    calls[1] = {
      ...calls[1],
      args: {
        path: "src/lib.rs",
        oldText: "#[cfg(test)]\nmod tests { assert_eq!(one(), 1); }",
        newText: "#[cfg(test)]\nmod tests { assert_eq!(one(), 2); }",
      },
    };
    expect(validateTddEvidence(result(), calls)).toContain(
      "regression-test mutations after RED"
    );

    const cfgTestThenProduction = trajectory();
    cfgTestThenProduction[1] = {
      ...cfgTestThenProduction[1],
      args: {
        path: "src/lib.rs",
        oldText:
          "#[cfg(test)]\nmod tests { assert_eq!(one(), 1); }\nfn one() -> i32 { 0 }",
        newText:
          "#[cfg(test)]\nmod tests { assert_eq!(one(), 2); }\nfn one() -> i32 { 1 }",
      },
    };
    expect(validateTddEvidence(result(), cfgTestThenProduction)).toContain(
      "regression-test mutations after RED"
    );

    const normalizedMixedMetadata = normalizeTddToolMetadata("edit", {
      path: "src/lib.rs",
      oldText:
        "#[cfg(test)]\nmod tests { assert_eq!(one(), 1); }\nfn one() -> i32 { 0 }",
      newText:
        "#[cfg(test)]\nmod tests { assert_eq!(one(), 2); }\nfn one() -> i32 { 1 }",
    });
    expect(normalizedMixedMetadata).toMatchObject({
      args: {},
      hasTestTargets: true,
      hasProductionTargets: true,
      mutationAmbiguous: true,
    });
    const normalizedMixedRust = trajectory();
    normalizedMixedRust[1] = {
      ...normalizedMixedRust[1],
      name: "edit",
      ...normalizedMixedMetadata,
    };
    expect(validateTddEvidence(result(), normalizedMixedRust)).toContain(
      "regression-test mutations after RED"
    );

    const productionRust = trajectory();
    productionRust[1] = {
      ...productionRust[1],
      args: {
        path: "src/lib.rs",
        oldText: "fn one() -> i32 { 0 }",
        newText: "fn one() -> i32 { 1 }",
      },
    };
    expect(validateTddEvidence(result(), productionRust)).toBeUndefined();

    const broadMixedRust = trajectory();
    broadMixedRust[1] = {
      ...broadMixedRust[1],
      args: {
        path: "src/lib.rs",
        oldText:
          "fn one() -> i32 { 0 }\n#[cfg(test)]\nmod tests { assert_eq!(one(), 1); }",
        newText:
          "fn one() -> i32 { 1 }\n#[cfg(test)]\nmod tests { assert_eq!(one(), 2); }",
      },
    };
    expect(validateTddEvidence(result(), broadMixedRust)).toContain(
      "regression-test mutations after RED"
    );
  });

  it("rejects parallel RED/mutation and mutation/GREEN batches", () => {
    const mutationDuringRed = trajectory();
    mutationDuringRed[1] = {
      ...mutationDuringRed[1],
      startOrder: 2,
      endOrder: 5,
    };
    expect(validateTddEvidence(result(), mutationDuringRed)).toContain(
      "production implementation mutation"
    );

    const greenDuringMutation = trajectory();
    greenDuringMutation[1] = {
      ...greenDuringMutation[1],
      startOrder: 4,
      endOrder: 8,
    };
    greenDuringMutation[2] = {
      ...greenDuringMutation[2],
      startOrder: 7,
      endOrder: 9,
    };
    expect(validateTddEvidence(result(), greenDuringMutation)).toContain(
      "production implementation mutation"
    );
  });

  it("keeps package scripts non-authoritative even with claimed proof metadata", () => {
    for (const command of [
      "bun run test:unit",
      "npm test",
      "npm run test:unit",
      "pnpm test",
      "pnpm run test:unit",
      "yarn test",
      "yarn run test:unit",
      "npm run TEST:unit",
    ]) {
      const calls = trajectory();
      for (const call of [calls[0], calls[2]]) {
        call!.args = { command };
        call!.runnerWorkspaceProof = true;
      }
      const evidence = result();
      evidence.validation[0] = `RED: ${command} failed with 1 failed`;
      evidence.validation[1] = `GREEN: ${command} passed with 5 passed`;
      expect(
        validateTddEvidence(evidence, calls, [], "Fix formatName empty input")
      ).toContain("actual failing/passing test output");
    }
  });

  it("treats Bun default text coverage as non-writing but rejects artifact output", () => {
    for (const command of [
      "bun test --coverage",
      "bun test --coverage --coverage-reporter=text",
    ]) {
      const calls = trajectory();
      calls.splice(3, 0, {
        name: "bash",
        args: { command },
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
        resultText: "unit > formatName regression\n5 passed\n100% lines",
      });
      calls[4] = {
        ...calls[4]!,
        assistantTurn: 4,
        startOrder: 12,
        endOrder: 13,
      };
      const evidence = result();
      evidence.validation[2] = "COVERAGE: 100% lines";
      expect(validateTddEvidence(evidence, calls)).toBeUndefined();
    }
    for (const command of [
      "bun test --coverage --coverage-reporter=lcov",
      "bun test --coverage --coverage-reporter html",
      "bun test --coverage --coverage-reporter=json",
      "bun test --coverage --coverage-dir=coverage",
    ]) {
      const calls = trajectory();
      calls.splice(3, 0, {
        name: "bash",
        args: { command },
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 10,
        isError: false,
      });
      calls[4] = {
        ...calls[4]!,
        assistantTurn: 4,
        startOrder: 12,
        endOrder: 13,
      };
      expect(validateTddEvidence(result(), calls)).toContain("TDD ordering");
    }
  });

  it("correlates ordinary RED failures with focused or trusted regression intent", () => {
    const focused = trajectory(
      "tests/formatName.test.ts > formatName rejects empty input\nexpected value\n1 failed",
      "5 passed"
    );
    expect(validateTddEvidence(result(), focused)).toBeUndefined();

    const broad = trajectory();
    broad[0] = {
      ...broad[0]!,
      args: { command: "bun test" },
      resultText: "unrelatedHelper assertion failed\n1 failed",
    };
    broad[2] = { ...broad[2]!, args: { command: "bun test" } };
    const broadEvidence = result();
    broadEvidence.validation[0] = "RED: bun test failed with 1 failed";
    broadEvidence.validation[1] = "GREEN: bun test passed with 5 passed";
    expect(validateTddEvidence(broadEvidence, broad)).toContain(
      "actual failing/passing test output"
    );

    broad[0] = {
      ...broad[0]!,
      resultText: "formatName rejects empty input\n1 failed",
    };
    expect(
      validateTddEvidence(
        broadEvidence,
        broad,
        [],
        "Fix formatName empty input"
      )
    ).toBeUndefined();

    broad[0] = {
      ...broad[0]!,
      resultText: "login assertion failed\n1 failed",
    };
    expect(
      validateTddEvidence(broadEvidence, broad, [], "Fix login")
    ).toContain("actual failing/passing test output");

    const substring = trajectory(
      "foobar assertion failed\n1 failed",
      "5 passed"
    );
    substring[0] = {
      ...substring[0]!,
      args: { command: "bun test tests/foo.test.ts" },
    };
    substring[2] = {
      ...substring[2]!,
      args: { command: "bun test tests/foo.test.ts" },
    };
    const substringEvidence = result();
    substringEvidence.validation[0] =
      "RED: bun test tests/foo.test.ts failed with 1 failed";
    substringEvidence.validation[1] =
      "GREEN: bun test tests/foo.test.ts passed with 5 passed";
    expect(validateTddEvidence(substringEvidence, substring)).toContain(
      "actual failing/passing test output"
    );
  });

  it("retains a discriminating test title after a long bounded preamble", () => {
    const metadata = normalizeTddToolMetadata("write", {
      path: "tests/formatName.test.ts",
      content: `${"// fixture preamble\n".repeat(500)}test("formatName rejects empty input", () => formatName(""));`,
    });
    expect(metadata.regressionTitles).toContain(
      "formatname rejects empty input"
    );

    const calls = trajectory();
    calls.unshift({
      name: "write",
      ...metadata,
      assistantTurn: 0,
      startOrder: -2,
      endOrder: -1,
      isError: false,
      mutationProven: true,
    });
    expect(
      validateTddEvidence(result(), calls, [], "Fix formatName empty input")
    ).toBeUndefined();

    expect(
      validateTddEvidence(
        result(),
        calls,
        [],
        "Correct the customer billing cycle calculation"
      )
    ).toContain("actual failing/passing test output");

    calls[1] = {
      ...calls[1]!,
      resultText: "unrelated empty input\n1 failed, 4 passed",
    };
    expect(validateTddEvidence(result(), calls)).toContain(
      "actual failing/passing test output"
    );
  });

  it("requires exact normalized RED title semantics", () => {
    for (const [title, observed, accepted] of [
      [
        "formatName rejects empty input",
        "FORMATNAME: rejects empty input!",
        true,
      ],
      [
        "formatName rejects empty input",
        "formatName accepts empty input",
        false,
      ],
      [
        "formatName fails invalid input",
        "formatName passes invalid input",
        false,
      ],
    ] as const) {
      const metadata = normalizeTddToolMetadata("write", {
        path: "tests/formatName.test.ts",
        content: `test("${title}", () => formatName(""));`,
      });
      const calls = trajectory(`${observed}\n1 failed`, "5 passed");
      calls.unshift({
        name: "write",
        ...metadata,
        assistantTurn: 0,
        startOrder: -2,
        endOrder: -1,
        isError: false,
        mutationProven: true,
      });
      const error = validateTddEvidence(result(), calls, [], `Fix ${title}`);
      if (accepted) {
        expect(error).toBeUndefined();
      } else {
        expect(error).toContain("actual failing/passing test output");
      }
    }
  });

  it("requires the retained regression title, not only its production symbol", () => {
    const testMetadata = normalizeTddToolMetadata("write", {
      path: "tests/formatName.test.ts",
      content:
        'describe("formatting", () => test("rejects empty input", () => formatName("")));',
    });
    const calls = trajectory(
      "formatting > rejects empty input\n1 failed, 4 passed",
      "formatting > rejects empty input\n5 passed"
    );
    calls.unshift({
      name: "write",
      ...testMetadata,
      assistantTurn: 0,
      startOrder: -2,
      endOrder: -1,
      isError: false,
      mutationProven: true,
    });
    expect(
      validateTddEvidence(result(), calls, [], "Fix rejects empty input")
    ).toBeUndefined();

    calls[1] = {
      ...calls[1]!,
      resultText: "formatName > accepts empty input\n1 failed, 4 passed",
    };
    expect(validateTddEvidence(result(), calls)).toContain(
      "actual failing/passing test output"
    );
  });

  it("matches retained RED titles at normalized token boundaries", () => {
    const metadata = normalizeTddToolMetadata("write", {
      path: "tests/auth.test.ts",
      content: 'test("auth", () => authenticate());',
    });
    const calls = trajectory("auth assertion failed\n1 failed", "5 passed");
    calls.unshift({
      name: "write",
      ...metadata,
      assistantTurn: 0,
      startOrder: -2,
      endOrder: -1,
      isError: false,
      mutationProven: true,
    });

    expect(
      validateTddEvidence(result(), calls, [], "Fix auth")
    ).toBeUndefined();

    calls[1] = {
      ...calls[1]!,
      resultText: "authoritative assertion failed\n1 failed",
    };
    expect(validateTddEvidence(result(), calls, [], "Fix auth")).toContain(
      "actual failing/passing test output"
    );

    const unicodeMetadata = normalizeTddToolMetadata("write", {
      path: "tests/auth.test.ts",
      content: 'test("café auth", () => authenticate());',
    });
    const unicodeCalls = trajectory("café auth\n1 failed", "5 passed");
    unicodeCalls.unshift({
      name: "write",
      ...unicodeMetadata,
      assistantTurn: 0,
      startOrder: -2,
      endOrder: -1,
      isError: false,
      mutationProven: true,
    });
    expect(
      validateTddEvidence(result(), unicodeCalls, [], "Fix café auth")
    ).toBeUndefined();
  });

  it("rejects package-manager shorthands with forwarded args but accepts direct runners", () => {
    for (const command of [
      "npm test -- foo.test.ts",
      "pnpm test --filter unit",
      "yarn test foo.test.ts",
    ]) {
      const calls = trajectory();
      for (const call of [calls[0], calls[2]]) {
        call!.args = { command };
      }
      const evidence = result();
      evidence.validation[0] = `RED: ${command} failed with 1 failed`;
      evidence.validation[1] = `GREEN: ${command} passed with 5 passed`;
      expect(
        validateTddEvidence(evidence, calls, [], "Fix formatName empty input")
      ).toContain("actual failing/passing test output");
    }

    const direct = trajectory();
    for (const call of [direct[0], direct[2]]) {
      call!.args = { command: "vitest tests/formatName.test.ts" };
    }
    const evidence = result();
    evidence.validation[0] =
      "RED: vitest tests/formatName.test.ts failed with 1 failed";
    evidence.validation[1] =
      "GREEN: vitest tests/formatName.test.ts passed with 5 passed";
    expect(validateTddEvidence(evidence, direct)).toBeUndefined();
  });

  it("rejects relevant workspace mutations performed inside direct runners", () => {
    for (const [index, path] of [
      "src/unit.ts",
      "tests/formatName.test.ts",
      "package.json",
    ].entries()) {
      const calls = trajectory();
      calls[index === 0 ? 0 : 2] = {
        ...calls[index === 0 ? 0 : 2]!,
        runnerWorkspaceProof: true,
        runnerWorkspaceDelta: [{ path, status: "changed" }],
      };
      expect(validateTddEvidence(result(), calls)).toContain(
        "changed relevant workspace files"
      );
    }
  });

  it("does not let a focused path authorize an unrelated same-file RED", () => {
    const calls = trajectory(
      "tests/auth.test.ts > hashes passwords securely\n1 failed",
      "tests/auth.test.ts > hashes passwords securely\n1 passed"
    );
    for (const call of [calls[0], calls[2]]) {
      call!.args = { command: "bun test tests/auth.test.ts" };
    }
    const evidence = result();
    evidence.validation[0] =
      "RED: bun test tests/auth.test.ts failed with 1 failed";
    evidence.validation[1] =
      "GREEN: bun test tests/auth.test.ts passed with 1 passed";
    expect(
      validateTddEvidence(
        evidence,
        calls,
        [],
        "Fix login timeout after 30 seconds"
      )
    ).toContain("actual failing/passing test output");

    calls[0] = {
      ...calls[0]!,
      resultText:
        "tests/auth.test.ts > login times out after 30 seconds\n1 failed",
    };
    expect(
      validateTddEvidence(
        evidence,
        calls,
        [],
        "Fix login timeout after 30 seconds"
      )
    ).toBeUndefined();
  });

  it("requires positive semantic coverage evidence for done results", () => {
    for (const coverage of [
      "`formatName()` behavior and `empty-input` failure path covered",
      "bun test tests/formatName.test.ts passed with 5 tests passed",
      "coverage tooling unavailable because no script exists",
      "coverage tooling unavailable because no script exists; focused manual inspection verified `formatName()` error path",
    ]) {
      const evidence = result();
      evidence.validation[2] = `COVERAGE: ${coverage}`;
      expect(validateTddEvidence(evidence, trajectory())).toBeUndefined();
    }

    for (const coverage of [
      "Statements: 92% and branches: 18",
      "12 of 14 branches covered",
      "reported 7 functions",
      "coverage threshold 85% met",
      "coverage threshold 85 passed",
    ]) {
      const evidence = result();
      evidence.validation[2] = `COVERAGE: ${coverage}`;
      expect(
        validateTddEvidence(
          evidence,
          trajectory("1 failed, 4 passed", `5 passed, 0 failed\n${coverage}`)
        )
      ).toBeUndefined();
    }

    for (const coverage of [
      "",
      "banana",
      "banana covered",
      "gibberish complete",
      "none",
      "0% statements",
      "101% statements",
      "branches: 0",
      "150/14 branches covered",
      "18 branches",
      "coverage threshold 0% met",
      "coverage threshold 999 met",
      "92% statements",
      "coverage threshold 85% below target",
      "coverage threshold 85% unmet",
      "bun test tests/formatName.test.ts failed with 1 test failed",
      "bun test tests/formatName.test.ts exited with code 1 after behavior covered",
      "bun test tests/other.test.ts passed with 5 tests passed",
      "failure path covered",
      "coverage unavailable because no script exists",
      "coverage tooling unavailable because unavailable",
      "`madeUpBehavior()` failure path covered",
    ]) {
      const evidence = result();
      evidence.validation[2] = `COVERAGE: ${coverage}`;
      expect(validateTddEvidence(evidence, trajectory())).toContain("COVERAGE");
    }
  });

  describe("blocked-session regression replays", () => {
    it("treats authentic but imperfect TDD as needing verification", () => {
      const evidence = {
        status: "done",
        validation: [
          "RED: bun test extensions/auto-rename/index.test.ts failed because ./index was missing",
          "GREEN: bun test extensions/auto-rename/index.test.ts passed with 36 tests",
          "COVERAGE: Focused suite covers lifecycle and failure scenarios",
        ],
        blockers: [],
      };
      const calls: TddToolCall[] = [
        {
          name: "write",
          args: {},
          mutationTargets: ["extensions/auto-rename/index.test.ts"],
          hasTestTargets: true,
          hasProductionTargets: false,
          mutationAmbiguous: false,
          regressionIntent: ["extensions/auto-rename/index.test.ts"],
          regressionTitles: ["captures first raw interactive input"],
          mutationProven: true,
          assistantTurn: 0,
          startOrder: 1,
          endOrder: 2,
          isError: false,
        },
        {
          name: "bash",
          args: { command: "find node_modules -name '*.md' | head -20" },
          assistantTurn: 1,
          startOrder: 3,
          endOrder: 4,
          isError: false,
        },
        {
          name: "bash",
          args: { command: "bun test extensions/auto-rename/index.test.ts" },
          assistantTurn: 2,
          startOrder: 5,
          endOrder: 6,
          isError: true,
          runnerWorkspaceProof: true,
          resultText: "error: Cannot find module './index'\n0 pass\n1 fail",
        },
        {
          name: "write",
          args: {},
          mutationTargets: ["extensions/auto-rename/index.ts"],
          hasTestTargets: false,
          hasProductionTargets: true,
          mutationAmbiguous: false,
          mutationProven: true,
          assistantTurn: 3,
          startOrder: 7,
          endOrder: 8,
          isError: false,
        },
        {
          name: "bash",
          args: { command: "bun test extensions/auto-rename/index.test.ts" },
          assistantTurn: 4,
          startOrder: 9,
          endOrder: 10,
          isError: false,
          runnerWorkspaceProof: true,
          resultText:
            "auto-rename > captures first raw interactive input\n36 pass\n0 fail",
        },
        {
          name: "bash",
          args: { command: "git status --short" },
          assistantTurn: 5,
          startOrder: 11,
          endOrder: 12,
          isError: false,
        },
        {
          name: "structured_output",
          args: {},
          assistantTurn: 6,
          startOrder: 13,
          endOrder: 14,
          isError: false,
        },
      ];

      expect(
        assessTddEvidence(
          evidence,
          calls,
          [],
          "Implement safe auto-rename lifecycle behavior",
          "bun test extensions/auto-rename/index.test.ts"
        )
      ).toMatchObject({ kind: "needs_verification" });
      expect(
        assessTddEvidence(
          evidence,
          calls,
          ["pending starts at terminal status: 1"],
          "Implement safe auto-rename lifecycle behavior",
          "bun test extensions/auto-rename/index.test.ts"
        )
      ).toMatchObject({ kind: "failed", code: "capture_integrity" });
      expect(
        assessTddEvidence(
          evidence,
          calls.map((call) =>
            call.startOrder === 9
              ? { ...call, runnerWorkspaceProof: false }
              : call
          ),
          [],
          "Implement safe auto-rename lifecycle behavior",
          "bun test extensions/auto-rename/index.test.ts"
        )
      ).toMatchObject({ kind: "failed", code: "unsafe_runner" });
      expect(
        assessTddEvidence(
          {
            ...evidence,
            validation: [
              evidence.validation[0]!,
              evidence.validation[1]!,
              "COVERAGE: 99% statements covered",
            ],
          },
          calls,
          [],
          "Implement safe auto-rename lifecycle behavior",
          "bun test extensions/auto-rename/index.test.ts"
        )
      ).toMatchObject({ kind: "failed", code: "fabricated_coverage" });
      expect(
        assessTddEvidence(
          evidence,
          calls.filter((call) => call.startOrder !== 9),
          [],
          "Implement safe auto-rename lifecycle behavior",
          "bun test extensions/auto-rename/index.test.ts"
        )
      ).toMatchObject({ kind: "failed", code: "missing_green" });

      const unresolvedFailure: TddToolCall[] = [
        ...calls.filter((call) => call.startOrder < 11),
        {
          name: "bash",
          args: { command: "bun test extensions/auto-rename" },
          assistantTurn: 5,
          startOrder: 11,
          endOrder: 12,
          isError: true,
          runnerWorkspaceProof: true,
          resultText: "auto-rename integration\n1 fail",
        },
        { ...calls[4]!, assistantTurn: 6, startOrder: 13, endOrder: 14 },
        { ...calls[6]!, assistantTurn: 7, startOrder: 15, endOrder: 16 },
      ];
      expect(
        assessTddEvidence(
          evidence,
          unresolvedFailure,
          [],
          "Implement safe auto-rename lifecycle behavior",
          "bun test extensions/auto-rename/index.test.ts"
        )
      ).toMatchObject({ kind: "failed", code: "unresolved_tests" });

      const writeCapableRunner: TddToolCall[] = [
        ...calls.filter((call) => call.startOrder < 11),
        {
          name: "bash",
          args: {
            command:
              "bun test extensions/auto-rename/index.test.ts --update-snapshots",
          },
          assistantTurn: 5,
          startOrder: 11,
          endOrder: 12,
          isError: false,
          runnerWorkspaceProof: true,
          runnerWorkspaceDelta: [
            {
              path: "extensions/auto-rename/index.test.ts",
              status: "changed",
            },
          ],
          resultText: "36 pass\n0 fail",
        },
        { ...calls[6]!, assistantTurn: 6 },
      ];
      expect(
        assessTddEvidence(
          evidence,
          writeCapableRunner,
          [],
          "Implement safe auto-rename lifecycle behavior",
          "bun test extensions/auto-rename/index.test.ts"
        )
      ).toMatchObject({ kind: "failed", code: "unsafe_runner" });
      expect(
        assessTddEvidence(
          evidence,
          calls.map((call) =>
            call.startOrder === 11
              ? { ...call, args: { command: "rm -rf build" } }
              : call
          ),
          [],
          "Implement safe auto-rename lifecycle behavior",
          "bun test extensions/auto-rename/index.test.ts"
        )
      ).toMatchObject({ kind: "failed", code: "unsafe_shell" });

      for (const coverage of [
        "COVERAGE: lifecycle should pass",
        "COVERAGE: 99 % statements covered",
      ]) {
        const staleMeasurementCalls = calls.map((call) =>
          call.startOrder === 3
            ? {
                name: "bash",
                args: {
                  command: "bun test extensions/auto-rename/index.test.ts",
                },
                assistantTurn: 1,
                startOrder: 3,
                endOrder: 4,
                isError: false,
                runnerWorkspaceProof: true,
                resultText: "99 % statements\n36 pass\n0 fail",
              }
            : call
        );
        expect(
          assessTddEvidence(
            {
              ...evidence,
              validation: [...evidence.validation.slice(0, 2), coverage],
            },
            staleMeasurementCalls,
            [],
            "Implement safe auto-rename lifecycle behavior",
            "bun test extensions/auto-rename/index.test.ts"
          )
        ).toMatchObject({
          kind: "failed",
          code: coverage.includes("should")
            ? "fabricated_claim"
            : "fabricated_coverage",
        });
      }

      expect(
        assessTddEvidence(
          {
            ...evidence,
            validation: [
              "RED: not run because behavioral RED was unavailable",
              ...evidence.validation.slice(1),
            ],
          },
          calls,
          [],
          "Implement safe auto-rename lifecycle behavior",
          "bun test extensions/auto-rename/index.test.ts"
        )
      ).toMatchObject({ kind: "failed", code: "fabricated_claim" });

      expect(
        assessTddEvidence(
          {
            ...evidence,
            validation: [
              "RED: bun test extensions/auto-rename/index.test.ts failed with unrelated widget crash",
              ...evidence.validation.slice(1),
            ],
          },
          calls.map((call) => {
            if (call.startOrder === 1) {
              return {
                ...call,
                regressionIntent: ["unrelated widget crash"],
                regressionTitles: [
                  "auto rename lifecycle behavior",
                  "unrelated widget crash",
                ],
              };
            }
            return call.startOrder === 5
              ? { ...call, resultText: "unrelated widget crash\n1 fail" }
              : call;
          }),
          [],
          "Implement safe auto-rename lifecycle behavior",
          "bun test extensions/auto-rename/index.test.ts"
        )
      ).toMatchObject({ kind: "failed", code: "fabricated_claim" });
    });

    it("correlates a retained relative missing-module RED", () => {
      const calls = trajectory(
        "Cannot find module './formatName'\n(fail) formatName regression\n1 fail"
      );
      calls.unshift({
        name: "write",
        ...normalizeTddToolMetadata("write", {
          path: "tests/formatName.test.ts",
          content:
            'import { formatName } from "./formatName"; test("formatName regression", () => formatName());',
        }),
        assistantTurn: 0,
        startOrder: -2,
        endOrder: -1,
        isError: false,
        mutationProven: true,
      });

      expect(
        validateTddEvidence(result(), calls, [], "Implement formatName")
      ).toBeUndefined();
    });

    it("reports safe event orders for a test mutation after RED", () => {
      const calls = trajectory();
      calls.splice(2, 0, {
        name: "edit",
        ...normalizeTddToolMetadata("edit", {
          path: "tests/formatName.test.ts",
          oldText: 'test("old", () => old());',
          newText: 'test("new", () => changed());',
        }),
        assistantTurn: 2,
        startOrder: 6,
        endOrder: 6.5,
        isError: false,
        mutationProven: true,
      });

      expect(validateTddEvidence(result(), calls)).toContain(
        "RED ended at order 2; test mutation started at order 6"
      );
    });

    it("reports a production mutation after final GREEN", () => {
      const calls = trajectory();
      calls.splice(3, 0, {
        name: "edit",
        args: {
          path: "src/unit.ts",
          oldText: "return fixed",
          newText: "return changed again",
        },
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 9.5,
        isError: false,
      });
      calls[4] = {
        ...calls[4]!,
        assistantTurn: 4,
        startOrder: 12,
        endOrder: 13,
      };

      expect(validateTddEvidence(result(), calls)).toContain(
        "final GREEN ended at order 8; later mutation started at order 9"
      );
    });

    it("explains unmatched numeric Bun coverage claims without raw output", () => {
      const calls = trajectory();
      calls.splice(3, 0, {
        name: "bash",
        args: { command: "bun test --coverage tests/formatName.test.ts" },
        assistantTurn: 3,
        startOrder: 9,
        endOrder: 9.5,
        isError: false,
        resultText: [
          "formatName regression",
          "5 passed, 0 failed",
          "File | % Funcs | % Lines",
          "src/unit.ts | 100.00 | 99.40",
        ].join("\n"),
        runnerWorkspaceProof: true,
      });
      calls[4] = {
        ...calls[4]!,
        assistantTurn: 4,
        startOrder: 12,
        endOrder: 13,
      };
      const evidence = result();
      evidence.validation[2] =
        "COVERAGE: `bun test --coverage tests/formatName.test.ts` passed; unit.ts reached 100.00% functions and 99.40% lines";

      const error = validateTddEvidence(evidence, calls);
      expect(error).toContain(
        "numeric coverage claims could not be safely correlated with labeled retained measurements"
      );
      expect(error).not.toContain("src/unit.ts");
    });
  });

  it("enforces status-aware partial-result evidence", () => {
    const partial = {
      ...result(),
      status: "needs_followup",
      blockers: ["A second edge case remains."],
    };
    expect(validateTddEvidence(partial, trajectory())).toBeUndefined();
    expect(validateTddEvidence(partial, [])).toContain("sole final");
    expect(
      validateTddEvidence({ ...partial, blockers: [] }, trajectory())
    ).toContain("non-empty blocker");

    const unavailable = {
      ...partial,
      validation: [
        "RED: not run because fixture is unavailable",
        "GREEN: not run because fixture is unavailable",
        "COVERAGE: unavailable because tooling cannot start",
      ],
    };
    expect(validateTddEvidence(unavailable, terminalOnly())).toBeUndefined();
    expect(
      validateTddEvidence(
        { ...unavailable, status: "blocked", blockers: ["Fixture missing."] },
        terminalOnly()
      )
    ).toBeUndefined();
    for (const validation of [
      [
        "RED: not run because fixture is unavailable",
        "GREEN: not run because fixture is unavailable",
        "COVERAGE: changed behavior covered",
      ],
      ["RED: not run", "GREEN: unavailable", "COVERAGE: not-run"],
      [
        "RED: not run unavailable",
        "GREEN: unavailable; not executed",
        "COVERAGE: not-run because unavailable",
      ],
      [
        "RED: unable to run and not executed",
        "GREEN: could not execute, unavailable",
        "COVERAGE: wasn't run; was not run",
      ],
      [
        "RED: not run because fixture is unavailable",
        "GREEN: command passed",
        "COVERAGE: unavailable because tests did not run",
      ],
    ]) {
      expect(
        validateTddEvidence({ ...unavailable, validation }, terminalOnly())
      ).toContain("no-work TDD result");
    }
    expect(
      validateTddEvidence(unavailable, [
        {
          name: "edit",
          args: { path: "src/unit.ts" },
          assistantTurn: 0,
          startOrder: 1,
          endOrder: 2,
          isError: false,
        },
        {
          name: "structured_output",
          args: {},
          assistantTurn: 1,
          startOrder: 3,
          endOrder: 4,
          isError: false,
        },
      ])
    ).toContain("same observed supported");
  });

  it("accepts observed RED-only terminal partial results and rejects false partial claims", () => {
    for (const status of ["blocked", "needs_followup"] as const) {
      const partial = {
        status,
        validation: [
          "RED: bun test tests/formatName.test.ts failed with 1 failed, 4 passed",
          "GREEN: not run because implementation is blocked",
          "COVERAGE: unavailable because GREEN could not run",
        ],
        blockers: ["Implementation prerequisite unavailable."],
      };
      const calls: TddToolCall[] = [
        {
          name: "write",
          args: { path: "tests/formatName.test.ts" },
          assistantTurn: 0,
          startOrder: 1,
          endOrder: 2,
          isError: false,
          mutationProven: true,
        },
        {
          name: "bash",
          args: { command: "bun test tests/formatName.test.ts" },
          assistantTurn: 1,
          startOrder: 3,
          endOrder: 4,
          isError: true,
          resultText:
            "unit > formatName rejects empty input\n1 failed, 4 passed",
        },
        {
          name: "structured_output",
          args: {},
          assistantTurn: 2,
          startOrder: 5,
          endOrder: 6,
          isError: false,
        },
      ];
      expect(
        validateTddEvidence(partial, calls, [], "Fix formatName empty input")
      ).toBeUndefined();
      expect(validateTddEvidence(partial, calls.slice(1))).toBeUndefined();
      expect(validateTddEvidence(partial, calls.slice(0, 1))).toContain(
        "sole final"
      );
      expect(
        validateTddEvidence({ ...partial, blockers: [] }, calls)
      ).toContain("non-empty blocker");
      expect(
        validateTddEvidence(
          {
            ...partial,
            validation: [
              partial.validation[0],
              partial.validation[1],
              "COVERAGE: unavailable because changed behavior was covered",
            ],
          },
          calls
        )
      ).toContain("RED: and GREEN:");

      const mutated = calls.toSpliced(2, 0, {
        name: "edit",
        args: { path: "src/unit.ts" },
        assistantTurn: 2,
        startOrder: 4.2,
        endOrder: 4.4,
        isError: false,
      });
      mutated[3] = {
        ...mutated[3]!,
        assistantTurn: 3,
        startOrder: 5,
        endOrder: 6,
      };
      expect(
        validateTddEvidence(partial, mutated, [], "Fix formatName empty input")
      ).toContain("cannot include an implementation mutation");
    }
  });

  it("requires authoritative production delta proof for discrete mutations", () => {
    const noOpEdit = trajectory();
    noOpEdit[1] = {
      ...noOpEdit[1]!,
      ...normalizeTddToolMetadata("edit", {
        path: "src/unit.ts",
        oldText: "same",
        newText: "same",
      }),
    };
    expect(validateTddEvidence(result(), noOpEdit)).toContain(
      "production implementation mutation"
    );

    const unprovenWrite = trajectory();
    unprovenWrite[1] = {
      ...unprovenWrite[1]!,
      name: "write",
      ...normalizeTddToolMetadata("write", {
        path: "src/unit.ts",
        content: "export const fixed = true;",
      }),
    };
    expect(validateTddEvidence(result(), unprovenWrite)).toContain(
      "production implementation mutation"
    );

    unprovenWrite[1] = { ...unprovenWrite[1]!, mutationProven: true };
    expect(validateTddEvidence(result(), unprovenWrite)).toBeUndefined();

    const disprovenDifferingEdit = trajectory();
    disprovenDifferingEdit[1] = {
      ...disprovenDifferingEdit[1]!,
      ...normalizeTddToolMetadata("edit", {
        path: "src/unit.ts",
        oldText: "return old",
        newText: "return fixed",
      }),
      mutationProven: false,
    };
    expect(validateTddEvidence(result(), disprovenDifferingEdit)).toContain(
      "production implementation mutation"
    );

    expect(mutationResultProvesDelta({ details: { changed: true } })).toBe(
      true
    );
    expect(mutationResultProvesDelta({ created: true })).toBe(true);
    expect(mutationResultProvesDelta({ content: "success" })).toBe(false);
  });

  it("requires every post-mutation failed test scope to be rerun successfully", () => {
    const unresolved = trajectory();
    unresolved.splice(3, 0, {
      name: "bash",
      args: { command: "bun   test tests/broad.test.ts" },
      assistantTurn: 3,
      startOrder: 8.2,
      endOrder: 8.4,
      isError: true,
      resultText: "broad regression\n1 failed",
    });
    unresolved[4] = { ...unresolved[4]!, assistantTurn: 4 };
    expect(validateTddEvidence(result(), unresolved)).toContain(
      "every supported test failure"
    );

    const resolved = unresolved.toSpliced(4, 0, {
      name: "bash",
      args: { command: "BUN test 'tests/broad.test.ts'" },
      assistantTurn: 3,
      startOrder: 8.5,
      endOrder: 8.7,
      isError: false,
      resultText: "broad regression\n1 passed, 0 failed",
    });
    resolved[5] = { ...resolved[5]!, assistantTurn: 5 };
    expect(validateTddEvidence(result(), resolved)).toBeUndefined();
  });

  it("rejects broader test commands before the matched focused GREEN", () => {
    const calls = trajectory();
    calls.splice(2, 0, {
      name: "bash",
      args: { command: "bun test" },
      assistantTurn: 2,
      startOrder: 7,
      endOrder: 8,
      isError: false,
      resultText: "formatName regression\n5 passed, 0 failed",
    });
    calls[3] = {
      ...calls[3]!,
      assistantTurn: 3,
      startOrder: 10,
      endOrder: 11,
    };
    calls[4] = {
      ...calls[4]!,
      assistantTurn: 4,
      startOrder: 13,
      endOrder: 14,
    };

    expect(validateTddEvidence(result(), calls)).toContain(
      "broader test commands before the matched GREEN"
    );

    calls[2] = { ...calls[2]!, startOrder: 9.5, endOrder: 10.5 };
    expect(validateTddEvidence(result(), calls)).toContain(
      "broader test commands before the matched GREEN"
    );
  });

  it("uses the final successful runner and rejects stale later test activity", () => {
    const calls = trajectory();
    calls.splice(3, 0, {
      name: "bash",
      args: {
        command: "bun test tests/formatName.test.ts --preload ./test-hook.ts",
      },
      assistantTurn: 3,
      startOrder: 9,
      endOrder: 10,
      isError: false,
      resultText: "formatName regression\n5 passed, 0 failed",
    });
    calls.splice(4, 0, {
      ...calls[2]!,
      assistantTurn: 4,
      startOrder: 11,
      endOrder: 12,
    });
    calls[5] = {
      ...calls[5]!,
      assistantTurn: 5,
      startOrder: 13,
      endOrder: 14,
    };
    expect(validateTddEvidence(result(), calls)).toContain(
      "mutation-capable shell calls"
    );

    const cleanupAfterGreen = trajectory();
    cleanupAfterGreen.splice(3, 0, {
      name: "bash",
      args: { command: "npm test -- --runInBand" },
      assistantTurn: 3,
      startOrder: 9,
      endOrder: 10,
      isError: false,
      resultText: "5 passed",
    });
    cleanupAfterGreen[4] = {
      ...cleanupAfterGreen[4]!,
      assistantTurn: 4,
      startOrder: 11,
      endOrder: 12,
    };
    expect(validateTddEvidence(result(), cleanupAfterGreen)).toContain(
      "final GREEN"
    );
  });

  it("does not correlate RED or coverage from stale pre-implementation output", () => {
    const withMetadata = trajectory();
    withMetadata.unshift({
      name: "write",
      ...normalizeTddToolMetadata("write", {
        path: "tests/formatName.test.ts",
        content: 'test("formatName rejects empty", () => formatName(""));',
      }),
      assistantTurn: 0,
      startOrder: -2,
      endOrder: -1,
      isError: false,
    });
    withMetadata[1] = {
      ...withMetadata[1]!,
      resultText: "tests/unit.test.ts failed\n1 failed",
    };
    expect(validateTddEvidence(result(), withMetadata)).toContain(
      "actual failing/passing test output"
    );

    const staleCoverage = trajectory();
    staleCoverage.unshift({
      name: "bash",
      args: { command: "bun test --coverage" },
      assistantTurn: 0,
      startOrder: -2,
      endOrder: -1,
      isError: false,
      resultText: "formatName regression\n5 passed\nStatements: 92%",
    });
    const evidence = result();
    evidence.validation[2] = "COVERAGE: Statements: 92%";
    expect(validateTddEvidence(evidence, staleCoverage)).toContain("COVERAGE");

    const finalCoverage = trajectory(
      "1 failed, 4 passed",
      "5 passed, 0 failed\nStatements: 92%"
    );
    expect(validateTddEvidence(evidence, finalCoverage)).toBeUndefined();

    const unprovenAfterCoverage = trajectory();
    unprovenAfterCoverage.splice(3, 0, {
      name: "bash",
      args: { command: "bun test --coverage" },
      assistantTurn: 3,
      startOrder: 9,
      endOrder: 10,
      isError: false,
      resultText: "formatName regression\n5 passed\nStatements: 92%",
    });
    unprovenAfterCoverage.splice(4, 0, {
      name: "write",
      ...normalizeTddToolMetadata("write", {
        path: "src/unproven.ts",
        content: "export const value = true;",
      }),
      assistantTurn: 4,
      startOrder: 12,
      endOrder: 13,
      isError: false,
    });
    unprovenAfterCoverage.splice(5, 0, {
      name: "bash",
      args: { command: "bun test tests/formatName.test.ts" },
      assistantTurn: 5,
      startOrder: 15,
      endOrder: 16,
      isError: false,
      resultText: "formatName regression\n5 passed, 0 failed",
    });
    unprovenAfterCoverage[6] = {
      ...unprovenAfterCoverage[6]!,
      assistantTurn: 6,
      startOrder: 18,
      endOrder: 19,
    };
    expect(validateTddEvidence(evidence, unprovenAfterCoverage)).toContain(
      "COVERAGE"
    );
  });

  it("fails closed on trajectory correlation errors", () => {
    expect(
      validateTddEvidence(result(), trajectory(), ["unmatched end"])
    ).toContain("incomplete");
  });

  it("rejects an edit after GREEN and a mixed final structured-output batch", () => {
    const editAfterGreen = trajectory();
    editAfterGreen.splice(3, 0, {
      name: "write",
      args: { path: "src/unit.ts" },
      assistantTurn: 3,
      startOrder: 9,
      endOrder: 10,
      isError: false,
    });
    editAfterGreen[4] = {
      ...editAfterGreen[4],
      startOrder: 12,
      endOrder: 13,
      assistantTurn: 4,
    };
    expect(validateTddEvidence(result(), editAfterGreen)).toContain(
      "final GREEN"
    );

    const mixedFinal = trajectory();
    mixedFinal.push({
      name: "read",
      args: { path: "README.md" },
      assistantTurn: 3,
      startOrder: 12,
      endOrder: 13,
      isError: false,
    });
    expect(validateTddEvidence(result(), mixedFinal)).toContain("sole final");
  });
});
