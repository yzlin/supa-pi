// SupaPi additions: offline tests for the Apache-2.0 subagent adaptation; see extensions/subagent/NOTICE and LICENSE.upstream.
import { expect, test } from "bun:test";

import { fauxProvider } from "@earendil-works/pi-ai";

import { parseAgent } from "./agents";
import type { RunnerAPI, RunnerContext } from "./runner";
import { selectSettings } from "./settings";
const provider = fauxProvider({
  provider: "role-provider",
  models: [{ id: "role-model" }, { id: "call-model" }],
});
const model = provider.getModel();
const pi: RunnerAPI = {
  getThinkingLevel: () => "off",
  exec: async () => {
    throw new Error("Preflight must not launch");
  },
};
const ctx: RunnerContext = {
  cwd: "/",
  model: { ...model, provider: "parent-provider", id: "parent-model" },
  scopedModels: [],
  isProjectTrusted: () => false,
  sessionManager: { getSessionId: () => "parent" },
  modelRegistry: {
    find: (p, m) => ({ ...model, provider: p, id: m }),
    hasConfiguredAuth: () => true,
  },
};
test("call settings > definition > parent, inherited slash ids are not reparsed", () => {
  const role = parseAgent(
    "---\nmodel: role-provider/role-model\nthinking: high\n---\nrole",
    "worker.md",
  );
  expect(selectSettings(pi, ctx, { task: "task" })).toEqual({
    provider: "parent-provider",
    model: "parent-model",
    thinking: "off",
  });
  expect(selectSettings(pi, ctx, { task: "task" }, role)).toEqual({
    provider: "role-provider",
    model: "role-model",
    thinking: "high",
  });
  expect(
    selectSettings(
      pi,
      ctx,
      { task: "task", model: "call-provider/call-model", thinking: "low" },
      role,
    ),
  ).toEqual({
    provider: "call-provider",
    model: "call-model",
    thinking: "low",
  });
  expect(
    selectSettings(
      pi,
      ctx,
      { task: "task", provider: "explicit", model: "nested/slash-id" },
      role,
    ),
  ).toEqual({
    provider: "explicit",
    model: "nested/slash-id",
    thinking: "high",
  });
  expect(
    selectSettings(
      pi,
      { ...ctx, model: { ...model, id: "nested/slash-id" } },
      { task: "task" },
    ),
  ).toMatchObject({ provider: "role-provider", model: "nested/slash-id" });
});
