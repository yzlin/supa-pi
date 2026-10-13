// SupaPi additions: offline tests for the Apache-2.0 subagent adaptation; see extensions/subagent/NOTICE and LICENSE.upstream.
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readChildConfig,
  schemaHash,
  validateResult,
  validateSchema,
  validateStructured,
  type ChildConfig,
} from "./protocol";
const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};
const config: ChildConfig = {
  version: 1,
  runId: "run",
  parentSessionId: "parent",
  cwd: "/workspace",
  provider: "faux",
  model: "faux-1",
  thinking: "off",
  trusted: false,
  schema,
  schemaHash: schemaHash(schema),
};
const report = {
  version: 1,
  runId: "run",
  parentSessionId: "parent",
  provider: "faux",
  model: "faux-1",
  thinking: "off",
  schemaHash: config.schemaHash,
  status: "completed",
  output: "text",
  structuredOutput: { ok: true },
  finishedAt: 1,
};
test("child config keeps absolute provider extensions and rejects relative ones", async () => {
  const file = path.join(
    await mkdtemp(path.join(tmpdir(), "supa-subagent-protocol-")),
    "config.json",
  );
  await writeFile(
    file,
    JSON.stringify({ ...config, providerExtensions: ["/abs/bridge"] }),
  );
  expect((await readChildConfig(file)).providerExtensions).toEqual([
    "/abs/bridge",
  ]);
  await writeFile(
    file,
    JSON.stringify({ ...config, providerExtensions: ["bridge"] }),
  );
  await rejects(readChildConfig(file), /provider extensions/);
});
test("malformed and mismatched evidence rejected; parent independently revalidates structure", () => {
  expect(validateResult(report, config).structuredOutput).toEqual({ ok: true });
  for (const changed of [
    { runId: "other" },
    { parentSessionId: "other" },
    { provider: "other" },
    { model: "other" },
    { thinking: "high" },
    { schemaHash: "other" },
    { agent: "other" },
    { version: 2 },
    { status: "pending" },
    { structuredOutput: { ok: "bad" } },
    { structuredOutput: undefined },
  ]) {
    expect(() => validateResult({ ...report, ...changed }, config)).toThrow();
  }
  expect(() => validateStructured(schema, { ok: true, extra: 1 })).toThrow();
});
test("schema preflight rejects ignored/malformed keywords and references, not data named type", () => {
  for (const invalid of [
    { type: "object", requred: ["ok"] },
    { type: "object", required: "ok" },
    { type: "object", properties: [] },
    { type: "object", properties: { x: { $ref: "https://network.invalid" } } },
  ]) {
    expect(() => validateSchema(invalid)).toThrow();
  }
  expect(() =>
    validateSchema({
      type: "object",
      properties: { item: { enum: [{ type: "arbitrary-data" }] } },
    }),
  ).not.toThrow();
});
