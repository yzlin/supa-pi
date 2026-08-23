import { expect, test } from "bun:test";

import { Value } from "typebox/value";

test("defines the TDD Task-shape contract", async () => {
  let taskShape: typeof import("./task-shape") | undefined;
  let moduleLoadError: unknown;
  try {
    taskShape = await import("./task-shape");
  } catch (error) {
    moduleLoadError = error;
  }

  expect(moduleLoadError).toBeUndefined();
  expect(taskShape).toBeDefined();
  if (!taskShape) {
    return;
  }

  const valid = Object.freeze({
    behavior: "rejects an invalid checkout request",
    redGreenCommand: "bun test extensions/checkout.test.ts",
    productionComponent: "extensions/checkout.ts",
    mutations: Object.freeze([
      Object.freeze({
        kind: "test" as const,
        path: "extensions/checkout.test.ts",
      }),
      Object.freeze({
        kind: "production" as const,
        path: "extensions/checkout.ts",
      }),
    ]),
  });
  const original = structuredClone(valid);

  expect(Value.Check(taskShape.TaskShapeSchema, valid)).toBe(true);
  const validResult = taskShape.validateTaskShape(valid);
  expect(validResult.ok).toBe(true);
  if (validResult.ok) {
    expect(Object.is(validResult.value, valid)).toBe(true);
  }
  expect(valid).toEqual(original);

  const manifest = valid.mutations;
  for (const observed of [
    [],
    ["extensions/checkout.test.ts"],
    ["extensions/checkout.ts"],
    ["extensions/checkout.test.ts", "extensions/checkout.ts"],
  ]) {
    expect(taskShape.compareMutationManifest(manifest, observed)).toEqual([]);
  }

  for (const observed of [
    ["src/new-target.ts"],
    ["extensions/checkout.ts", "extensions/checkout.test.ts"],
    ["extensions/checkout.test.ts", "extensions/checkout.test.ts"],
    ["extensions/checkout.ts", "extensions/checkout.ts"],
  ]) {
    const warnings = taskShape.compareMutationManifest(manifest, observed);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exceeded the declared mutation manifest");
  }
  const boundedWarnings = taskShape.compareMutationManifest(manifest, [
    "x".repeat(10_000),
  ]);
  expect(boundedWarnings.length).toBeLessThanOrEqual(
    taskShape.TASK_SHAPE_MAX_WARNINGS
  );
  expect(
    boundedWarnings.every(
      (warning) => warning.length <= taskShape.TASK_SHAPE_WARNING_MAX_LENGTH
    )
  ).toBe(true);
  expect(
    Value.Check(taskShape.TaskShapeSchema, { ...valid, unexpected: true })
  ).toBe(false);
  expect(
    Value.Check(taskShape.TaskShapeSchema, {
      ...valid,
      mutations: [
        { ...valid.mutations[0], unexpected: true },
        valid.mutations[1],
      ],
    })
  ).toBe(false);

  for (const key of [
    "behavior",
    "redGreenCommand",
    "productionComponent",
  ] as const) {
    expect(taskShape.validateTaskShape({ ...valid, [key]: " \t\n" })).toEqual({
      ok: false,
      errors: [`${key} must be non-blank`],
    });
    expect(
      taskShape.validateTaskShape({
        ...valid,
        [key]: "x".repeat(taskShape.TASK_SHAPE_STRING_MAX_LENGTH + 1),
      })
    ).toEqual({
      ok: false,
      errors: [
        `${key} must be at most ${taskShape.TASK_SHAPE_STRING_MAX_LENGTH} characters`,
      ],
    });
  }

  for (const count of [0, 1, 7]) {
    expect(
      taskShape.validateTaskShape({
        ...valid,
        mutations: Array.from({ length: count }, (_, index) => ({
          kind: index === 0 ? ("test" as const) : ("production" as const),
          path: `src/file-${index}.ts`,
        })),
      })
    ).toEqual({
      ok: false,
      errors: ["mutations must contain between 2 and 6 entries"],
    });
  }

  const manifestCases = [
    {
      mutations: [
        { kind: "test", path: "a.test.ts" },
        { kind: "test", path: "b.test.ts" },
        { kind: "production", path: "src/a.ts" },
      ],
      error: "mutations must name exactly one distinct test target",
    },
    {
      mutations: [
        { kind: "test", path: "a.test.ts" },
        { kind: "test", path: "a.test.ts" },
      ],
      error: "mutations must include at least one production entry",
    },
    {
      mutations: [
        { kind: "production", path: "src/a.ts" },
        { kind: "test", path: "a.test.ts" },
      ],
      error: "test mutations must precede production mutations",
    },
  ];
  for (const { mutations, error } of manifestCases) {
    expect(taskShape.validateTaskShape({ ...valid, mutations })).toEqual({
      ok: false,
      errors: [error],
    });
  }

  const invalidPaths = [
    "",
    "/tmp/a.ts",
    "C:/work/a.ts",
    "C:a.ts",
    "../a.ts",
    "src/../../a.ts",
    ".",
    "./src/a.ts",
    "src//a.ts",
    "src/./a.ts",
    "src\\a.ts",
    "src/*.ts",
    "src/a?.ts",
    "src/[ab].ts",
    "src/{a,b}.ts",
    " src/a.ts",
    "src/a.ts ",
    "src/a\ta.ts",
    "src/",
    ".pi/state.json",
    ".PI/state.json",
    ".Pi/state.json",
    ".git/config",
    ".GIT/config",
    ".Git/config",
    "node_modules/pkg/index.ts",
    "Node_Modules/pkg/index.ts",
    "NODE_MODULES/pkg/index.ts",
  ];
  for (const path of invalidPaths) {
    expect(
      taskShape.validateTaskShape({
        ...valid,
        mutations: [valid.mutations[0], { kind: "production", path }],
      })
    ).toEqual({
      ok: false,
      errors: [
        "mutations[1].path must be a canonical workspace-relative file path",
      ],
    });
  }

  for (const redGreenCommand of [
    "npm test",
    "bun run test",
    "echo bun test a.test.ts",
    "bun test a.test.ts && rm -rf build",
    "CI=1 bun test a.test.ts",
    "bun test a.test.ts\nbun test b.test.ts",
  ]) {
    expect(taskShape.validateTaskShape({ ...valid, redGreenCommand })).toEqual({
      ok: false,
      errors: [
        "redGreenCommand must be one supported direct managed-TDD runner command",
      ],
    });
  }

  const manyProblems = {
    [`unexpected\n${"x".repeat(200)}`]: true,
    behavior: "",
    redGreenCommand: "npm test",
    productionComponent: " ",
    mutations: [
      { kind: "production", path: "/bad" },
      { kind: "test", path: "../bad.test.ts" },
    ],
  };
  const first = taskShape.validateTaskShape(manyProblems);
  expect(first).toEqual(taskShape.validateTaskShape(manyProblems));
  expect(first.ok).toBe(false);
  if (first.ok === false) {
    expect(first.errors.length).toBeLessThanOrEqual(
      taskShape.TASK_SHAPE_MAX_ERRORS
    );
    expect(first.errors.every((error) => error.length <= 160)).toBe(true);
    expect(first.errors.every((error) => !error.includes("\n"))).toBe(true);
  }
});
