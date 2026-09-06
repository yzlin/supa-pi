import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai/compat";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { parseCorpus } from "./index";
import { runVariant } from "./runner";

const fixturePath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/sample-project"
);
const modelRegistry = new ModelRegistry(await ModelRuntime.create());
const task =
  "Please fix why add(7, 5) returns 2 instead of 12 in this project. Make the smallest focused repair and report what you changed and verified.";
const trustedFixtureRegression = {
  command: "bun test tests/math.case.ts",
  redOutputIdentity:
    "tests/math.case.ts > math > adds numbers\nExpected: 12\nReceived: 2",
};

function message(
  model: Model<Api>,
  content: AssistantMessage["content"]
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: content.some((part) => part.type === "toolCall")
      ? "toolUse"
      : "stop",
    timestamp: Date.now(),
  };
}

function streamMessage(value: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: value });
    stream.push({
      type: "done",
      reason: value.stopReason as "toolUse",
      message: value,
    });
  });
  return stream;
}

function toolCall(
  id: string,
  name: "bash" | "edit" | "structured_output",
  arguments_: Record<string, unknown>
): AssistantMessage["content"] {
  return [{ type: "toolCall", id, name, arguments: arguments_ }];
}

const done = {
  status: "done",
  summary: "Fixed add with the smallest production edit and verified it.",
  filesTouched: ["src/math.ts"],
  validation: [
    "RED: bun test tests/math.case.ts failed with 1 failed, 1 passed.",
    "GREEN: bun test tests/math.case.ts passed with 2 passed, 0 failed.",
    "COVERAGE: add(7, 5) regression path covered by tests/math.case.ts.",
  ],
  followUps: [],
  blockers: [],
};

describe("prompt-eval TDD contract", () => {
  it("parses trusted identity only as closed tddEvidence metadata", () => {
    const corpus = parseCorpus(
      JSON.parse(
        readFileSync(new URL("./corpus.json", import.meta.url), "utf8")
      )
    );
    const readiness = corpus.cases.find(
      (candidate) => candidate.id === "readiness-verification-stop"
    );
    expect(readiness?.task).toBe(task);
    expect(
      readiness?.checks.find(
        (candidateCheck) => candidateCheck.type === "tddEvidence"
      )
    ).toMatchObject({ trustedFixtureRegression });
    expect(
      corpus.cases.filter((candidate) =>
        candidate.checks.some(
          (candidateCheck) =>
            candidateCheck.type === "tddEvidence" &&
            candidateCheck.trustedFixtureRegression !== undefined
        )
      )
    ).toHaveLength(1);

    const malformed = JSON.parse(
      readFileSync(new URL("./corpus.json", import.meta.url), "utf8")
    );
    const malformedCheck = malformed.cases
      .find(
        (candidate: { id: string }) =>
          candidate.id === "readiness-verification-stop"
      )
      .checks.find(
        (candidate: { type: string }) => candidate.type === "tddEvidence"
      );
    malformedCheck.trustedFixtureRegression.forged = true;
    expect(() => parseCorpus(malformed)).toThrow("must contain only");
  });

  it("passes the exact real fixture pipeline with proven denied inspections", async () => {
    const corpus = parseCorpus(
      JSON.parse(
        readFileSync(new URL("./corpus.json", import.meta.url), "utf8")
      )
    );
    const evalCase = corpus.cases.find(
      (candidate) => candidate.id === "readiness-verification-stop"
    );
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!(evalCase && model)) {
      throw new Error("TDD fixture case or test model unavailable");
    }
    const turns = [
      toolCall("denied-before", "bash", {
        command:
          "cat package.json; cat src/*; cat tests/math.case.ts; git status --short",
        executionDeniedBeforeStart: false,
      }),
      toolCall("red", "bash", { command: "bun test tests/math.case.ts" }),
      toolCall("fix", "edit", {
        path: "src/math.ts",
        edits: [
          {
            oldText: "return left - right;",
            newText: "return left + right;",
          },
        ],
      }),
      toolCall("green", "bash", { command: "bun test tests/math.case.ts" }),
      toolCall("denied-after", "bash", {
        command:
          "git diff -- src/math.ts tests/math.case.ts && git status --short",
      }),
      toolCall("done", "structured_output", done),
    ];
    let providerCall = 0;
    const result = await runVariant({
      evalCase,
      variant: "candidate",
      repetition: 1,
      promptContent: "---\nname: tdd-workflow\n---\nRun strict TDD.",
      promptSha256: "contract-test",
      fixturePath,
      model,
      thinking: "medium",
      timeoutMs: 5000,
      maxTurns: turns.length,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        const turn = turns[providerCall++];
        if (!turn) {
          throw new Error("scripted provider exhausted");
        }
        return streamMessage(message(selectedModel, turn));
      },
    });

    expect(result.score.overall).toBe(1);
    expect(result.taskPassed).toBe(true);
    expect(result.testPassed).toBe(true);
    expect(result.metrics.toolErrors).toBe(3);
    expect(result.toolCalls[0]).toMatchObject({
      isError: true,
      executionDeniedBeforeStart: true,
      args: {
        executionDeniedBeforeStart: false,
      },
    });
    expect(result.toolCalls[4]).toMatchObject({
      isError: true,
      executionDeniedBeforeStart: true,
    });
  });

  it("fails closed on trusted fixture drift before model dispatch", async () => {
    const corpus = parseCorpus(
      JSON.parse(
        readFileSync(new URL("./corpus.json", import.meta.url), "utf8")
      )
    );
    const evalCase = structuredClone(
      corpus.cases.find(
        (candidate) => candidate.id === "readiness-verification-stop"
      )!
    );
    const check = evalCase.checks.find(
      (candidate) => candidate.type === "tddEvidence"
    );
    if (check?.type !== "tddEvidence") {
      throw new Error("trusted TDD check unavailable");
    }
    check.trustedFixtureRegression = {
      ...trustedFixtureRegression,
      redOutputIdentity: "drifted identity",
    };
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model unavailable");
    }
    let dispatched = false;
    await expect(
      runVariant({
        evalCase,
        variant: "candidate",
        repetition: 1,
        promptContent: "---\nname: tdd-workflow\n---\nRun strict TDD.",
        promptSha256: "contract-drift-test",
        fixturePath,
        model,
        thinking: "medium",
        timeoutMs: 5000,
        maxTurns: 1,
        getApiKey: () => Promise.resolve("test-key"),
        streamFn: (selectedModel) => {
          dispatched = true;
          return streamMessage(message(selectedModel, []));
        },
      })
    ).rejects.toThrow("trusted fixture regression preflight failed");
    expect(dispatched).toBe(false);
  });
});
