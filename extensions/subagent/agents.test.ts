// SupaPi additions: offline tests for the Apache-2.0 subagent adaptation; see extensions/subagent/NOTICE and LICENSE.upstream.
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgent, parseAgent, resolveAgentResources } from "./agents";

const role = (name: string, extra = "") =>
  `---\nname: ${name}\n${extra}\n---\nRole instructions`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "supa-subagent-discovery-"));
  const cwd = join(root, "workspace");
  const global = join(root, "global");
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await mkdir(global);
  return { root, cwd, global, project: join(cwd, ".pi", "agents") };
}
test("strict role controls and basename fallback", () => {
  expect(
    parseAgent(role("worker", "tools: *"), "worker.md").tools,
  ).toBeUndefined();
  expect(
    parseAgent(
      "---\ntools: none\nextensions: false\nskills: false\ncaveman: true\n---\nSystem body",
      "synth.md",
    ),
  ).toMatchObject({
    name: "synth",
    tools: [],
    extensions: false,
    skills: false,
    caveman: true,
    body: "System body",
  });
  for (const extra of [
    "tools: read,,write",
    "tools: [read, 3]",
    "model: [a, b]",
    "thinking: huge",
    "extensions: maybe",
    "skills: [true]",
    "caveman: yes",
  ]) {
    expect(() => parseAgent(role("worker", extra), "worker.md")).toThrow();
  }
});
test("trusted project name shadows global; untrusted, invalid and ambiguous never fall back", async () => {
  const f = await fixture();
  await writeFile(join(f.global, "worker.md"), role("worker", "thinking: low"));
  await writeFile(
    join(f.project, "local.md"),
    role("worker", "thinking: high"),
  );
  expect(await loadAgent("worker", f.cwd, f.global, true)).toMatchObject({
    thinking: "high",
    source: "project",
  });
  await rejects(loadAgent("worker", f.cwd, f.global, false), /trust/);
  await writeFile(join(f.project, "worker.md"), role("worker", "tools: [42]"));
  await rejects(loadAgent("worker", f.cwd, f.global, true));
  await rejects(loadAgent("../worker", f.cwd, f.global, true));
  await rejects(loadAgent("missing", f.cwd, f.global, true), /Unknown/);
});
test("normalized project name shadows a less restricted global for trusted parents", async () => {
  const f = await fixture();
  await writeFile(join(f.global, "worker.md"), role("worker"));
  await writeFile(
    join(f.project, "worker.md"),
    role('" worker "', "tools: none"),
  );
  expect(await loadAgent("worker", f.cwd, f.global, true)).toMatchObject({
    name: "worker",
    tools: [],
    source: "project",
  });
});

test.each(['""', '"   "'])(
  "empty advertised project name %s blocks less restricted global fallback",
  async (name) => {
    const f = await fixture();
    await writeFile(join(f.global, "worker.md"), role("worker"));
    await writeFile(join(f.project, "worker.md"), role(name, "tools: none"));
    for (const trusted of [true, false]) {
      await rejects(
        loadAgent("worker", f.cwd, f.global, trusted),
        /Blocked role discovery: .*Invalid name/,
      );
    }
  },
);

test("normalized project name blocks global fallback for untrusted parents", async () => {
  const f = await fixture();
  await writeFile(join(f.global, "worker.md"), role("worker"));
  await writeFile(
    join(f.project, "worker.md"),
    role('" worker "', "tools: none"),
  );
  await rejects(loadAgent("worker", f.cwd, f.global, false), /trust/);
});

test("normalized project names with invalid controls fail closed", async () => {
  const f = await fixture();
  await writeFile(join(f.global, "worker.md"), role("worker"));
  for (const controls of ["tools: [42]", "thinking: huge"]) {
    await writeFile(join(f.project, "alias.md"), role('" worker "', controls));
    await rejects(
      loadAgent("worker", f.cwd, f.global, true),
      /Blocked agent worker: Invalid/,
    );
    await rejects(loadAgent("worker", f.cwd, f.global, false), /trust/);
  }
});

test.each(["project", "global"] as const)(
  "normalized duplicate aliases in %s are ambiguous",
  async (source) => {
    const f = await fixture();
    await writeFile(join(f.global, "worker.md"), role("worker"));
    await writeFile(
      join(f[source], "worker.md"),
      role("worker", "tools: none"),
    );
    await writeFile(
      join(f[source], "alias.md"),
      role('" worker "', "tools: none"),
    );
    await rejects(
      loadAgent("worker", f.cwd, f.global, true),
      /Ambiguous agent: worker/,
    );
  },
);

test("project escape blocked, setup-style global symlink allowed", async () => {
  const f = await fixture();
  const repoRole = join(f.root, "worker.md");
  await writeFile(repoRole, role("worker"));
  await symlink(repoRole, join(f.global, "worker.md"));
  expect(await loadAgent("worker", f.cwd, f.global, true)).toMatchObject({
    name: "worker",
    source: "global",
  });
  await symlink(repoRole, join(f.project, "worker.md"));
  await rejects(loadAgent("worker", f.cwd, f.global, true), /escape/);
});

test("unindexable escaped role cannot bypass project precedence via an alias filename", async () => {
  const f = await fixture();
  await writeFile(join(f.global, "worker.md"), role("worker"));
  await symlink(join(f.global, "worker.md"), join(f.project, "alias.md"));
  await rejects(loadAgent("worker", f.cwd, f.global, true), /escape/);
});

test("project role resource paths cannot escape through traversal or symlinks", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside.ts");
  await writeFile(outside, "export default () => {};");
  await symlink(outside, join(f.project, "escape.ts"));
  const agent = parseAgent(
    role("worker", "extensions: [escape.ts]"),
    join(f.project, "worker.md"),
  );
  await rejects(
    resolveAgentResources({ ...agent, source: "project" }, f.cwd),
    /escape/,
  );
});
