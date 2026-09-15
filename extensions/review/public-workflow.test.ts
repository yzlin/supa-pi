import { describe, expect, it } from "bun:test";

import { derivePreparedReviewResult } from "./finalization";
import {
  createPublicWorkflowSmokeScript,
  type PublicReviewWorkflowInput,
  type PublicReviewWorkflowScriptResult,
  prepareReviewWorkflowScript,
} from "./public-workflow";

const REVIEWER = "code-reviewer" as const;
const PANEL = [
  { model: "test/alpha", thinkingLevel: "medium" as const },
  { model: "test/beta", thinkingLevel: "high" as const },
];
const SCRIPT_META_RE = /^export const meta = \{[\s\S]*?^\};\s*/m;
const RUNTIME_EXPORT_RE = /^export\b/m;
const VERIFIER_ID_ERROR_RE = /unknown member ID|repeated member ID/;

function input(
  overrides: Partial<PublicReviewWorkflowInput> = {}
): PublicReviewWorkflowInput {
  return {
    scopeHint: "changed files",
    invocationPacket: "Review the supplied test packet.",
    reviewers: [REVIEWER],
    reviewerPanel: PANEL,
    synthesizerModel: "test/synthesizer",
    verifierModel: "test/verifier",
    ...overrides,
  };
}

function finding(file = "src/example.ts", line = 7) {
  return {
    priority: "P1",
    title: "Unsafe default",
    file,
    line,
    why: "The default permits an invalid state.",
    change: "Reject the invalid state before use.",
  };
}

function reviewerOutput(reviewer = REVIEWER, findings = [finding()]) {
  return {
    reviewer,
    verdict: findings.length ? "needs attention" : "correct",
    findings,
    humanReviewerCallouts: [],
  };
}

function cluster(memberIds: string[]) {
  return {
    clusters: [
      {
        memberIds,
        title: "Unsafe default",
        why: "The default permits an invalid state.",
        change: "Reject the invalid state before use.",
      },
    ],
  };
}

function verifier(memberIds: string[]) {
  return {
    reviewScope: ["changed files"],
    verdict: "needs attention",
    findings: [
      {
        memberIds,
        priority: "P1",
        title: "Unsafe default",
        why: "The default permits an invalid state.",
        change: "Reject the invalid state before use.",
        confidence: "high",
        reason: "The changed code accepts the invalid default.",
        consensusEffect: memberIds.length > 1 ? "raised-one-level" : "none",
      },
    ],
  };
}

function stripScriptMeta(script: string): string {
  const meta = script.match(SCRIPT_META_RE);
  if (!meta) {
    throw new Error("Workflow script must begin with a literal meta export.");
  }
  const body = script.slice(meta[0].length);
  if (RUNTIME_EXPORT_RE.test(body)) {
    throw new Error("Workflow script must not contain runtime exports.");
  }
  return body;
}

function executeScript(
  script: string,
  replies: Array<unknown | Error>,
  options: {
    throwOnParallel?: boolean;
    throwOnAgent?: boolean;
    onAgent?: (
      options: Record<string, unknown>,
      index: number
    ) => void | Promise<void>;
  } = {}
) {
  const body = stripScriptMeta(script);
  const AsyncFunction = Object.getPrototypeOf(async () => {
    // Use the async-function constructor without invoking a model.
  }).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<unknown>;
  let callIndex = 0;
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const agent = (prompt: string, agentOptions: Record<string, unknown>) => {
    if (options.throwOnAgent) {
      throw new Error("agent must not be called");
    }
    calls.push({ prompt, options: agentOptions });
    const index = callIndex++;
    const reply = replies[index];
    if (reply instanceof Error) {
      throw reply;
    }
    return Promise.resolve(options.onAgent?.(agentOptions, index)).then(
      () => reply ?? null
    );
  };
  const parallel = (thunks: Array<() => Promise<unknown>>) => {
    if (options.throwOnParallel) {
      throw new Error("parallel must not be called");
    }
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch {
          return null;
        }
      })
    );
  };
  const phase = () => undefined;
  const log = () => undefined;
  const run = new AsyncFunction("agent", "parallel", "phase", "log", body);
  return run(agent, parallel, phase, log);
}

function assertProviderSchema(schema: Record<string, any>): void {
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
  if (schema.enum) {
    for (const value of schema.enum) {
      expect(typeof value).toBe(schema.type);
    }
  }
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(
      Object.keys(schema.properties).sort()
    );
    for (const property of Object.values(schema.properties)) {
      assertProviderSchema(property as Record<string, unknown>);
    }
  }
  if (schema.type === "array") {
    assertProviderSchema(schema.items);
  }
}

describe("public review workflow script", () => {
  it("supplies recursively typed, closed provider-compatible schemas for every stage", async () => {
    const stages: unknown[] = [];
    const schemas: Record<string, any>[] = [];
    await executeScript(
      prepareReviewWorkflowScript(input()),
      [
        reviewerOutput(),
        reviewerOutput(),
        cluster(["candidate-0001", "candidate-0002"]),
        verifier(["candidate-0001", "candidate-0002"]),
      ],
      {
        onAgent: (options) => {
          stages.push(options.agentType);
          schemas.push(options.schema as Record<string, any>);
        },
      }
    );
    expect(stages).toEqual([
      REVIEWER,
      REVIEWER,
      "review-synthesizer",
      "review-verifier",
    ]);
    for (const schema of schemas) {
      assertProviderSchema(schema);
    }
    expect(schemas[0]).toHaveProperty("properties.reviewer.enum", [REVIEWER]);
  });

  it("bounds reviewer concurrency at four with ordered dispatch and results across batch barriers", async () => {
    const plan = input({
      reviewers: [REVIEWER, "security-reviewer", "database-reviewer"],
    });
    const jobs = plan.reviewers.flatMap((reviewer) =>
      PANEL.map((entry) => ({ reviewer, ...entry }))
    );
    const outputs = jobs.map((job, index) => ({
      ...reviewerOutput(REVIEWER, []),
      reviewer: job.reviewer,
      notes: [String(index)],
    }));
    const dispatched: unknown[] = [];
    const completed: number[] = [];
    let active = 0;
    let maxActive = 0;
    let completedAtSecondBatch = 0;
    const result = (await executeScript(
      prepareReviewWorkflowScript(plan),
      outputs,
      {
        onAgent: async (options, index) => {
          dispatched.push({
            reviewer: options.agentType,
            model: options.model,
            thinkingLevel: options.effort,
          });
          if (index === 4) {
            completedAtSecondBatch = completed.length;
          }
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) =>
            setTimeout(resolve, index % 4 === 0 ? 20 : 1)
          );
          active -= 1;
          completed.push(index);
        },
      }
    )) as PublicReviewWorkflowScriptResult;
    expect(maxActive).toBe(4);
    expect(completedAtSecondBatch).toBe(4);
    expect(dispatched).toEqual(jobs);
    expect(completed[0]).not.toBe(0);
    expect(result.status).toBe("succeeded");
    expect(result.reviewerOutputs).toEqual(outputs);
    expect(result.rawResult.reviewerRuns).toEqual(
      jobs.map((job, index) => ({
        ...job,
        status: "succeeded",
        output: outputs[index],
      }))
    );
  });

  it("rejects off during preparation with an actionable supported-level explanation", () => {
    expect(() =>
      prepareReviewWorkflowScript(
        input({
          reviewerPanel: [{ model: "test/alpha", thinkingLevel: "off" }],
        })
      )
    ).toThrow("choose minimal, low, medium, high, or xhigh");
  });

  it.each([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ] as const)("preserves requested %s effort", async (thinkingLevel) => {
    const efforts: unknown[] = [];
    await executeScript(
      prepareReviewWorkflowScript(
        input({ reviewerPanel: [{ model: "test/alpha", thinkingLevel }] })
      ),
      [reviewerOutput(REVIEWER, [])],
      {
        onAgent: (options) => {
          efforts.push(options.effort);
        },
      }
    );
    expect(efforts).toEqual([thinkingLevel]);
  });

  it("retains complete raw stage outputs for local revalidation", async () => {
    const rawSynthesizer = cluster(["candidate-0001", "candidate-0002"]);
    const rawVerifier = verifier(["candidate-0001", "candidate-0002"]);
    const result = (await executeScript(prepareReviewWorkflowScript(input()), [
      reviewerOutput(),
      reviewerOutput(),
      rawSynthesizer,
      rawVerifier,
    ])) as { rawResult: unknown };
    expect(result.rawResult).toEqual({
      reviewerRuns: PANEL.map((entry) => ({
        reviewer: REVIEWER,
        ...entry,
        status: "succeeded",
        output: reviewerOutput(),
      })),
      synthesizerOutput: rawSynthesizer,
      verifierOutput: rawVerifier,
    });
    const derived = derivePreparedReviewResult(
      input(),
      JSON.stringify(result.rawResult)
    );
    expect(derived.verifier.findings[0]?.supportCount).toBe(2);
  });

  it("retains invalid raw stage data but never provider exception text", async () => {
    const result = (await executeScript(prepareReviewWorkflowScript(input()), [
      new Error("provider credential secret"),
      reviewerOutput(),
      { clusters: [] },
    ])) as { status: string; rawResult: unknown };
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.rawResult)).not.toContain("credential");
    expect(() =>
      derivePreparedReviewResult(input(), JSON.stringify(result.rawResult))
    ).toThrow("Invalid synthesizer output");
  });

  it("runs a clean review and skips synthesizer and verifier", async () => {
    const result = (await executeScript(prepareReviewWorkflowScript(input()), [
      reviewerOutput(REVIEWER, []),
      reviewerOutput(REVIEWER, []),
    ])) as { status: string; candidates: unknown[]; clusters: unknown[] };

    expect(result.status).toBe("succeeded");
    expect(result.candidates).toEqual([]);
    expect(result.clusters).toEqual([]);
  });

  it("runs finding review with deterministic IDs and provenance", async () => {
    const result = (await executeScript(prepareReviewWorkflowScript(input()), [
      reviewerOutput(),
      reviewerOutput(REVIEWER, [finding("src/other.ts", 11)]),
      cluster(["candidate-0001", "candidate-0002"]),
      verifier(["candidate-0001", "candidate-0002"]),
    ])) as {
      status: string;
      candidates: Array<{ candidateId: string }>;
      verifier: {
        findings: Array<{ supportCount: number; supportingModels: string[] }>;
      };
    };

    expect(result.status).toBe("succeeded");
    expect(result.candidates.map((candidate) => candidate.candidateId)).toEqual(
      ["candidate-0001", "candidate-0002"]
    );
    expect(result.verifier.findings[0]?.supportCount).toBe(2);
    expect(result.verifier.findings[0]?.supportingModels).toEqual([
      "test/alpha",
      "test/beta",
    ]);
  });

  it("keeps degraded coverage while requiring one success per role", async () => {
    const result = (await executeScript(prepareReviewWorkflowScript(input()), [
      new Error("first model failed"),
      reviewerOutput(),
      cluster(["candidate-0001"]),
      verifier(["candidate-0001"]),
    ])) as { status: string; coverage: { degraded: boolean } };

    expect(result.status).toBe("succeeded");
    expect(result.coverage.degraded).toBe(true);
  });

  it.each([
    ["lossy", { clusters: [] }, "omitted candidate IDs"],
    ["unknown", cluster(["candidate-9999"]), "unknown candidate ID"],
    [
      "duplicate",
      {
        clusters: [
          cluster(["candidate-0001"]).clusters[0],
          cluster(["candidate-0001"]).clusters[0],
        ],
      },
      "repeated candidate ID",
    ],
  ])("rejects %s synthesizer IDs without a local repair", async (_name, badClusters, reason) => {
    const result = (await executeScript(prepareReviewWorkflowScript(input()), [
      reviewerOutput(),
      reviewerOutput(REVIEWER, []),
      badClusters,
    ])) as { status: string; reason: string };

    expect(result.status).toBe("failed");
    expect(result.reason).toContain(reason);
  });

  it("rejects unknown and duplicate verifier IDs without another model call", async () => {
    for (const badVerifier of [
      verifier(["candidate-9999"]),
      {
        ...verifier(["candidate-0001"]),
        findings: [
          verifier(["candidate-0001"]).findings[0],
          verifier(["candidate-0001"]).findings[0],
        ],
      },
    ]) {
      const result = (await executeScript(
        prepareReviewWorkflowScript(input()),
        [
          reviewerOutput(),
          reviewerOutput(REVIEWER, []),
          cluster(["candidate-0001"]),
          badVerifier,
        ]
      )) as { status: string; reason: string };
      expect(result.status).toBe("failed");
      expect(result.reason).toMatch(VERIFIER_ID_ERROR_RE);
    }
  });

  it("emits a read-only zero-agent public sandbox smoke fixture", async () => {
    const result = await executeScript(createPublicWorkflowSmokeScript(), [], {
      throwOnAgent: true,
      throwOnParallel: true,
    });
    expect(result).toEqual({
      sandbox: "review-public-workflow",
      agentAvailable: true,
      parallelAvailable: true,
      agentCalls: 0,
      reviewerValid: true,
      invalidReviewerRejected: true,
      candidates: [
        {
          ...finding(),
          candidateId: "candidate-0001",
          reviewer: REVIEWER,
          model: "test/alpha",
          thinkingLevel: "medium",
        },
        {
          ...finding(),
          candidateId: "candidate-0002",
          reviewer: REVIEWER,
          model: "test/beta",
          thinkingLevel: "high",
        },
      ],
    });
  });
});
