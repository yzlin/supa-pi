import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";

import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { derivePreparedReviewResult } from "./finalization";
import { runReviewPipeline } from "./pipeline";
import { prepareReviewPlan } from "./pipeline-contracts";
import { validatePortableVerifier } from "./portable-core";
import type { SubagentParams } from "./test-fixtures";
import {
  mockChildren,
  outcome,
  plan,
  reviewer,
  verifier,
} from "./test-fixtures";

const options = () => ({ signal: new AbortController().signal });
function schemaRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected schema object.");
  }
  return value as Record<string, unknown>;
}
function assertSchema(value: unknown): void {
  const schema = schemaRecord(value);
  if (typeof schema.type !== "string") {
    throw new Error("Expected schema type.");
  }
  expect([
    "object",
    "array",
    "string",
    "integer",
    "number",
    "boolean",
    "null",
  ]).toContain(schema.type);
  expect(schema).not.toHaveProperty("const");
  if (Array.isArray(schema.enum)) {
    for (const item of schema.enum) {
      expect(String(typeof item)).toBe(schema.type);
    }
  }
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBe(false);
    const properties = schemaRecord(schema.properties);
    expect(schema.required).toEqual(Object.keys(properties));
    for (const item of Object.values(properties)) {
      assertSchema(item);
    }
  }
  if (schema.type === "array") {
    assertSchema(schema.items);
  }
}

describe("deterministic blocking review pipeline", () => {
  it("dispatches reviewers and the grouping verifier through exact native outcomes", async () => {
    const children = mockChildren([reviewer(), reviewer(), verifier()]);
    const raw = await runReviewPipeline(children, plan, options());
    expect(
      children.calls.map(({ agent, model, thinking }) => ({
        agent,
        model,
        thinking,
      })),
    ).toEqual([
      { agent: "code-reviewer", model: "test/alpha", thinking: "medium" },
      { agent: "code-reviewer", model: "test/beta", thinking: "high" },
      { agent: "review-verifier", model: "test/verify", thinking: "medium" },
    ]);
    for (const call of children.calls) {
      assertSchema(call.schema);
    }
    expect(children.calls[0]?.schema).toHaveProperty(
      "properties.reviewer.enum",
      ["code-reviewer"],
    );
    expect(children.calls[0]?.task).toContain(plan.invocationPacket);
    expect(children.calls[2]?.task).toContain("same root cause");
    expect(children.calls[2]?.task).toContain("Code evidence is mandatory");
    const result = derivePreparedReviewResult(plan, JSON.stringify(raw));
    expect(result.verifier.findings[0]?.supportingModels).toEqual([
      "test/alpha",
      "test/beta",
    ]);
    expect(raw.verifierOutput).toEqual(verifier());
  });

  it("caps batches at four and retains dispatch order after reverse completion", async () => {
    const input = {
      ...plan,
      reviewers: [
        "code-reviewer",
        "security-reviewer",
        "database-reviewer",
      ] as const,
    };
    const jobs = input.reviewers.flatMap((role) =>
      input.reviewerPanel.map((entry) => ({ role, ...entry })),
    );
    let active = 0;
    let maximum = 0;
    const completed: number[] = [];
    let barrier = 0;
    const children = mockChildren(
      jobs.map(({ role }) => reviewer(role, [])),
      async (_params, index) => {
        if (index === 4) {
          barrier = completed.length;
        }
        active += 1;
        maximum = Math.max(maximum, active);
        await Bun.sleep(index % 4 === 0 ? 15 : 1);
        active -= 1;
        completed.push(index);
      },
    );
    const raw = await runReviewPipeline(children, input, options());
    expect(maximum).toBe(4);
    expect(barrier).toBe(4);
    expect(completed[0]).not.toBe(0);
    expect(
      raw.reviewerRuns.map(({ reviewer: role, model }) => ({ role, model })),
    ).toEqual(jobs.map(({ role, model }) => ({ role, model })));
    expect(children.calls).toHaveLength(6);
  });

  it("empty candidates skip the verifier", async () => {
    const children = mockChildren([
      reviewer("code-reviewer", []),
      reviewer("code-reviewer", []),
    ]);
    const raw = await runReviewPipeline(children, plan, options());
    expect(children.calls).toHaveLength(2);
    expect(raw).not.toHaveProperty("verifierOutput");
    expect(
      derivePreparedReviewResult(plan, JSON.stringify(raw)).verifier.verdict,
    ).toBe("correct");
  });

  it("native isError and invalid reviewer semantics degrade only with role coverage", async () => {
    for (const failed of [
      new Error("provider secret"),
      reviewer("security-reviewer", []),
    ]) {
      const children = mockChildren([failed, reviewer("code-reviewer", [])]);
      const raw = await runReviewPipeline(children, plan, options());
      expect(
        derivePreparedReviewResult(plan, JSON.stringify(raw)).coverage.degraded,
      ).toBe(true);
      expect(JSON.stringify(raw)).not.toContain("provider secret");
    }
    const children = mockChildren([new Error("first"), new Error("second")]);
    expect(runReviewPipeline(children, plan, options())).rejects.toThrow(
      "successful model run",
    );
    expect(children.calls).toHaveLength(2);
  });

  it.each(["minimal", "low", "medium", "high", "xhigh"] as const)(
    "preserves %s thinking",
    async (thinkingLevel) => {
      const children = mockChildren([reviewer("code-reviewer", [])]);
      await runReviewPipeline(
        children,
        { ...plan, reviewerPanel: [{ model: "test/alpha", thinkingLevel }] },
        options(),
      );
      expect(children.calls[0]?.thinking).toBe(thinkingLevel);
    },
  );
  it("rejects off and duplicate panel models before dispatch", () => {
    expect(() =>
      prepareReviewPlan({
        ...plan,
        reviewerPanel: [{ model: "test/alpha", thinkingLevel: "off" }],
      }),
    ).toThrow("choose minimal, low, medium, high, or xhigh");
    expect(() =>
      prepareReviewPlan({
        ...plan,
        reviewerPanel: [plan.reviewerPanel[0]!, plan.reviewerPanel[0]!],
      }),
    ).toThrow("unique");
  });

  const metadataFaults: Array<Record<string, JsonValue>> = [
    { agent: "security-reviewer" },
    { provider: "wrong" },
    { model: "wrong" },
    { thinking: "low" },
    { runId: "wf_old" },
    { resultPath: "relative" },
    { structuredOutput: null },
    { report: "forged" },
  ];
  it.each(metadataFaults)(
    "rejects wrong metadata or payload %j even with another successful model",
    async (overrides) => {
      let count = 0;
      const executeTool = async (
        _name: string,
        args: unknown,
      ): Promise<AgentToolCallOutcome> => {
        const params = args as SubagentParams;
        return outcome(
          params,
          reviewer("code-reviewer", []),
          count++ === 0 ? overrides : {},
        );
      };
      expect(
        runReviewPipeline({ executeTool }, plan, options()),
      ).rejects.toThrow();
      expect(count).toBe(2);
    },
  );
  it("rejects reused child run IDs", async () => {
    const id = randomUUID();
    const executeTool = async (_name: string, args: unknown) =>
      outcome(args as SubagentParams, reviewer("code-reviewer", []), {
        runId: id,
      });
    expect(
      runReviewPipeline({ executeTool }, plan, options()),
    ).rejects.toThrow();
  });
  it("never parses prose when structuredContent is missing", async () => {
    const executeTool = async (_name: string, args: unknown) => {
      const result = outcome(
        args as SubagentParams,
        reviewer("code-reviewer", []),
      );
      delete result.result.structuredContent;
      result.result.content = [
        { type: "text", text: JSON.stringify(reviewer("code-reviewer", [])) },
      ];
      return result;
    };
    expect(
      runReviewPipeline({ executeTool }, plan, options()),
    ).rejects.toThrow();
  });

  it.each([
    verifier(["invented"]),
    verifier(["candidate-0001", "candidate-0001"]),
    verifier([]),
    verifier(["candidate-0001"]),
    verifier(["candidate-0001"], [{ id: "candidate-0001", reason: "dup" }]),
    verifier(["candidate-0001"], [{ id: "candidate-0002", reason: " " }]),
    { ...verifier(), rejected: undefined },
    new Error("provider error"),
  ])(
    "fails invalid or lossy verification without local repair",
    async (bad) => {
      const children = mockChildren([reviewer(), reviewer(), bad]);
      expect(runReviewPipeline(children, plan, options())).rejects.toThrow();
      expect(children.calls).toHaveLength(3);
    },
  );

  it("abort stops the current group and prevents subsequent batches", async () => {
    const controller = new AbortController();
    const input = {
      ...plan,
      reviewers: [
        "code-reviewer",
        "security-reviewer",
        "database-reviewer",
      ] as const,
    };
    const children = mockChildren(
      Array.from({ length: 6 }, () => reviewer("code-reviewer", [])),
      async (_params, index, signal) => {
        if (index === 3) {
          controller.abort();
        }
        if (!signal?.aborted) {
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
      },
    );
    expect(
      runReviewPipeline(children, input, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(children.calls).toHaveLength(4);
  });
  it("already aborted signals dispatch nothing", async () => {
    const children = mockChildren([]);
    expect(
      runReviewPipeline(children, plan, { signal: AbortSignal.abort() }),
    ).rejects.toThrow("cancelled");
    expect(children.calls).toEqual([]);
  });
});

it("fatal metadata invalidation aborts and settles other children in the owned batch", async () => {
  const signals: AbortSignal[] = [];
  let settled = 0;
  const executeTool: ExtensionToolContext["executeTool"] = async (
    _name,
    args,
    nativeOptions,
  ) => {
    const params = args as SubagentParams;
    signals.push(nativeOptions!.signal!);
    if (params.model === "test/alpha") {
      return outcome(params, reviewer("code-reviewer", []), {
        model: "forged",
      });
    }
    await new Promise<void>((resolve) => {
      nativeOptions?.signal?.addEventListener(
        "abort",
        () => {
          settled += 1;
          resolve();
        },
        { once: true },
      );
    });
    return outcome(params, reviewer("code-reviewer", []));
  };
  expect(runReviewPipeline({ executeTool }, plan, options())).rejects.toThrow();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(settled).toBe(1);
});

it("accepts explicit verifier rejections that account for every candidate", async () => {
  const children = mockChildren([
    reviewer(),
    reviewer(),
    {
      reviewScope: ["target snapshot"],
      verdict: "correct",
      findings: [],
      rejected: [
        { id: "candidate-0001", reason: "Line 1 has no guard." },
        { id: "candidate-0002", reason: "Same claim; no guard exists." },
      ],
    },
  ]);
  const raw = await runReviewPipeline(children, plan, options());
  expect(
    derivePreparedReviewResult(plan, JSON.stringify(raw)).verifier.verdict,
  ).toBe("correct");
  expect(children.calls[2]?.task).toContain(
    "Account for every candidate ID exactly once",
  );
});

it("one missing required role fails even when other roles have successful models", async () => {
  const children = mockChildren([
    reviewer("code-reviewer", []),
    reviewer("code-reviewer", []),
    new Error("model failed"),
    new Error("model failed"),
  ]);
  expect(
    runReviewPipeline(
      children,
      { ...plan, reviewers: ["code-reviewer", "security-reviewer"] },
      options(),
    ),
  ).rejects.toThrow("successful model run");
  expect(children.calls).toHaveLength(4);
});

it("bounds complete structured payloads before semantic processing", async () => {
  const executeTool: ExtensionToolContext["executeTool"] = async (
    _name,
    args,
  ) => outcome(args as SubagentParams, { notes: ["x".repeat(1_048_577)] });
  expect(runReviewPipeline({ executeTool }, plan, options())).rejects.toThrow();
});

it("verifier sketches accept flow and diff only and fail closed otherwise", () => {
  const candidates = [{ candidateId: "candidate-0001", model: "test/alpha" }];
  const withSketches = (sketches: unknown) => {
    const output = verifier(["candidate-0001"]);
    return { ...output, findings: [{ ...output.findings[0], sketches }] };
  };
  expect(
    validatePortableVerifier(
      withSketches([
        { kind: "flow", text: "a ─▶ b" },
        { kind: "diff", text: "+ fix" },
      ]),
      candidates,
    ).ok,
  ).toBe(true);
  for (const sketches of [
    [{ kind: "excerpt", text: "code" }],
    [{ kind: "flow", text: "  " }],
    [{ kind: "flow", text: "a", extra: true }],
    [
      { kind: "flow", text: "a" },
      { kind: "diff", text: "b" },
      { kind: "flow", text: "c" },
    ],
    undefined,
  ]) {
    expect(
      validatePortableVerifier(withSketches(sketches), candidates),
    ).toEqual({
      ok: false,
      error: "Verifier finding has invalid typed fields.",
    });
  }
});
